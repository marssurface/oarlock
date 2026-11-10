import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppConfig, EnabledModel, ProviderKind, SettingsPatch } from '../config.ts'
import {
  describeConfig,
  disableModel,
  enableModel,
  loadDotEnv,
  providerDefaults,
  PROVIDER_KINDS,
  readEnabledModels,
  readKeys,
  resolveConfig,
  writeKey,
  writeSettings,
} from '../config.ts'
import { autoApproval, denyApproval, ruleApproval } from '../core/approval.ts'
import { promptAsk } from '../core/ask.ts'
import { checkpointForUserMessage, checkpointManager } from '../core/checkpoint.ts'
import type { AgentEvent } from '../core/events.ts'
import { parsePricing } from '../core/pricing.ts'
import { permissionRules } from '../core/rules.ts'
import { createRuntime } from '../core/setup.ts'
import type { Runtime } from '../core/setup.ts'
import { loadMcpServers } from '../mcp/index.ts'
import type { ImagePart } from '../providers/types.ts'
import { SessionStore } from '../session/store.ts'
import type { Session } from '../session/store.ts'
import { summarizeTrace } from '../session/store.ts'
import type { ApprovalDecision, ApprovalGate, AskAnswer, AskGate, ToolDefinition } from '../tools/types.ts'
import { VENDOR_PRESETS } from './presets.ts'

interface WebSession {
  session: Session
  runtime: Runtime
  running: boolean
  /** Settings changed mid-turn; rebuild the runtime once the turn ends. */
  stale: boolean
  abort: AbortController | undefined
  sink: ((event: AgentEvent) => void) | undefined
  pending: Map<string, (decision: ApprovalDecision) => void>
  gate: ApprovalGate
  pendingAsks: Map<string, (answer: AskAnswer) => void>
  askGate: AskGate
}

export interface AgentServer {
  server: Server
  sessions: Map<string, WebSession>
  store: SessionStore
}

const UI_FILE = new URL('./public/index.html', import.meta.url)

const MAX_BODY_BYTES = 24 * 1024 * 1024
const MAX_IMAGES = 4
/** Decoded bytes per image; base64 on the wire is ~4/3 of this. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Validate the `images` field: `{ mimeType, data }` with raw base64 `data`. */
function parseImages(raw: unknown): ImagePart[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new HttpError(400, 'images must be an array')
  if (raw.length > MAX_IMAGES) throw new HttpError(400, `a message can carry at most ${MAX_IMAGES} images`)
  const images: ImagePart[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(400, 'each image must be an object with mimeType and data')
    }
    const record = item as Record<string, unknown>
    const mimeType = typeof record['mimeType'] === 'string' ? record['mimeType'].trim().toLowerCase() : ''
    if (!IMAGE_MIMES.has(mimeType)) {
      throw new HttpError(400, `unsupported image type: ${mimeType === '' ? '(empty)' : mimeType}`)
    }
    const rawData = typeof record['data'] === 'string' ? record['data'].trim() : ''
    // Accept a full data URL too: the browser's FileReader produces one.
    const data = rawData.startsWith('data:') ? rawData.slice(rawData.indexOf(',') + 1) : rawData
    if (data === '' || !BASE64.test(data) || data.length % 4 !== 0) {
      throw new HttpError(400, 'image data must be base64')
    }
    const bytes = Buffer.from(data, 'base64').length
    if (bytes === 0) throw new HttpError(400, 'image data is empty')
    if (bytes > MAX_IMAGE_BYTES) {
      throw new HttpError(400, `image is too large (${Math.round(bytes / 1024)}KB, limit ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`)
    }
    images.push({ type: 'image', mimeType, data })
  }
  return images
}

