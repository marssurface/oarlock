import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ChatProvider, ProviderEvent, ProviderRequest } from './types.ts'
import { ProviderError } from './types.ts'

/**
 * Opt-in runtime recording for gateway debugging. Unlike bench/transcripts
 * (fingerprinted streams for deterministic replay), this dumps the full
 * request and every raw event of each model call as one readable JSON file.
 * It never feeds back into the agent: write failures are fail-open.
 */

export interface DebugRecording {
  version: 1
  at: string
  provider: string
  /** Effective model for this call (request override or provider default). */
  model: string
  durationMs: number
  /** The request minus its AbortSignal; image parts keep their base64 data. */
  request: Omit<ProviderRequest, 'signal'>
  events: ProviderEvent[]
  error?: { message: string; status?: number; retryAfterMs?: number }
}

/**
 * `AGENT_RECORD=1` records into `<cwd>/.agent/recordings`;
 * `AGENT_RECORD_DIR=<path>` enables recording and overrides the directory
 * (relative paths resolve against cwd). Read on every runtime build so a
 * settings-triggered rebuild picks the switch up without a restart.
 */
export function recordingTarget(cwd: string): string | undefined {
  const override = process.env['AGENT_RECORD_DIR']
  if (override !== undefined && override !== '') return resolve(cwd, override)
  if (process.env['AGENT_RECORD'] === '1') return resolve(cwd, '.agent', 'recordings')
  return undefined
}

let sequence = 0
let announced = false
let writeWarned = false

function fileName(): string {
  sequence += 1
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(sequence).padStart(4, '0')}.json`
}

/** Wraps a provider and dumps one JSON file per completed (or failed) call. */
export class DebugRecordingProvider implements ChatProvider {
  readonly id: string
  readonly model: string
  private readonly inner: ChatProvider
  private readonly dir: string

  constructor(inner: ChatProvider, dir: string) {
    this.inner = inner
    this.id = inner.id
    this.model = inner.model
    this.dir = dir
    if (!announced) {
      announced = true
      process.stderr.write(`[oarlock] 模型调用录制已开启 → ${dir}\n`)
    }
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const startedAt = Date.now()
    const events: ProviderEvent[] = []
    let failure: DebugRecording['error']
    try {
      for await (const event of this.inner.stream(request)) {
        events.push(event)
        yield event
      }
    } catch (error) {
      failure = {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ProviderError && error.status !== undefined ? { status: error.status } : {}),
        ...(error instanceof ProviderError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      }
      throw error
    } finally {
      const { signal: _signal, ...wire } = request
      const recording: DebugRecording = {
        version: 1,
        at: new Date(startedAt).toISOString(),
        provider: this.id,
        model: request.model ?? this.model,
        durationMs: Date.now() - startedAt,
        request: wire,
        events,
        ...(failure !== undefined ? { error: failure } : {}),
      }
      try {
        await mkdir(this.dir, { recursive: true })
        await writeFile(join(this.dir, fileName()), `${JSON.stringify(recording, null, 2)}\n`, 'utf8')
      } catch (error) {
        // Debug dumps must never break a turn; say so once, then stay quiet.
        if (!writeWarned) {
          writeWarned = true
          process.stderr.write(`[oarlock] 录制写盘失败（不影响对话）：${(error as Error).message}\n`)
        }
      }
    }
  }
}