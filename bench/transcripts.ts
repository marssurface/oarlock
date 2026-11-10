import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ChatProvider, ProviderEvent, ProviderRequest } from '../src/providers/types.ts'
import { ProviderError } from '../src/providers/types.ts'
import { imagesOf, textOf } from '../src/providers/content.ts'

export interface RecordedError {
  message: string
  status?: number
}

export interface RecordedStream {
  /** Hash of the request that produced these events (workspace paths normalized). */
  fingerprint: string
  events: ProviderEvent[]
  error?: RecordedError
}

export interface Transcript {
  version: 1
  task: string
  provider: string
  model: string
  createdAt: string
  streams: RecordedStream[]
}

/**
 * Requests are compared by structure, not by absolute paths: the benchmark
 * runs each task in a fresh temp directory, so the workspace path is folded
 * into `<cwd>` on both sides.
 */
export function fingerprintRequest(request: ProviderRequest, cwd?: string): string {
  const normalize = (text: string): string =>
    cwd !== undefined && cwd.length > 0 ? text.split(cwd).join('<cwd>') : text
  const payload = {
    messages: request.messages.map((message) => ({
      role: message.role,
      content: normalize(textOf(message.content)),
      // Images are compared by shape, not bytes: fingerprints stay small and
      // stable while still catching a dropped or resized attachment.
      images: imagesOf(message.content).map((image) => ({
        mimeType: image.mimeType,
        bytes: image.data.length,
      })),
      toolCalls: message.toolCalls?.map((call) => ({
        name: call.name,
        arguments: normalize(call.arguments),
        id: call.id,
      })),
      toolCallId: message.toolCallId ?? null,
      toolName: message.toolName ?? null,
    })),
    tools: request.tools?.map((tool) => tool.name) ?? [],
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
  }
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

/** Wraps a live provider and keeps every completed stream so it can be replayed. */
export class RecordingProvider implements ChatProvider {
  readonly id: string
  readonly model: string
  private readonly inner: ChatProvider
  private readonly cwd: string | undefined
  private readonly streams: RecordedStream[] = []

  constructor(inner: ChatProvider, options: { cwd?: string } = {}) {
    this.inner = inner
    this.id = inner.id
    this.model = inner.model
    this.cwd = options.cwd
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const fingerprint = fingerprintRequest(request, this.cwd)
    const events: ProviderEvent[] = []
    let failure: RecordedError | undefined
    try {
      for await (const event of this.inner.stream(request)) {
        events.push(event)
        yield event
      }
    } catch (error) {
      failure = {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ProviderError && error.status !== undefined ? { status: error.status } : {}),
      }
      throw error
    } finally {
      this.streams.push({ fingerprint, events, ...(failure !== undefined ? { error: failure } : {}) })
    }
  }

  toTranscript(meta: { task: string; provider: string; model: string }): Transcript {
    return {
      version: 1,
      task: meta.task,
      provider: meta.provider,
      model: meta.model,
      createdAt: new Date().toISOString(),
      streams: this.streams,
    }
  }
}

/** Replays a transcript with no network and no API key. */export class ReplayProvider implements ChatProvider {
  readonly id = 'replay'
  readonly model: string
  private readonly transcript: Transcript
  private readonly cwd: string | undefined
  private index = 0

  constructor(transcript: Transcript, options: { cwd?: string } = {}) {
    this.transcript = transcript
    this.cwd = options.cwd
    this.model = `${transcript.model} (replay)`
  }

  /** Streams consumed so far, for diagnostics. */
  get consumed(): number {
    return this.index
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const record = this.transcript.streams[this.index]
    if (record === undefined) {
      throw new Error(
        `replay: model requested call #${this.index + 1} but the transcript only has ${this.transcript.streams.length}`,
      )
    }
    const actual = fingerprintRequest(request, this.cwd)
    if (actual !== record.fingerprint) {
      throw new Error(
        `replay drift at call ${this.index + 1}: the request changed since recording ` +
          `(prompt, tool set or fixture differ). Re-record with --record.`,
      )
    }
    this.index += 1
    for (const event of record.events) {
      if (request.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
      yield event
    }
    if (record.error !== undefined) {
      throw new ProviderError(record.error.message, {
        ...(record.error.status !== undefined ? { status: record.error.status } : {}),
      })
    }
  }
}

export function loadTranscript(file: string): Transcript {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Transcript
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.streams)) {
    throw new Error(`not a dock-agent transcript: ${file}`)
  }
  return parsed
}
