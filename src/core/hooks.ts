import { spawn } from 'node:child_process'

export type HookEvent = 'PreToolUse' | 'PostToolUse'

export interface HookDef {
  /** Tool name to match, or `*` for every tool (default). */
  matcher?: string
  /** Shell command run through `bash -c`; receives the event JSON on stdin. */
  command: string
  /** Per-hook timeout in ms (clamped to 1s-60s, default 15s). */
  timeoutMs?: number
}

export interface HooksConfig {
  PreToolUse: HookDef[]
  PostToolUse: HookDef[]
}

/**
 * The decision the harness acts on. `allow` only matters for PreToolUse (it
 * skips the interactive approval); `block` stops the call or flags the result;
 * `neutral` leaves everything as-is. `context` is stdout text fed back to the
 * model alongside the tool result.
 */
export interface HookOutcome {
  decision: 'allow' | 'block' | 'neutral'
  reason?: string
  context?: string
}

export interface HookCallInfo {
  tool_name: string
  tool_input: Record<string, unknown>
  tool_output?: string
  is_error?: boolean
}

const MAX_CAPTURE = 200_000
const DEFAULT_HOOK_TIMEOUT = 15_000
const MIN_HOOK_TIMEOUT = 1_000
const MAX_HOOK_TIMEOUT = 60_000

export function emptyHooks(): HooksConfig {
  return { PreToolUse: [], PostToolUse: [] }
}

/** Parse a `.agent/hooks.json` shape, ignoring unknown fields and bad entries. */
export function parseHooks(raw: unknown): HooksConfig {
  const config = emptyHooks()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return config
  const source = raw as Record<string, unknown>
  config.PreToolUse = parseDefs(source['PreToolUse'])
  config.PostToolUse = parseDefs(source['PostToolUse'])
  return config
}

function parseDefs(value: unknown): HookDef[] {
  if (!Array.isArray(value)) return []
  const defs: HookDef[] = []
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const command = typeof entry['command'] === 'string' ? entry['command'] : ''
    if (command.trim() === '') continue
    const def: HookDef = { command }
    const matcher = typeof entry['matcher'] === 'string' ? entry['matcher'].trim() : ''
    if (matcher !== '') def.matcher = matcher
    const timeoutMs = entry['timeoutMs']
    if (typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs > 0) def.timeoutMs = timeoutMs
    defs.push(def)
  }
  return defs
}

export function matchesHook(def: HookDef, toolName: string): boolean {
  const matcher = def.matcher ?? '*'
  return matcher === '*' || matcher === toolName
}

interface SpawnResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

function spawnHook(command: string, stdinJson: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolvePromise) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', CI: process.env['CI'] ?? '1' },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const killTree = (): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
    timer.unref()

    const onAbort = (): void => {
      aborted = true
      killTree()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({ code, stdout, stderr, timedOut, aborted })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      stderr += String(error)
      finish(null)
    })
    child.on('close', (code) => finish(code))

    child.stdin?.on('error', () => {
      // A hook that ignores stdin closes the pipe early; the exit code still decides.
    })
    child.stdin?.end(`${stdinJson}\n`)
  })
}

/** First non-empty line, trimmed; used for block reasons coming from stderr. */
function firstLine(text: string): string | undefined {
  const line = text
    .trim()
    .split('\n')[0]
    ?.trim()
  return line !== undefined && line !== '' ? line : undefined
}

function pickDecision(obj: Record<string, unknown>): 'allow' | 'block' | 'neutral' {
  const raw = typeof obj['decision'] === 'string' ? obj['decision'] : typeof obj['permissionDecision'] === 'string' ? obj['permissionDecision'] : ''
  const value = raw.trim().toLowerCase()
  if (value === 'block' || value === 'deny') return 'block'
  if (value === 'allow' || value === 'approve') return 'allow'
  return 'neutral'
}

function interpret(result: SpawnResult): HookOutcome {
  // An aborted or timed-out hook must not block the turn: fail open.
  if (result.aborted || result.timedOut) return { decision: 'neutral' }

  const out = result.stdout.trim()
  if (out.startsWith('{')) {
    try {
      const obj = JSON.parse(out) as Record<string, unknown>
      const decision = pickDecision(obj)
      const context = typeof obj['context'] === 'string' && obj['context'].trim() !== '' ? obj['context'].trim() : undefined
      if (decision === 'block') {
        const reason = typeof obj['reason'] === 'string' && obj['reason'].trim() !== '' ? obj['reason'].trim() : undefined
        return { decision: 'block', reason: reason ?? firstLine(result.stderr) ?? 'blocked by hook' }
      }
      return decision === 'allow'
        ? { decision: 'allow', ...(context !== undefined ? { context } : {}) }
        : { decision: 'neutral', ...(context !== undefined ? { context } : {}) }
    } catch {
      // malformed JSON falls through to exit-code semantics
    }
  }

  // Claude Code convention: exit code 2 blocks, and stderr is shown to the model.
  if (result.code === 2) return { decision: 'block', reason: firstLine(result.stderr) ?? firstLine(result.stdout) ?? 'blocked by hook' }
  // Any other non-zero exit is a broken hook, not a decision: fail open.
  if (result.code !== 0) return { decision: 'neutral' }
  return out.length > 0 ? { decision: 'neutral', context: out } : { decision: 'neutral' }
}

/**
 * Run every hook matching this tool for one event. Block wins over allow, allow
 * over neutral; contexts accumulate in order. Returns neutral without spawning
 * anything when no hook matches, so the default (no `.agent/hooks.json`) is free.
 */
export async function runHooks(
  event: HookEvent,
  defs: HookDef[],
  info: HookCallInfo,
  cwd: string,
  signal?: AbortSignal,
): Promise<HookOutcome> {
  const active = defs.filter((def) => matchesHook(def, info.tool_name))
  if (active.length === 0) return { decision: 'neutral' }

  const payload = JSON.stringify({ hook_event_name: event, cwd, ...info })
  let decision: HookOutcome['decision'] = 'neutral'
  let reason: string | undefined
  const contexts: string[] = []

  for (const def of active) {
    const timeoutMs = Math.min(MAX_HOOK_TIMEOUT, Math.max(MIN_HOOK_TIMEOUT, def.timeoutMs ?? DEFAULT_HOOK_TIMEOUT))
    const outcome = interpret(await spawnHook(def.command, payload, cwd, timeoutMs, signal))
    if (outcome.decision === 'block') {
      decision = 'block'
      reason ??= outcome.reason
    } else if (outcome.decision === 'allow' && decision !== 'block') {
      decision = 'allow'
    }
    if (outcome.context !== undefined) contexts.push(outcome.context)
  }

  return {
    decision,
    ...(reason !== undefined ? { reason } : {}),
    ...(contexts.length > 0 ? { context: contexts.join('\n') } : {}),
  }
}