function imageSupport(config: AppConfig): boolean {
  const active = readEnabledModels(config.cwd).find(
    (entry) => entry.baseUrl === config.baseUrl && entry.model === config.model,
  )
  // No explicit metadata means "try it": most OpenAI-compatible gateways accept images.
  return active?.input === undefined || active.input.includes('image')
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function modelIds(payload: unknown): string[] {
  const record = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
  const list = Array.isArray(payload)
    ? payload
    : record !== null && Array.isArray(record['data'])
      ? record['data']
      : record !== null && Array.isArray(record['models'])
        ? record['models']
        : []
  const ids: string[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      if (item !== '') ids.push(item)
    } else if (item !== null && typeof item === 'object') {
      const entry = item as Record<string, unknown>
      const id = entry['id'] ?? entry['name'] ?? entry['model']
      if (typeof id === 'string' && id !== '') ids.push(id)
    }
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

async function fetchModelIds(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey !== undefined && apiKey !== '') headers['authorization'] = `Bearer ${apiKey}`
  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(10_000) })
  } catch (error) {
    const timedOut = (error as Error).name === 'TimeoutError'
    throw new Error(timedOut ? '获取模型列表超时（10s）' : `无法连接 ${baseUrl}：${(error as Error).message}`)
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）：${text.slice(0, 160)}`)
  try {
    return modelIds(JSON.parse(text))
  } catch {
    throw new Error('模型列表不是合法 JSON')
  }
}

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'body must be valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export interface AgentServerOptions {
  /** Extra tools (e.g. MCP) available to every session's runtime. */
  extraTools?: ToolDefinition[]
}

export function createAgentServer(initialConfig: AppConfig, options: AgentServerOptions = {}): AgentServer {
  let config = initialConfig
  const store = new SessionStore(config.sessionsDir)
  const sessions = new Map<string, WebSession>()

  /** Global model config: one switch applies to every session. */
  const configPayload = (): Record<string, unknown> => ({
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    hasKey: config.apiKey !== undefined,
    summary: describeConfig(config),
  })

  const buildRuntime = (state: WebSession): Runtime =>
    createRuntime(config, state.session, {
      approval: state.gate,
      ask: state.askGate,
      onEvent: (event) => state.sink?.(event),
      ...(options.extraTools !== undefined ? { extraTools: options.extraTools } : {}),
    })

  const ensure = (id: string): WebSession => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing

    const session = store.open(id)
    const state: WebSession = {
      session,
      // Assigned below; the gate and the runtime need each other's state.
      runtime: undefined as unknown as Runtime,
      running: false,
      stale: false,
      abort: undefined,
      sink: undefined,
      pending: new Map(),
      pendingAsks: new Map(),
      gate: config.approval === 'auto' ? autoApproval() : config.approval === 'deny' ? denyApproval() : ruleApproval(
        (request) =>
          new Promise<ApprovalDecision>((resolveDecision) => {
            state.pending.set(request.id, resolveDecision)
            const timer = setTimeout(() => {
              if (state.pending.delete(request.id)) resolveDecision('deny')
            }, 10 * 60_000)
            timer.unref()
          }),
        permissionRules(config.cwd),
      ),
      askGate: promptAsk(
        (request) =>
          new Promise<AskAnswer>((resolveAnswer) => {
            state.pendingAsks.set(request.id, resolveAnswer)
            const timer = setTimeout(() => {
              if (state.pendingAsks.delete(request.id)) resolveAnswer({ status: 'skipped' })
            }, 10 * 60_000)
            timer.unref()
          }),
      ),
    }
    state.runtime = buildRuntime(state)
    sessions.set(id, state)
    return state
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500
      if (!res.headersSent) sendJson(res, status, { error: (error as Error).message })
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(UI_FILE, 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }

    if (method === 'GET' && url.pathname === '/api/config') {
      sendJson(res, 200, {
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        cwd: config.cwd,
        approval: config.approval,
        summary: describeConfig(config),
        imageInput: imageSupport(config),
        enabled: readEnabledModels(config.cwd),
        presets: VENDOR_PRESETS,
      })
      return
    }

    const settingsPayload = (): Record<string, unknown> => ({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      hasKey: config.apiKey !== undefined,
      keyed: Object.keys(readKeys(config.cwd)),
      enabled: readEnabledModels(config.cwd),
      rules: permissionRules(config.cwd).list(),
      approval: config.approval,
      presets: VENDOR_PRESETS,
    })

    const modelOptionsFromBody = (body: Record<string, unknown>): Partial<EnabledModel> => {
      const options: Partial<EnabledModel> = {}
      const contextWindow = body['contextWindow']
      if (typeof contextWindow === 'number' && Number.isInteger(contextWindow) && contextWindow > 0) options.contextWindow = contextWindow
      const maxOutputTokens = body['maxOutputTokens']
      if (typeof maxOutputTokens === 'number' && Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) options.maxOutputTokens = maxOutputTokens
      const input = body['input']
      if (Array.isArray(input)) {
        options.input = [...new Set(input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image'))]
      }
      const pricing = parsePricing(body['pricing'])
      if (pricing !== undefined) options.pricing = pricing
      return options
    }

    const enabledFromBody = (body: Record<string, unknown>): EnabledModel | null => {
      const providerRaw = typeof body['provider'] === 'string' ? body['provider'] : ''
      const baseUrl = typeof body['baseUrl'] === 'string' ? body['baseUrl'].trim().replace(/\/+$/, '') : ''
      const model = typeof body['model'] === 'string' ? body['model'].trim() : ''
      if (!(PROVIDER_KINDS as string[]).includes(providerRaw) || baseUrl === '' || model === '') return null
      return { provider: providerRaw as ProviderKind, baseUrl, model, ...modelOptionsFromBody(body) }
    }

    if (method === 'GET' && url.pathname === '/api/settings') {
      sendJson(res, 200, settingsPayload())
      return
    }

    if (method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJson(req)
      const providerRaw = typeof body['provider'] === 'string' ? body['provider'] : config.provider
      if (!(PROVIDER_KINDS as string[]).includes(providerRaw)) {
        sendJson(res, 400, { error: `未知的 provider：${providerRaw}` })
        return
      }
      const provider = providerRaw as ProviderKind
      const defaults = providerDefaults(provider)
      const modelInput = typeof body['model'] === 'string' ? body['model'].trim() : ''
      const baseUrlInput = typeof body['baseUrl'] === 'string' ? body['baseUrl'].trim().replace(/\/+$/, '') : ''
      if (provider !== 'mock' && baseUrlInput === '') {
        sendJson(res, 400, { error: 'baseUrl 不能为空' })
        return
      }
      if (modelInput === '') {
        sendJson(res, 400, { error: 'model 不能为空' })
        return
      }

      const patch: SettingsPatch = {
        provider,
        model: modelInput,
        baseUrl: baseUrlInput === '' ? defaults.baseUrl : baseUrlInput,
      }
      const rawKey = body['apiKey']
      if (rawKey === null) patch.apiKey = null
      else if (typeof rawKey === 'string' && rawKey.trim() !== '') patch.apiKey = rawKey.trim()

      writeSettings(config.cwd, patch)
      enableModel(
        config.cwd,
        { provider, baseUrl: patch.baseUrl ?? defaults.baseUrl, model: modelInput, ...modelOptionsFromBody(body) },
        { clearPricing: body['pricing'] === null },
      )
      const { apiKey: _previousKey, ...rest } = config
      config = resolveConfig({
        ...rest,
        provider,
        model: modelInput,
        baseUrl: patch.baseUrl ?? defaults.baseUrl,
      })

      // The switch is global: idle sessions pick it up now, a running turn
      // finishes with its current runtime and rebuilds afterwards.
      for (const state of sessions.values()) {
        if (state.running) {
          state.stale = true
          continue
        }
        state.runtime = buildRuntime(state)
      }

      sendJson(res, 200, settingsPayload())
      return
    }

    if (method === 'POST' && url.pathname === '/api/settings/models') {
      const body = await readJson(req)
      const baseUrlInput = typeof body['baseUrl'] === 'string' ? body['baseUrl'].trim().replace(/\/+$/, '') : ''
      if (baseUrlInput === '') {
        sendJson(res, 400, { error: 'baseUrl 不能为空' })
        return
      }
      try {
        const parsed = new URL(baseUrlInput)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
      } catch {
        sendJson(res, 400, { error: 'baseUrl 必须是 http(s) 地址' })
        return
      }
      const keyInput = typeof body['apiKey'] === 'string' ? body['apiKey'].trim() : ''
      const fallbackKey =
        readKeys(config.cwd)[baseUrlInput] ?? (baseUrlInput === config.baseUrl ? config.apiKey : undefined)
      try {
        const models = await fetchModelIds(baseUrlInput, keyInput === '' ? fallbackKey : keyInput)
        sendJson(res, 200, { models })
      } catch (error) {
        sendJson(res, 502, { error: (error as Error).message })
      }
      return
    }

    if (method === 'POST' && url.pathname === '/api/settings/enabled') {
      const body = await readJson(req)
      const entry = enabledFromBody(body)
      if (entry === null) {
        sendJson(res, 400, { error: 'provider / baseUrl / model 都不能为空' })
        return
      }
      const rawKey = body['apiKey']
      if (typeof rawKey === 'string' && rawKey.trim() !== '') writeKey(config.cwd, entry.baseUrl, rawKey.trim())
      enableModel(config.cwd, entry, { clearPricing: body['pricing'] === null })
      sendJson(res, 200, settingsPayload())
      return
    }

    if (method === 'DELETE' && url.pathname === '/api/settings/enabled') {
      const body = await readJson(req)
      const baseUrl = typeof body['baseUrl'] === 'string' ? body['baseUrl'].trim().replace(/\/+$/, '') : ''
      const model = typeof body['model'] === 'string' ? body['model'].trim() : ''
      if (baseUrl === '' || model === '') {
        sendJson(res, 400, { error: 'baseUrl / model 不能为空' })
        return
      }
      disableModel(config.cwd, baseUrl, model)
      sendJson(res, 200, settingsPayload())
      return
    }

    if (method === 'DELETE' && url.pathname === '/api/settings/rules') {
      const body = await readJson(req)
      const rule = body['rule']
      if (rule !== undefined && typeof rule !== 'string') {
        sendJson(res, 400, { error: 'rule must be a string when provided' })
        return
      }
      const rules = permissionRules(config.cwd)
      const ok = typeof rule === 'string' ? rules.remove(rule) : rules.clear()
      if (!ok) {
        sendJson(res, 500, { error: '无法写入 .agent/permissions.json' })
        return
      }
      sendJson(res, 200, settingsPayload())
      return
    }

    if (method === 'GET' && url.pathname === '/api/sessions') {
      sendJson(res, 200, { sessions: store.list() })
      return
    }

    if (method === 'POST' && url.pathname === '/api/sessions') {
      const session = store.create({ cwd: config.cwd, provider: config.provider, model: config.model })
      sendJson(res, 200, { id: session.id, createdAt: session.meta.createdAt })
      return
    }

    const single = /^\/api\/sessions\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
    if (method === 'GET' && single !== null && single[1] !== undefined) {
      const state = ensure(single[1])
      sendJson(res, 200, {
        meta: state.session.meta,
        config: configPayload(),
        messages: state.session.messages,
        running: state.running,
      })
      return
    }

    if (method === 'PATCH' && single !== null && single[1] !== undefined) {
      const id = single[1]
      if (!store.has(id)) {
        sendJson(res, 404, { error: `session ${id} not found` })
        return
      }
      if (sessions.get(id)?.running === true) {
        sendJson(res, 409, { error: 'this session is already running a turn' })
        return
      }
      const body = await readJson(req)
      if (typeof body['title'] !== 'string') {
        sendJson(res, 400, { error: 'title must be a string' })
        return
      }
      const title = body['title'].trim()
      if (title.length > 120) {
        sendJson(res, 400, { error: 'title must be at most 120 characters' })
        return
      }
      const meta = store.rename(id, title === '' ? undefined : title)
      const state = sessions.get(id)
      // The store renamed a fresh copy; keep the live session in sync.
      if (state !== undefined) state.session.meta = meta
      sendJson(res, 200, { ok: true, id, title: meta.title ?? null })
      return
    }

    if (method === 'DELETE' && single !== null && single[1] !== undefined) {
      const id = single[1]
      if (!store.has(id)) {
        sendJson(res, 404, { error: `session ${id} not found` })
        return
      }
      if (sessions.get(id)?.running === true) {
        sendJson(res, 409, { error: 'this session is already running a turn' })
        return
      }
      store.remove(id)
      sessions.delete(id)
      sendJson(res, 200, { ok: true, id })
      return
    }

    const fork = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/fork$/.exec(url.pathname)
    if (method === 'POST' && fork !== null && fork[1] !== undefined) {
      const id = fork[1]
      if (!store.has(id)) {
        sendJson(res, 404, { error: `session ${id} not found` })
        return
      }
      if (sessions.get(id)?.running === true) {
        sendJson(res, 409, { error: 'this session is already running a turn' })
        return
      }
      const body = await readJson(req)
      const keep = body['keep']
      if (keep !== undefined && (typeof keep !== 'number' || !Number.isInteger(keep))) {
        sendJson(res, 400, { error: 'keep must be a non-negative integer' })
        return
      }
      const restoreFiles = body['restoreFiles'] === true
      const forkOnce = (): Session | undefined => {
        try {
          return store.fork(id, keep as number | undefined)
        } catch (error) {
          if (!(error instanceof RangeError)) throw error
          sendJson(res, 400, { error: error.message })
          return undefined
        }
      }
      if (restoreFiles) {
        if (keep === undefined) {
          sendJson(res, 400, { error: 'restoreFiles requires keep' })
          return
        }
        const source = store.open(id)
        const target = source.messages[keep]
        if (target === undefined || target.role !== 'user') {
          sendJson(res, 400, { error: 'keep must point at a user message for restoreFiles' })
          return
        }
        const checkpoint = checkpointForUserMessage(source.readTrace(), source.messages, keep)
        if (checkpoint === undefined) {
          // Old sessions or compacted turns have no snapshot: fork anyway.
          const forked = forkOnce()
          if (forked === undefined) return
          sendJson(res, 200, {
            id: forked.id,
            meta: forked.meta,
            restored: false,
            warning: '这条消息没有可用的文件快照（旧会话或已被压缩），仅分支对话',
          })
          return
        }
        const restored = await checkpointManager(config.cwd).restore(checkpoint)
        const forked = forkOnce()
        if (forked === undefined) return
        sendJson(res, 200, {
          id: forked.id,
          meta: forked.meta,
          restored: restored.ok,
          checkpoint,
          ...(restored.filesChanged !== undefined ? { filesChanged: restored.filesChanged } : {}),
          ...(restored.message !== undefined ? { warning: restored.message } : {}),
        })
        return
      }
      const forked = forkOnce()
      if (forked === undefined) return
      sendJson(res, 200, { id: forked.id, meta: forked.meta })
      return
    }

    const trace = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/trace$/.exec(url.pathname)
    if (method === 'GET' && trace !== null && trace[1] !== undefined) {
      const state = ensure(trace[1])
      const events = state.session.readTrace()
      sendJson(res, 200, { events, usage: summarizeTrace(events) })
      return
    }

    const messages = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/messages$/.exec(url.pathname)
    if (method === 'POST' && messages !== null && messages[1] !== undefined) {
      const state = ensure(messages[1])
      if (state.running) {
        sendJson(res, 409, { error: 'this session is already running a turn' })
        return
      }
      const body = await readJson(req)
      const text = typeof body['text'] === 'string' ? body['text'].trim() : ''
      const images = parseImages(body['images'])
      if (text.length === 0 && images.length === 0) {
        sendJson(res, 400, { error: 'text or images is required' })
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })

      const send = (event: AgentEvent): void => {
        if (res.writableEnded) return
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      const controller = new AbortController()
      state.running = true
      state.abort = controller
      state.sink = send

      res.on('close', () => {
        if (state.running) controller.abort()
        for (const resolveDecision of state.pending.values()) resolveDecision('deny')
        state.pending.clear()
        for (const resolveAnswer of state.pendingAsks.values()) resolveAnswer({ status: 'skipped' })
        state.pendingAsks.clear()
      })

      try {
        for await (const _event of state.runtime.agent.run(text, controller.signal, images)) {
          // Events reach the browser through `send`.
        }
      } catch (error) {
        send({ type: 'error', message: (error as Error).message })
      } finally {
        state.running = false
        state.abort = undefined
        state.sink = undefined
        if (state.stale) {
          state.stale = false
          state.runtime = buildRuntime(state)
        }
        if (!res.writableEnded) {
          res.write('event: end\ndata: {}\n\n')
          res.end()
        }
      }
      return
    }

    const approve = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/approve$/.exec(url.pathname)
    if (method === 'POST' && approve !== null && approve[1] !== undefined) {
      const state = ensure(approve[1])
      const body = await readJson(req)
      const id = typeof body['id'] === 'string' ? body['id'] : ''
      const decision = body['decision'] === 'always' ? 'always' : body['decision'] === 'allow' ? 'allow' : 'deny'
      const resolveDecision = state.pending.get(id)
      if (resolveDecision === undefined) {
        sendJson(res, 404, { error: 'no pending approval with that id' })
        return
      }
      state.pending.delete(id)
      resolveDecision(decision)
      sendJson(res, 200, { ok: true })
      return
    }

    const abortRoute = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/abort$/.exec(url.pathname)
    if (method === 'POST' && abortRoute !== null && abortRoute[1] !== undefined) {
      const state = ensure(abortRoute[1])
      if (state.abort === undefined) {
        sendJson(res, 200, { ok: true, running: false })
        return
      }
      // Release any gate first: a stopped turn must not stay parked on a
      // pending approval or question until the 10-minute timeout.
      for (const resolveDecision of state.pending.values()) resolveDecision('deny')
      state.pending.clear()
      for (const resolveAnswer of state.pendingAsks.values()) resolveAnswer({ status: 'skipped' })
      state.pendingAsks.clear()
      state.abort.abort()
      sendJson(res, 200, { ok: true, running: true })
      return
    }

    const answer = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/answer$/.exec(url.pathname)
    if (method === 'POST' && answer !== null && answer[1] !== undefined) {
      const state = ensure(answer[1])
      const body = await readJson(req)
      const id = typeof body['id'] === 'string' ? body['id'] : ''
      const resolveAnswer = state.pendingAsks.get(id)
      if (resolveAnswer === undefined) {
        sendJson(res, 404, { error: 'no pending question with that id' })
        return
      }
      let answerValue: AskAnswer
      if (body['skipped'] === true) {
        answerValue = { status: 'skipped' }
      } else {
        const selected = Array.isArray(body['selected'])
          ? body['selected'].filter((item): item is string => typeof item === 'string' && item.trim() !== '')
          : []
        const other = typeof body['other'] === 'string' && body['other'].trim() !== '' ? body['other'].trim() : undefined
        answerValue = { status: 'answered', selected, ...(other !== undefined ? { other } : {}) }
      }
      state.pendingAsks.delete(id)
      resolveAnswer(answerValue)
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` })
  }

  return { server, sessions, store }
}

