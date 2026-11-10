import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { JSDOM, VirtualConsole } from 'jsdom'
import { VENDOR_PRESETS } from '../src/web/presets.ts'

const html = await readFile(new URL('../src/web/public/index.html', import.meta.url), 'utf8')

const USAGE_1 = {
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  cachedTokens: 60,
  reasoningTokens: 4,
}
const USAGE_2 = { promptTokens: 80, completionTokens: 12, totalTokens: 92, cachedTokens: 40 }
const COST_1 = { amount: 0.0009, currency: 'USD' }
const COST_2 = { amount: 0.0012, currency: 'USD' }

const TRACE_EVENTS = [
  { at: 1_000, event: { type: 'turn-start', input: '统计文件', depth: 0 } },
  { at: 1_001, event: { type: 'step-start', step: 1, depth: 0 } },
  {
    at: 1_010,
    event: {
      type: 'usage',
      usage: USAGE_1,
      cost: COST_1,
      step: 1,
      purpose: 'turn',
      model: 'mock-1',
      durationMs: 150,
      ttftMs: 30,
      attempts: 1,
      depth: 0,
    },
  },
  {
    at: 1_011,
    event: {
      type: 'assistant',
      step: 1,
      text: '我来扫一下',
      toolCalls: 1,
      usage: USAGE_1,
      model: 'mock-1',
      durationMs: 150,
      ttftMs: 30,
      depth: 0,
    },
  },
  { at: 1_012, event: { type: 'tool-call', id: 'c1', name: 'glob_files', arguments: '{"pattern":"*.ts"}', depth: 0 } },
  { at: 1_020, event: { type: 'tool-result', id: 'c1', name: 'glob_files', content: 'a.ts b.ts', isError: false, depth: 0 } },
  { at: 1_021, event: { type: 'step-start', step: 2, depth: 0 } },
  {
    at: 1_030,
    event: {
      type: 'usage',
      usage: USAGE_2,
      cost: COST_2,
      step: 2,
      purpose: 'turn',
      model: 'mock-1',
      durationMs: 200,
      ttftMs: 40,
      attempts: 1,
      depth: 0,
    },
  },
  {
    at: 1_031,
    event: {
      type: 'assistant',
      step: 2,
      text: '一共 2 个',
      toolCalls: 0,
      usage: USAGE_2,
      model: 'mock-1',
      durationMs: 200,
      ttftMs: 40,
      depth: 0,
    },
  },
  {
    at: 1_040,
    event: {
      type: 'turn-end',
      steps: 2,
      usage: { promptTokens: 180, completionTokens: 32, totalTokens: 212, cachedTokens: 100, reasoningTokens: 4 },
      text: '一共 2 个',
      durationMs: 40,
      status: 'ok',
      depth: 0,
    },
  },
]

const LIVE_USAGE = { promptTokens: 30, completionTokens: 8, totalTokens: 38, cachedTokens: 10 }
const LIVE_EVENTS = [
  { type: 'turn-start', input: '再数一次', depth: 0 },
  { type: 'step-start', step: 1, depth: 0 },
  {
    type: 'usage',
    usage: LIVE_USAGE,
    step: 1,
    purpose: 'turn',
    model: 'mock-1',
    durationMs: 12,
    ttftMs: 3,
    attempts: 1,
    depth: 0,
  },
  {
    type: 'assistant',
    step: 1,
    text: '3 个',
    toolCalls: 0,
    usage: LIVE_USAGE,
    model: 'mock-1',
    durationMs: 12,
    ttftMs: 3,
    depth: 0,
  },
  { type: 'turn-end', steps: 1, usage: LIVE_USAGE, text: '3 个', durationMs: 15, status: 'ok', depth: 0 },
]

function stubFetch(
  window: JSDOM['window'],
  options: {
    /** SSE body for POST /messages; defaults to LIVE_EVENTS. */
    messageBody?: () => string | ReadableStream
    /** Called with the parsed body of each POST /answer. */
    onAnswer?: (body: unknown) => void
    /** Called with the parsed body of each POST /fork. */
    onFork?: (body: unknown) => void
    /** Replaces the GET /api/sessions/s1 payload. */
    sessionPayload?: Record<string, unknown>
    /** Replaces the GET /api/sessions/s1/trace events. */
    traceEvents?: Array<{ at: number; event: Record<string, unknown> }>
    /** GET /api/config imageInput; defaults to true. */
    imageInput?: boolean
  } = {},
): void {
  const settings = { provider: 'mock', model: 'mock-1', baseUrl: 'http://mock.invalid/v1', hasKey: false }
  const keys = new Set<string>()
  const rules: string[] = ['bash:git status', 'write_file:src']
  type Pricing = { input: number; output: number; cached?: number; currency: string }
  type EnabledEntry = {
    provider: string
    baseUrl: string
    model: string
    contextWindow?: number
    maxOutputTokens?: number
    input?: string[]
    pricing?: Pricing
  }
  const enabled: EnabledEntry[] = []
  const upsert = (entry: Omit<EnabledEntry, 'pricing'> & { pricing?: Pricing | null }) => {
    const existing = enabled.find((item) => item.baseUrl === entry.baseUrl && item.model === entry.model)
    const { pricing, ...rest } = entry
    if (existing === undefined) {
      const copy: EnabledEntry = rest
      if (pricing !== undefined && pricing !== null) copy.pricing = pricing
      enabled.push(copy)
      return
    }
    Object.assign(existing, rest)
    if (pricing === null) delete existing.pricing
    else if (pricing !== undefined) existing.pricing = pricing
  }
  const modelOptions = (body: Record<string, unknown>) => ({
    ...(typeof body['contextWindow'] === 'number' ? { contextWindow: body['contextWindow'] } : {}),
    ...(typeof body['maxOutputTokens'] === 'number' ? { maxOutputTokens: body['maxOutputTokens'] } : {}),
    ...(Array.isArray(body['input']) ? { input: body['input'] as string[] } : {}),
    ...('pricing' in body ? { pricing: body['pricing'] as Pricing | null } : {}),
  })
  const settingsPayload = () => ({
    ...settings,
    keyed: [...keys],
    enabled,
    rules,
    approval: 'ask',
    presets: VENDOR_PRESETS,
  })
  const initialMessages =
    (options.sessionPayload?.['messages'] as Array<Record<string, unknown>> | undefined) ?? [
      { role: 'user', content: '统计文件' },
      { role: 'assistant', content: '一共 2 个' },
    ]
  const sessionRows: Array<{ id: string; title: string; messages: number; updatedAt: string; turns: number; usage?: unknown }> = [
    {
      id: 's1',
      title: 'demo',
      messages: initialMessages.length,
      updatedAt: new Date(2_000).toISOString(),
      turns: 1,
      usage: {
        promptTokens: 180,
        completionTokens: 32,
        totalTokens: 212,
        cachedTokens: 100,
        requests: 2,
        costs: [{ currency: 'USD', amount: 0.75 }],
      },
    },
  ]
  const sessionMessages = new Map<string, Array<Record<string, unknown>>>([['s1', initialMessages]])
  let nextSession = 2
  const emptyUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 }

  const responses: Record<string, unknown> = {}

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    const path = url.replace('http://localhost:4173', '')
    if (path === '/api/sessions/s1/messages' && init?.method === 'POST') {
      const body =
        options.messageBody === undefined
          ? `${LIVE_EVENTS.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}event: end\ndata: {}\n\n`
          : options.messageBody()
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (path === '/api/sessions/s1/answer' && init?.method === 'POST') {
      options.onAnswer?.(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/config') {
      const body = {
        ...settings,
        cwd: '/tmp',
        approval: 'ask',
        summary: `${settings.provider}/${settings.model} · ${settings.baseUrl}`,
        imageInput: options.imageInput !== false,
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/settings' && init?.method === 'POST') {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>
      const endpoint = String(patch['baseUrl']).replace(/\/+$/, '')
      settings.provider = String(patch['provider'])
      settings.model = String(patch['model'])
      settings.baseUrl = endpoint
      if (typeof patch['apiKey'] === 'string' && patch['apiKey'] !== '') keys.add(endpoint)
      else if (patch['apiKey'] === null) keys.delete(endpoint)
      settings.hasKey = keys.has(endpoint)
      // saving a model config also enables it, exactly like the server does
      upsert({ provider: settings.provider, baseUrl: endpoint, model: settings.model, ...modelOptions(patch) })
      return new Response(JSON.stringify(settingsPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/settings/enabled' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const entry = {
        provider: String(body['provider']),
        baseUrl: String(body['baseUrl']).replace(/\/+$/, ''),
        model: String(body['model']),
        ...modelOptions(body),
      }
      if (typeof body['apiKey'] === 'string' && body['apiKey'] !== '') keys.add(entry.baseUrl)
      upsert(entry)
      return new Response(JSON.stringify(settingsPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/settings/enabled' && init?.method === 'DELETE') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const endpoint = String(body['baseUrl']).replace(/\/+$/, '')
      const name = String(body['model'])
      const index = enabled.findIndex((item) => item.baseUrl === endpoint && item.model === name)
      if (index >= 0) enabled.splice(index, 1)
      return new Response(JSON.stringify(settingsPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/settings/rules' && init?.method === 'DELETE') {
      const body = JSON.parse(String(init.body)) as { rule?: string }
      if (typeof body.rule === 'string') {
        const index = rules.indexOf(body.rule)
        if (index >= 0) rules.splice(index, 1)
      } else {
        rules.length = 0
      }
      return new Response(JSON.stringify(settingsPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/settings') {
      return new Response(JSON.stringify(settingsPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/settings/models' && init?.method === 'POST') {
      const models = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']
      return new Response(JSON.stringify({ models }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/sessions' && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ sessions: sessionRows }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/sessions' && init?.method === 'POST') {
      const id = `s${nextSession++}`
      const createdAt = new Date(3_000).toISOString()
      sessionRows.push({ id, title: '新会话', messages: 0, updatedAt: createdAt, turns: 0, usage: emptyUsage })
      sessionMessages.set(id, [])
      return new Response(JSON.stringify({ id, createdAt }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const sessionRoute = /^\/api\/sessions\/([A-Za-z0-9_-]+)(\/trace|\/fork)?$/.exec(path)
    if (sessionRoute !== null && sessionRoute[1] !== undefined) {
      const id = sessionRoute[1]
      const suffix = sessionRoute[2] ?? ''
      const row = sessionRows.find((session) => session.id === id)
      if (row === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      if (suffix === '/trace') {
        const events = id === 's1' ? options.traceEvents ?? TRACE_EVENTS : []
        return new Response(JSON.stringify({ events }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (suffix === '/fork' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { keep?: number; restoreFiles?: boolean }
        options.onFork?.(body)
        const source = sessionMessages.get(id) ?? []
        const keep = typeof body.keep === 'number' ? body.keep : source.length
        const forkId = `s${nextSession++}`
        const prefix = source.slice(0, keep)
        sessionMessages.set(forkId, prefix)
        const createdAt = new Date(4_000).toISOString()
        sessionRows.push({ id: forkId, title: `${row.title} · 分支`, messages: prefix.length, updatedAt: createdAt, turns: 0, usage: emptyUsage })
        // Mirror the server: a rewind reports what it changed on disk.
        const extra = body.restoreFiles === true ? { restored: true, filesChanged: 3, checkpoint: 'abc1234' } : {}
        return new Response(JSON.stringify({ id: forkId, meta: { id: forkId, title: `${row.title} · 分支` }, ...extra }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { title?: string }
        row.title = (body.title ?? '').trim() === '' ? row.title : (body.title ?? '').trim()
        return new Response(JSON.stringify({ ok: true, id, title: row.title }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (init?.method === 'DELETE') {
        sessionRows.splice(sessionRows.indexOf(row), 1)
        sessionMessages.delete(id)
        return new Response(JSON.stringify({ ok: true, id }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const payload =
        id === 's1' && options.sessionPayload !== undefined
          ? options.sessionPayload
          : { meta: { id }, messages: sessionMessages.get(id) ?? [], running: false }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = responses[path]
    if (body === undefined) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  ;(window as unknown as { fetch: typeof fakeFetch }).fetch = fakeFetch
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the page to settle')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('clicking the trace toggle renders user/assistant/tool records', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    // Scripts execute during parsing, so the stub must exist before parse.
    beforeParse: (window) => stubFetch(window),
  })
  const { window } = dom

  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)

    const toggle = document.querySelector('#trace-toggle') as HTMLButtonElement | null
    assert.ok(toggle !== null, 'trace toggle missing')
    toggle.click()
    await waitFor(() => (document.querySelector('#trace-ledger')?.textContent ?? '').length > 0)

    const ledger = document.querySelector('#trace-ledger')?.textContent ?? ''
    assert.match(ledger, /用户/, 'user record missing')
    assert.match(ledger, /助手/, 'assistant record missing')
    assert.match(ledger, /工具/, 'tool record missing')
    assert.match(ledger, /一共 2 个/, 'assistant text missing')
    assert.match(ledger, /轮次/, 'turn header missing')
    assert.match(ledger, /请求/, 'request row missing')
    assert.match(ledger, /Token/, 'token column missing')
    assert.match(ledger, /↑/, 'per-request token cell missing')

    const badges = [...document.querySelectorAll('#trace-ledger .kind')].map((node) => node.textContent)
    assert.ok(badges.includes('用户') && badges.includes('助手') && badges.includes('工具'), `kinds: ${badges.join(',')}`)

    const summary = document.querySelector('#trace-summary')?.textContent ?? ''
    assert.match(summary, /1 轮/, `summary should report turns: ${summary}`)
    assert.match(summary, /2 请求/, `summary should report requests: ${summary}`)
    assert.match(summary, /↑180/, `summary should report input tokens: ${summary}`)
    assert.match(summary, /↓32/, `summary should report output tokens: ${summary}`)
    assert.match(summary, /缓存 100/, `summary should report cached tokens: ${summary}`)
    assert.match(summary, /成本 \$0\.0021/, `summary should aggregate request costs: ${summary}`)

    const sessionMeta = document.querySelector('#sessions .session .m')?.textContent ?? ''
    assert.match(sessionMeta, /1 轮/, `session list should show turns: ${sessionMeta}`)
    assert.match(sessionMeta, /212 tok/, `session list should show tokens: ${sessionMeta}`)
    assert.match(sessionMeta, /\$0\.75/, `session list should show accumulated cost: ${sessionMeta}`)

    const assistants = [...document.querySelectorAll('#trace-ledger .trace-row.assistant')]
    assert.equal(assistants.length, 2, 'both assistant requests should be rows')
    assistants[0]?.dispatchEvent(new window.Event('click', { bubbles: true }))
    await waitFor(() => (document.querySelector('#trace-inspector')?.textContent ?? '').includes('本次请求'))
    const inspector = document.querySelector('#trace-inspector')?.textContent ?? ''
    assert.match(inspector, /请求 #1/, `inspector should name the request: ${inspector}`)
    assert.match(inspector, /输入/, 'inspector should show input tokens')
    assert.match(inspector, /缓存/, 'inspector should show cached tokens')
    assert.match(inspector, /输出/, 'inspector should show output tokens')
    assert.match(inspector, /会话累计/, 'inspector should show cumulative usage')
    assert.match(inspector, /首字/, 'inspector should show TTFT')
    assert.match(
      document.querySelector('#trace-inspector .usage-cost')?.textContent ?? '',
      /成本\s*\$0\.0009/,
      'the request panel should show its billed cost',
    )
    assert.match(
      assistants[0]?.querySelector('.tok')?.getAttribute('title') ?? '',
      /成本 \$0\.0009/,
      'the ledger token tooltip should include the cost',
    )

    const app = document.querySelector('#app')
    assert.ok(app?.classList.contains('trace-open'), 'the layout should open the split view, not cover the chat')
    const settingsEntry = document.querySelector('#settings-toggle')
    assert.ok(settingsEntry !== null && settingsEntry.closest('aside') !== null, '设置 should stay in the sidebar')

    const display = (selector: string): string => {
      const node = document.querySelector(selector)
      assert.ok(node !== null, `${selector} missing`)
      return window.getComputedStyle(node).display
    }
    assert.equal(display('aside'), 'flex', 'the sidebar should stay')
    assert.ok(document.querySelectorAll('#sessions .session').length > 0, 'session list should stay in the sidebar')
    assert.equal(display('#sessions'), 'flex', 'session list should stay visible')
    assert.equal(display('.brand'), 'none', 'the sidebar brand should hide behind the trace')
    assert.equal(display('.new-btn'), 'none', 'the new-session button should hide while the trace is open')

    document.querySelector<HTMLButtonElement>('#trace-close')?.click()
    assert.equal(display('.brand'), 'flex', 'closing the trace should bring the sidebar chrome back')
    assert.equal(display('.new-btn'), 'inline-block', 'closing the trace should bring the new-session button back')

    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('a todo_write update renders a 计划 row and inspector', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const todos = [
    { id: 'scan', content: '读代码', status: 'completed' },
    { id: 'impl', content: '改实现', status: 'in_progress' },
    { id: 'test', content: '补测试', status: 'pending' },
  ]
  const traceEvents = [
    { at: 1_000, event: { type: 'turn-start', input: '做计划', depth: 0 } },
    { at: 1_001, event: { type: 'step-start', step: 1, depth: 0 } },
    { at: 1_010, event: { type: 'assistant', step: 1, text: '', toolCalls: 1, usage: LIVE_USAGE, depth: 0 } },
    { at: 1_011, event: { type: 'tool-call', id: 'c1', name: 'todo_write', arguments: JSON.stringify({ todos }), depth: 0 } },
    { at: 1_012, event: { type: 'todo', todos, depth: 0 } },
    { at: 1_013, event: { type: 'tool-result', id: 'c1', name: 'todo_write', content: 'Current plan (1/3 done)', isError: false, depth: 0 } },
    { at: 1_020, event: { type: 'turn-end', steps: 1, usage: LIVE_USAGE, text: '', status: 'ok', depth: 0 } },
  ]

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) => stubFetch(window, { traceEvents }),
  })
  const { window } = dom
  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)
    document.querySelector<HTMLButtonElement>('#trace-toggle')?.click()
    await waitFor(() => (document.querySelector('#trace-ledger')?.textContent ?? '').length > 0)

    const row = document.querySelector('#trace-ledger .trace-row.todo') as HTMLElement | null
    assert.ok(row !== null, 'the plan row should render')
    assert.equal(row.querySelector('.kind')?.textContent, '计划')
    assert.match(row.textContent ?? '', /1\/3 完成/)
    assert.match(row.textContent ?? '', /改实现/)

    row.dispatchEvent(new window.Event('click', { bubbles: true }))
    await waitFor(() => (document.querySelector('#trace-inspector')?.textContent ?? '').includes('[~]'))
    const inspector = document.querySelector('#trace-inspector')?.textContent ?? ''
    assert.match(inspector, /\[x\] scan: 读代码/)
    assert.match(inspector, /\[~\] impl: 改实现/)
    assert.match(inspector, /\[ \] test: 补测试/)

    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('a budget turn-end renders a 预算 marker in the trace', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const traceEvents = [
    { at: 1_000, event: { type: 'turn-start', input: '跑预算', depth: 0 } },
    { at: 1_001, event: { type: 'step-start', step: 1, depth: 0 } },
    { at: 1_010, event: { type: 'assistant', step: 1, text: 'working', toolCalls: 1, usage: LIVE_USAGE, depth: 0 } },
    { at: 1_020, event: { type: 'turn-end', steps: 1, usage: LIVE_USAGE, text: 'working', status: 'budget', depth: 0 } },
  ]

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) => stubFetch(window, { traceEvents }),
  })
  const { window } = dom
  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)
    document.querySelector<HTMLButtonElement>('#trace-toggle')?.click()
    await waitFor(() => (document.querySelector('#trace-ledger')?.textContent ?? '').length > 0)

    const turnRow = document.querySelector('#trace-ledger .trace-row.turn') as HTMLElement | null
    assert.ok(turnRow !== null, 'the turn row should render')
    assert.match(turnRow.textContent ?? '', /预算/)

    turnRow.dispatchEvent(new window.Event('click', { bubbles: true }))
    await waitFor(() => (document.querySelector('#trace-inspector')?.textContent ?? '').includes('预算收尾'))

    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('the composer menu lists enabled models and switches globally', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) => stubFetch(window),
  })
  const { window } = dom

  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)
    await waitFor(() => (document.querySelector('#model')?.textContent ?? '') === 'mock-1')

    const menu = document.querySelector('#model-menu') as HTMLElement
    const dialog = document.querySelector('#settings') as HTMLElement
    const modelNames = () => [...menu.querySelectorAll('.menu-item .name')].map((node) => node.textContent ?? '')

    document.querySelector<HTMLButtonElement>('#model')?.click()
    await waitFor(() => modelNames().length > 0)
    assert.equal(menu.hidden, false, 'the chip opens a menu')
    assert.equal(dialog.hidden, true, 'the chip no longer opens the whole dialog')
    assert.deepEqual(modelNames(), ['mock-1'], 'with an empty registry only the model in use is offered')
    assert.ok(menu.querySelector('.menu-item[aria-current="true"]') !== null, 'the model in use is marked')

    const manage = [...menu.querySelectorAll<HTMLButtonElement>('.menu-item')].find(
      (node) => node.textContent === '管理已启用模型…',
    )
    assert.ok(manage !== undefined, 'the menu should link to settings')
    manage.click()
    await waitFor(() => !dialog.hidden)
    assert.equal(menu.hidden, true, 'the menu closes when the dialog opens')
    assert.equal(document.querySelector('#settings-title')?.textContent, '设置')
    assert.equal(document.querySelector('#nav-model')?.getAttribute('aria-pressed'), 'true', 'the dialog opens on 模型')
    assert.match(document.querySelector('#settings-sub')?.textContent ?? '', /全局生效/)
    assert.equal(document.querySelector('#pane-appearance')?.hasAttribute('hidden'), true)
    assert.equal(document.querySelector('#pane-model')?.hasAttribute('hidden'), false)
    await waitFor(() => document.querySelectorAll('#vendor-list .vendor').length === 1)
    assert.equal(
      document.querySelector('#vendor-list .vendor span')?.textContent,
      '离线 Mock',
      'the supplier list shows only added suppliers (the active one), not every preset',
    )
    assert.ok(document.querySelector('#vendor-list [data-preset="deepseek"]') === null, 'presets stay out until 添加模型')
    assert.match(document.querySelector('#enabled-list .enabled-empty')?.textContent ?? '', /添加模型/)

    document.querySelector<HTMLButtonElement>('#supplier-add')?.click()
    await waitFor(() => document.querySelectorAll('#vendor-list .vendor').length === VENDOR_PRESETS.length)
    assert.equal(document.querySelector('#supplier-label')?.textContent, '选择供应商')
    assert.equal(document.querySelector('#detail-actions')?.hasAttribute('hidden'), true, 'adding commits via 保存, not 启用该模型')
    const deepseek = document.querySelector<HTMLButtonElement>('#vendor-list [data-preset="deepseek"]')
    assert.ok(deepseek !== null, 'deepseek preset missing')
    deepseek.click()
    assert.equal((document.querySelector('#set-base-url') as HTMLInputElement).value, 'https://api.deepseek.com')
    const rowNames = () => [...document.querySelectorAll('#set-model-list .model-opt')].map((row) => (row as HTMLElement).dataset.model)
    assert.deepEqual(rowNames(), ['deepseek-chat', 'deepseek-reasoner'], 'preset models are listed as checkboxes')

    document.querySelector<HTMLButtonElement>('#set-models-refresh')?.click()
    await waitFor(() => (document.querySelector('#set-models-status')?.textContent ?? '').includes('已获取 3 个模型'))
    assert.deepEqual(
      rowNames(),
      ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
      'every fetched model should be selectable, not only the first',
    )

    const rowOf = (model: string) => document.querySelector(`#set-model-list .model-opt[data-model="${model}"]`) as HTMLElement
    const checkOf = (model: string) => rowOf(model).querySelector<HTMLInputElement>('.model-opt-head input[type="checkbox"]')!
    const paramsOf = (model: string) => rowOf(model).querySelector('.model-params') as HTMLElement
    const openParams = (model: string) => rowOf(model).querySelector<HTMLButtonElement>('.model-opt-head .link-btn')!.click()
    const setNumber = (input: HTMLInputElement, value: string) => {
      input.value = value
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    }

    // 勾选 reasoner 并配置参数：上下文 / 最大输出 / 图片输入
    checkOf('deepseek-reasoner').click()
    openParams('deepseek-reasoner')
    const numbers = paramsOf('deepseek-reasoner').querySelectorAll<HTMLInputElement>('input[type="number"]')
    setNumber(numbers[0]!, '128000')
    setNumber(numbers[1]!, '8192')
    paramsOf('deepseek-reasoner').querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click()
    const priceInputs = paramsOf('deepseek-reasoner').querySelectorAll<HTMLInputElement>('.model-price-grid input[type="number"]')
    setNumber(priceInputs[0]!, '2')
    setNumber(priceInputs[1]!, '8')
    setNumber(priceInputs[2]!, '1')
    const currency = paramsOf('deepseek-reasoner').querySelector('select.price-currency') as HTMLSelectElement
    currency.value = 'CNY'
    currency.dispatchEvent(new window.Event('change', { bubbles: true }))
    ;(document.querySelector('#set-key') as HTMLInputElement).value = 'sk-ui'
    // 保存 is the commit: it enables the checked models and activates one globally
    document.querySelector('#settings-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => dialog.hidden)
    await waitFor(() => (document.querySelector('#model') as HTMLButtonElement).textContent === 'deepseek-reasoner')

    document.querySelector<HTMLButtonElement>('#model')?.click()
    await waitFor(() => modelNames().includes('deepseek-reasoner'))
    assert.deepEqual(modelNames(), ['deepseek-reasoner'], 'only saved models show up in the composer menu')
    document.querySelector<HTMLButtonElement>('#settings-toggle')?.click()
    await waitFor(() => !dialog.hidden)
    await waitFor(() => document.querySelectorAll('#vendor-list .vendor').length === 1)
    assert.equal(
      document.querySelector('#vendor-list .vendor[aria-pressed="true"] span')?.textContent,
      'DeepSeek',
      'the saved supplier appears in the list and is selected',
    )

    // 已保存模型的勾选状态和参数要回显
    assert.equal(checkOf('deepseek-reasoner').checked, true, 'the enabled model stays checked')
    openParams('deepseek-reasoner')
    const savedNumbers = paramsOf('deepseek-reasoner').querySelectorAll<HTMLInputElement>('input[type="number"]')
    assert.equal(savedNumbers[0]?.value, '128000', 'context window should round-trip')
    assert.equal(savedNumbers[1]?.value, '8192', 'max output tokens should round-trip')
    const savedMods = paramsOf('deepseek-reasoner').querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    assert.equal(savedMods[0]?.checked, true, 'text input stays supported')
    assert.equal(savedMods[1]?.checked, true, 'image input should round-trip')
    const savedPrices = paramsOf('deepseek-reasoner').querySelectorAll<HTMLInputElement>('.model-price-grid input[type="number"]')
    assert.equal(savedPrices[0]?.value, '2', 'input price should round-trip')
    assert.equal(savedPrices[1]?.value, '8', 'output price should round-trip')
    assert.equal(savedPrices[2]?.value, '1', 'cached price should round-trip')
    assert.equal(
      (paramsOf('deepseek-reasoner').querySelector('select.price-currency') as HTMLSelectElement | null)?.value,
      'CNY',
      'currency should round-trip',
    )

    // 勾选同供应商的第二个模型，批量启用但不切换 active（密钥已存过）
    checkOf('deepseek-chat').click()
    document.querySelector<HTMLButtonElement>('#set-enable')?.click()
    await waitFor(() => document.querySelectorAll('#enabled-list .enabled-row').length === 2)
    assert.match(document.querySelector('#set-enable-hint')?.textContent ?? '', /已启用 .*deepseek-chat/)
    assert.equal(
      document.querySelector('#enabled-list .enabled-row.active .name')?.textContent,
      'deepseek-reasoner · 使用中',
      'a freshly enabled model is not the active one',
    )

    // 保存时当前模型在勾选列表里 → 保持它，而不是跳到第一个
    document.querySelector('#settings-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => dialog.hidden)
    await waitFor(() => (document.querySelector('#model') as HTMLButtonElement).textContent === 'deepseek-reasoner')

    document.querySelector<HTMLButtonElement>('#model')?.click()
    await waitFor(() => modelNames().includes('deepseek-reasoner'))
    assert.deepEqual(
      [...new Set(modelNames())],
      ['deepseek-reasoner', 'deepseek-chat'],
      'the menu offers exactly the enabled models, in the order they were added',
    )
    assert.ok(!((menu.textContent ?? '').includes('qwen3:8b')), 'a preset that was never enabled stays out')
    assert.ok(((menu.querySelector('.menu-item[aria-current="true"]')?.textContent ?? '')).includes('deepseek-reasoner'))

    const chat = [...document.querySelectorAll('#model-menu .menu-item .name')].find(
      (node) => node.textContent === 'deepseek-chat',
    )
    assert.ok(chat !== undefined)
    ;(chat.closest('button') as HTMLButtonElement).click()
    await waitFor(() => (document.querySelector('#model') as HTMLButtonElement).textContent === 'deepseek-chat')
    assert.equal(menu.hidden, true, 'picking a model closes the menu')

    document.querySelector<HTMLButtonElement>('#settings-toggle')?.click()
    await waitFor(() => !dialog.hidden)
    assert.equal((document.querySelector('#set-key') as HTMLInputElement).value, '', 'the key should never be echoed back')
    assert.equal(
      document.querySelector('#enabled-list .enabled-row.active .name')?.textContent,
      'deepseek-chat · 使用中',
      'the row for the active model is marked',
    )

    const priceBadge = (model: string) => {
      const row = [...document.querySelectorAll('#enabled-list .enabled-row')].find(
        (node) => (node.querySelector('.name')?.textContent ?? '').startsWith(model),
      )
      return row?.querySelector('.enabled-price')?.textContent ?? ''
    }
    assert.equal(priceBadge('deepseek-reasoner'), '¥2 / ¥8', 'saved unit prices show on the enabled model')

    // 清空输入 / 输出即视为不记成本，保存后徽标消失
    openParams('deepseek-reasoner')
    const clearedPrices = paramsOf('deepseek-reasoner').querySelectorAll<HTMLInputElement>('.model-price-grid input[type="number"]')
    setNumber(clearedPrices[0]!, '')
    setNumber(clearedPrices[1]!, '')
    document.querySelector<HTMLButtonElement>('#set-enable')?.click()
    await waitFor(() => priceBadge('deepseek-reasoner') === '')
    assert.equal(priceBadge('deepseek-reasoner'), '', 'clearing the price inputs removes the stored pricing')

    // removing an entry takes it out of the registry and the composer menu
    const reasonerRow = [...document.querySelectorAll('#enabled-list .enabled-row')].find(
      (row) => (row.querySelector('.name')?.textContent ?? '') === 'deepseek-reasoner',
    )
    assert.ok(reasonerRow !== undefined, 'the enabled list should show both models')
    const dropReasoner = [...reasonerRow.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '移除')
    assert.ok(dropReasoner !== undefined, 'every enabled row should be removable')
    dropReasoner.click()
    await waitFor(() => document.querySelectorAll('#enabled-list .enabled-row').length === 1)
    document.querySelector<HTMLButtonElement>('#settings-close')?.click()
    document.querySelector<HTMLButtonElement>('#model')?.click()
    await waitFor(() => (menu.textContent ?? '').includes('管理已启用模型'))
    assert.deepEqual(modelNames(), ['deepseek-chat'], 'a removed model disappears from the switcher')

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    assert.equal(menu.hidden, true, 'Escape should close the menu')
    assert.equal(dialog.hidden, true, 'Escape should close the dialog')

    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('the appearance pane switches the theme in place', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) => stubFetch(window),
  })
  const { window } = dom

  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)

    document.querySelector<HTMLButtonElement>('#settings-toggle')?.click()
    await waitFor(() => !document.querySelector('#settings')!.hasAttribute('hidden'))
    document.querySelector<HTMLButtonElement>('#nav-appearance')?.click()

    assert.equal(document.querySelector('#pane-model')?.hasAttribute('hidden'), true)
    assert.equal(document.querySelector('#pane-appearance')?.hasAttribute('hidden'), false)
    assert.equal(document.querySelector('#settings-save')?.hasAttribute('hidden'), true, 'appearance needs no save')
    assert.match(document.querySelector('#settings-sub')?.textContent ?? '', /本机浏览器/)

    const light = document.querySelector<HTMLButtonElement>('#theme-list [data-theme-choice="light"]')
    assert.ok(light !== null, 'light option missing')
    light.click()
    assert.equal(document.documentElement.dataset.theme, 'light')
    assert.equal(window.localStorage.getItem('dock-theme'), 'light')
    assert.equal(light.getAttribute('aria-pressed'), 'true')

    const system = document.querySelector<HTMLButtonElement>('#theme-list [data-theme-choice="system"]')
    assert.ok(system !== null, 'system option missing')
    system.click()
    assert.equal(window.localStorage.getItem('dock-theme'), 'system')
    assert.equal(system.getAttribute('aria-pressed'), 'true')
    assert.ok(['light', 'dark'].includes(document.documentElement.dataset.theme ?? ''))

    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('the permissions pane lists persisted rules and clears them with a confirm', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) => stubFetch(window),
  })
  const { window } = dom

  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)

    document.querySelector<HTMLButtonElement>('#settings-toggle')?.click()
    await waitFor(() => !document.querySelector('#settings')!.hasAttribute('hidden'))
    document.querySelector<HTMLButtonElement>('#nav-permissions')?.click()

    assert.equal(document.querySelector('#pane-model')?.hasAttribute('hidden'), true)
    assert.equal(document.querySelector('#pane-permissions')?.hasAttribute('hidden'), false)
    assert.match(document.querySelector('#settings-sub')?.textContent ?? '', /permissions\.json/)
    assert.equal(document.querySelector('#settings-save')?.hasAttribute('hidden'), true, 'rules need no save')
    await waitFor(() => document.querySelectorAll('#rules-list .enabled-row').length === 2)

    const names = [...document.querySelectorAll('#rules-list .enabled-row .name')].map((node) => node.textContent)
    assert.deepEqual(names, ['bash:git status', 'write_file:src'])

    const firstRemove = [...document.querySelectorAll<HTMLButtonElement>('#rules-list .enabled-row button')].find(
      (node) => node.textContent === '移除',
    )
    assert.ok(firstRemove !== undefined)
    firstRemove.click()
    await waitFor(() => document.querySelectorAll('#rules-list .enabled-row').length === 1)

    const clear = document.querySelector<HTMLButtonElement>('#rules-clear') as HTMLButtonElement
    clear.click()
    assert.match(clear.textContent ?? '', /确认清空/)
    assert.equal(clear.classList.contains('armed'), true, 'the first click only arms the clear')
    clear.click()
    await waitFor(() => document.querySelector('#rules-list .enabled-empty') !== null)

    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('live streaming appends turn rows and updates token totals', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) => stubFetch(window),
  })
  const { window } = dom

  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)

    const toggle = document.querySelector('#trace-toggle') as HTMLButtonElement | null
    assert.ok(toggle !== null, 'trace toggle missing')
    toggle.click()
    await waitFor(() => (document.querySelector('#trace-ledger')?.textContent ?? '').length > 0)

    const input = document.querySelector('#input') as HTMLTextAreaElement | null
    assert.ok(input !== null, 'composer input missing')
    input.value = '再数一次'
    document.querySelector('#composer')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))

    await waitFor(() => (document.querySelector('#trace-summary')?.textContent ?? '').includes('2 轮'))
    const ledger = document.querySelector('#trace-ledger')?.textContent ?? ''
    assert.match(ledger, /3 个/, `live assistant record missing: ${ledger}`)
    assert.match(ledger, /再数一次/, 'live user record missing')

    const summary = document.querySelector('#trace-summary')?.textContent ?? ''
    assert.match(summary, /3 请求/, `requests should accumulate: ${summary}`)
    assert.match(summary, /↑210/, `input tokens should accumulate: ${summary}`)
    assert.match(summary, /↓40/, `output tokens should accumulate: ${summary}`)
    assert.match(summary, /合计 250/, `total tokens should accumulate: ${summary}`)

    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('an ask_user question renders an interactive card and submits the answer', async () => {
  const errors: string[] = []
  const posted: Array<Record<string, unknown>> = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
  const optionsArgs = JSON.stringify({
    question: '用哪种？',
    options: [
      { label: '快', description: '省时' },
      { label: '稳', recommended: true, description: '可靠' },
    ],
    multiSelect: false,
    allowOther: true,
  })
  const before = [
    { type: 'turn-start', input: '选一下', depth: 0 },
    { type: 'step-start', step: 1, depth: 0 },
    { type: 'assistant', step: 1, text: '', toolCalls: 1, usage: LIVE_USAGE, depth: 0 },
    { type: 'tool-call', id: 'c1', name: 'ask_user', arguments: optionsArgs, depth: 0 },
    {
      type: 'ask-request',
      id: 'q1',
      callId: 'c1',
      question: '用哪种？',
      options: [
        { label: '快', description: '省时' },
        { label: '稳', recommended: true, description: '可靠' },
      ],
      multiSelect: false,
      allowOther: true,
      depth: 0,
    },
  ]
  const after = [
    { type: 'ask-answer', id: 'q1', answer: { status: 'answered', selected: ['稳'] }, depth: 0 },
    { type: 'tool-result', id: 'c1', name: 'ask_user', content: 'The user answered "用哪种？".\nSelected: 稳', isError: false, depth: 0 },
    { type: 'step-start', step: 2, depth: 0 },
    { type: 'assistant', step: 2, text: '好的，用稳的。', toolCalls: 0, usage: LIVE_USAGE, depth: 0 },
    { type: 'turn-end', steps: 2, usage: LIVE_USAGE, text: '好的，用稳的。', status: 'ok', depth: 0 },
  ]
  const encoder = new TextEncoder()
  let released: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    released = resolve
  })

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) =>
      stubFetch(window, {
        onAnswer: (body: unknown) => {
          posted.push(body as Record<string, unknown>)
          released()
        },
        messageBody: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(before.map(frame).join('')))
              void gate.then(() => {
                controller.enqueue(encoder.encode(after.map(frame).join('') + 'event: end\ndata: {}\n\n'))
                controller.close()
              })
            },
          }),
      }),
  })
  const { window } = dom
  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)
    ;(document.querySelector('#input') as HTMLTextAreaElement).value = '选一下'
    ;(document.querySelector('#composer') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    )

    await waitFor(() => document.querySelector('#inner .ask-card') !== null)
    const card = document.querySelector('#inner .ask-card') as HTMLElement
    assert.ok(card !== null)
    assert.match(card.querySelector('.ask-question')?.textContent ?? '', /用哪种/)
    assert.equal(card.querySelectorAll('.ask-opt').length, 3, 'two options plus a 其他 row')
    assert.ok(card.querySelector('.ask-badge') !== null, 'recommended badge missing')
    const labels = [...card.querySelectorAll('.ask-label')].map((node) => node.textContent ?? '')
    assert.deepEqual(labels.map((text) => text.replace('推荐', '')), ['快', '稳', '其他'])

    const submit = card.querySelector('.ask-submit') as HTMLButtonElement
    assert.equal(submit.disabled, true, 'submit stays disabled until a selection exists')
    const safe = [...card.querySelectorAll<HTMLInputElement>('.ask-opt input')].find((node) => node.value === '稳')
    assert.ok(safe !== undefined)
    safe.checked = true
    safe.dispatchEvent(new window.Event('change', { bubbles: true }))
    assert.equal(submit.disabled, false, 'selecting an option enables submit')
    submit.click()

    await waitFor(() => card.dataset.state === 'answered')
    assert.deepEqual(posted, [{ id: 'q1', selected: ['稳'] }])
    assert.equal(card.querySelector('.ask-status'), null, 'answered cards keep only the checked options — no footer status')
    assert.ok(card.querySelector('.ask-opt.checked') !== null, 'the chosen option stays marked')
    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('skipping an ask_user question marks the card as skipped', async () => {
  const errors: string[] = []
  const posted: Array<Record<string, unknown>> = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
  const before = [
    { type: 'turn-start', input: '选一下', depth: 0 },
    { type: 'step-start', step: 1, depth: 0 },
    { type: 'assistant', step: 1, text: '', toolCalls: 1, usage: LIVE_USAGE, depth: 0 },
    { type: 'tool-call', id: 'c1', name: 'ask_user', arguments: JSON.stringify({ question: '用哪种？', options: [{ label: '快' }, { label: '稳' }], multiSelect: false, allowOther: false }), depth: 0 },
    {
      type: 'ask-request',
      id: 'q1',
      callId: 'c1',
      question: '用哪种？',
      options: [{ label: '快' }, { label: '稳' }],
      multiSelect: false,
      allowOther: false,
      depth: 0,
    },
  ]
  const after = [
    { type: 'ask-answer', id: 'q1', answer: { status: 'skipped' }, depth: 0 },
    { type: 'tool-result', id: 'c1', name: 'ask_user', content: 'The user skipped the question.', isError: false, depth: 0 },
    { type: 'step-start', step: 2, depth: 0 },
    { type: 'assistant', step: 2, text: '我自己决定了。', toolCalls: 0, usage: LIVE_USAGE, depth: 0 },
    { type: 'turn-end', steps: 2, usage: LIVE_USAGE, text: '我自己决定了。', status: 'ok', depth: 0 },
  ]
  const encoder = new TextEncoder()
  let released: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    released = resolve
  })

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) =>
      stubFetch(window, {
        onAnswer: (body: unknown) => {
          posted.push(body as Record<string, unknown>)
          released()
        },
        messageBody: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(before.map(frame).join('')))
              void gate.then(() => {
                controller.enqueue(encoder.encode(after.map(frame).join('') + 'event: end\ndata: {}\n\n'))
                controller.close()
              })
            },
          }),
      }),
  })
  const { window } = dom
  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)
    ;(document.querySelector('#input') as HTMLTextAreaElement).value = '选一下'
    ;(document.querySelector('#composer') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    )

    await waitFor(() => document.querySelector('#inner .ask-card') !== null)
    const card = document.querySelector('#inner .ask-card') as HTMLElement
    ;(card.querySelector('.ask-skip') as HTMLButtonElement).click()
    await waitFor(() => card.dataset.state === 'skipped')
    assert.deepEqual(posted, [{ id: 'q1', skipped: true }])
    assert.match(card.querySelector('.ask-status')?.textContent ?? '', /已跳过/)
    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('history renders an answered ask card in read-only form', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) =>
      stubFetch(window, {
        sessionPayload: {
          meta: { id: 's1' },
          messages: [
            { role: 'user', content: '选一下' },
            {
              role: 'assistant',
              content: '好的',
              toolCalls: [
                {
                  id: 'c1',
                  name: 'ask_user',
                  arguments: JSON.stringify({
                    question: '用哪种？',
                    options: [
                      { label: '快', description: '省时' },
                      { label: '稳', recommended: true, description: '可靠' },
                    ],
                    multiSelect: false,
                    allowOther: false,
                  }),
                },
              ],
            },
            { role: 'tool', toolCallId: 'c1', toolName: 'ask_user', content: 'The user answered "用哪种？".\nSelected: 稳' },
          ],
          running: false,
        },
      }),
  })
  const { window } = dom
  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)
    await waitFor(() => document.querySelector('#inner .ask-card') !== null)
    const card = document.querySelector('#inner .ask-card') as HTMLElement
    assert.equal(card.dataset.state, 'answered')
    assert.equal(card.querySelector('.ask-status'), null, 'restored answered cards leave no footer status')
    const checked = [...card.querySelectorAll<HTMLInputElement>('.ask-opt input')].find((node) => node.checked)
    assert.equal(checked?.value, '稳')
    for (const input of card.querySelectorAll<HTMLInputElement>('.ask-opt input')) {
      assert.equal(input.disabled, true, 'history cards are read-only')
    }
    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('history renders image parts and keeps the text alongside them', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) =>
      stubFetch(window, {
        sessionPayload: {
          meta: { id: 's1' },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '看看这张图' },
                { type: 'image', mimeType: 'image/png', data: PNG },
              ],
            },
            { role: 'assistant', content: '看到了' },
          ],
          running: false,
        },
      }),
  })
  const { window } = dom
  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)
    await waitFor(() => document.querySelectorAll('#inner .msg.user .msg-images img').length === 1)

    const bubble = document.querySelector('#inner .msg.user .bubble') as HTMLElement
    assert.match(bubble.textContent ?? '', /看看这张图/, 'the text part should stay visible')
    const link = bubble.querySelector('.msg-images a') as HTMLAnchorElement
    assert.ok(link !== null, 'images should render in a thumbnail grid')
    assert.equal(link.href, `data:image/png;base64,${PNG}`, 'the thumbnail points at the data URL')
    assert.equal(link.getAttribute('aria-label'), '查看图片 1')
    assert.equal((link.querySelector('img') as HTMLImageElement).alt, '附件图片 1')
    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('sidebar session menu renames, forks and deletes with confirmation', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) => stubFetch(window),
  })
  const { window } = dom
  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#sessions .session').length > 0)

    const row = () => document.querySelector('#sessions .session-row') as HTMLElement
    const moreButton = () => row().querySelector('.session-more') as HTMLButtonElement
    const menuButton = (label: string) =>
      [...row().querySelectorAll('.session-menu button')].find((button) => button.textContent === label) as
        | HTMLButtonElement
        | undefined

    moreButton().click()
    const menu = row().querySelector('.session-menu') as HTMLElement
    assert.equal(menu.hidden, false, 'the session menu should open')

    menuButton('重命名')?.click()
    const input = row().querySelector('.session .t input') as HTMLInputElement
    assert.ok(input !== null, 'renaming should turn the title into an input')
    assert.equal(input.value, 'demo')
    input.value = '改名后的会话'
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await waitFor(() => (document.querySelector('#sessions .session .t')?.textContent ?? '') === '改名后的会话')

    moreButton().click()
    menuButton('新建分支')?.click()
    await waitFor(() => document.querySelectorAll('#sessions .session').length === 2)
    await waitFor(() => (document.querySelector('#sessions .session.active .t')?.textContent ?? '') === '改名后的会话 · 分支')
    assert.equal((document.querySelector('#inner')?.textContent ?? '').includes('统计文件'), true, 'a full fork keeps the copied history')
    assert.equal((document.querySelector('#inner')?.querySelectorAll('.msg').length ?? 0) > 0, true)

    const activeRow = [...document.querySelectorAll('#sessions .session-row')].find(
      (item) => item.querySelector('.session.active') !== null,
    ) as HTMLElement | undefined
    const activeMore = activeRow?.querySelector('.session-more') as HTMLButtonElement | undefined
    assert.ok(activeMore !== undefined)
    activeMore.click()
    const remove = [...(activeRow?.querySelectorAll('.session-menu button') ?? [])].find(
      (button) => button.textContent === '删除会话',
    ) as HTMLButtonElement | undefined
    assert.ok(remove !== undefined)
    remove.click()
    assert.equal(remove.textContent, '确认删除', 'deleting needs a second click')
    remove.click()
    await waitFor(() => document.querySelectorAll('#sessions .session').length === 1)
    await waitFor(() => (document.querySelector('#sessions .session.active .t')?.textContent ?? '') === '改名后的会话')

    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('a user message branches the conversation from before it', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))
  let forkBody: unknown

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) =>
      stubFetch(window, {
        sessionPayload: {
          meta: { id: 's1' },
          messages: [
            { role: 'user', content: '第一问' },
            { role: 'assistant', content: '答一' },
            { role: 'user', content: '第二问' },
            { role: 'assistant', content: '答二' },
          ],
          running: false,
        },
        onFork: (body) => {
          forkBody = body
        },
      }),
  })
  const { window } = dom
  try {
    const document = window.document
    // Each user message carries a plain branch button plus a rewind companion.
    await waitFor(() => document.querySelectorAll('#inner .msg.user .branch-btn:not(.rewind-btn)').length === 2)
    const first = document.querySelector('#inner .msg.user .branch-btn:not(.rewind-btn)') as HTMLButtonElement

    first.click()
    assert.deepEqual(forkBody, { keep: 0 })
    assert.equal((document.querySelector('#input') as HTMLTextAreaElement).value, '第一问', 'the branched message is prefilled')
    await waitFor(() => document.querySelectorAll('#sessions .session').length === 2)
    await waitFor(() => document.querySelectorAll('#inner .msg.user').length === 0)
    assert.match(document.querySelector('#sessions .session.active .t')?.textContent ?? '', /demo · 分支/)
    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('the rewind companion confirms before rewinding and reports changed files', async () => {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
  virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))
  const forkBodies: unknown[] = []

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:4173/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) =>
      stubFetch(window, {
        sessionPayload: {
          meta: { id: 's1' },
          messages: [
            { role: 'user', content: '第一问' },
            { role: 'assistant', content: '答一' },
            { role: 'user', content: '第二问' },
            { role: 'assistant', content: '答二' },
          ],
          running: false,
        },
        onFork: (body) => {
          forkBodies.push(body)
        },
      }),
  })
  const { window } = dom
  try {
    const document = window.document
    await waitFor(() => document.querySelectorAll('#inner .msg.user .rewind-btn').length === 2)
    const rewind = document.querySelector('#inner .msg.user .rewind-btn') as HTMLButtonElement

    rewind.click()
    assert.equal(forkBodies.length, 0, 'the first click only arms the action')
    assert.equal(rewind.classList.contains('armed'), true)
    assert.match(document.querySelector('#toast')?.textContent ?? '', /再次点击确认/)

    rewind.click()
    await waitFor(() => forkBodies.length === 1)
    assert.deepEqual(forkBodies[0], { keep: 0, restoreFiles: true })
    assert.equal((document.querySelector('#input') as HTMLTextAreaElement).value, '第一问')
    await waitFor(() => document.querySelectorAll('#sessions .session').length === 2)
    assert.match(document.querySelector('#toast')?.textContent ?? '', /已回滚文件并分支（3 个文件）/)
    assert.deepEqual(errors, [], errors.join('\n'))
  } finally {
    dom.window.close()
  }
})