function parseArgs(argv: string[]): { port: number; host: string; cwd: string; args: Record<string, string> } {
  const args: Record<string, string> = {}
  let port = 4173
  let host = '127.0.0.1'
  let cwd = process.cwd()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    const next = (): string => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      index += 1
      return value
    }
    if (arg === '--port') port = Number.parseInt(next(), 10)
    else if (arg === '--host') host = next()
    else if (arg === '--cwd') cwd = resolve(next())
    else if (arg.startsWith('--')) args[arg.slice(2)] = next()
  }
  return { port, host, cwd, args }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void (async () => {
    const parsed = parseArgs(process.argv.slice(2))
    loadDotEnv(parsed.cwd)
    const config = resolveConfig({
      cwd: parsed.cwd,
      ...(parsed.args['provider'] !== undefined ? { provider: parsed.args['provider'] as AppConfig['provider'] } : {}),
      ...(parsed.args['model'] !== undefined ? { model: parsed.args['model'] } : {}),
      ...(parsed.args['base-url'] !== undefined ? { baseUrl: parsed.args['base-url'] } : {}),
      ...(parsed.args['auto'] !== undefined ? { approval: 'auto' as const } : {}),
    })
    const mcp = await loadMcpServers(config.cwd)
    for (const error of mcp.errors) process.stderr.write(`mcp: ${error}\n`)
    process.once('exit', () => {
      void mcp.close()
    })
    const { server } = createAgentServer(config, mcp.tools.length > 0 ? { extraTools: mcp.tools } : {})
    server.listen(parsed.port, parsed.host, () => {
      process.stdout.write(`oarlock web: http://${parsed.host}:${parsed.port}\n`)
      process.stdout.write(`${describeConfig(config)}\n`)
      if (mcp.servers.length > 0) process.stdout.write(`MCP: ${mcp.servers.join(', ')}\n`)
    })
  })()
}