test('the attach button follows the model image capability', async () => {
  const boot = async (imageInput: boolean) => {
    const errors: string[] = []
    const virtualConsole = new VirtualConsole()
    virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${String(error)}`))
    virtualConsole.on('error', (message) => errors.push(`console.error: ${String(message)}`))
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      url: 'http://localhost:4173/',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse: (window) => stubFetch(window, { imageInput }),
    })
    const { window } = dom
    await waitFor(() => window.document.querySelectorAll('#sessions .session').length > 0)
    return { window, document: window.document, errors, close: () => dom.window.close() }
  }

  const capable = await boot(true)
  try {
    const attach = capable.document.querySelector('#attach') as HTMLButtonElement
    const hint = capable.document.querySelector('#attach-hint') as HTMLElement
    assert.equal(attach.disabled, false)
    assert.equal(hint.hidden, true)
    assert.deepEqual(capable.errors, [], capable.errors.join('\n'))
  } finally {
    capable.close()
  }

  const textOnly = await boot(false)
  try {
    const attach = textOnly.document.querySelector('#attach') as HTMLButtonElement
    const hint = textOnly.document.querySelector('#attach-hint') as HTMLElement
    assert.equal(attach.disabled, true, 'attach must be disabled for text-only models')
    assert.match(attach.title, /未启用图片输入/)
    assert.equal(hint.hidden, false, 'the hint should explain why attaching is off')
    assert.match(hint.textContent ?? '', /图片/)
    assert.deepEqual(textOnly.errors, [], textOnly.errors.join('\n'))
  } finally {
    textOnly.close()
  }
})
