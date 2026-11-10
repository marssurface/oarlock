/** The wire vocabulary shared by every provider adapter and the agent core. */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON arguments exactly as the model produced them. */
  arguments: string
}

export interface TextPart {
  type: 'text'
  text: string
}

/** Inline image; `data` is base64 without the `data:` prefix. */
export interface ImagePart {
  type: 'image'
  mimeType: string
  data: string
}

export type ContentPart = TextPart | ImagePart

/** Plain text stays a string so old transcripts and tool messages are unchanged. */
export type MessageContent = string | ContentPart[]

export interface ChatMessage {
  role: Role
  content: MessageContent
  /** Reasoning text returned by reasoning models; never sent back on the wire. */
  reasoning?: string
  /** Assistant turn that requested tools. */
  toolCalls?: ToolCall[]
  /** Tool result correlation, required when role is `tool`. */
  toolCallId?: string
  toolName?: string
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}

export interface Usage {
  /** Total prompt/input tokens as billed (including cache hits). */
  promptTokens?: number
  /** Completion/output tokens, including reasoning tokens. */
  completionTokens?: number
  totalTokens?: number
  /** Prompt tokens served from the provider's prompt cache. */
  cachedTokens?: number
  /** Completion tokens spent on hidden reasoning, when the provider reports it. */
  reasoningTokens?: number
  /** True when the runtime estimated usage because the provider reported none. */
  estimated?: boolean
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error'

export type ProviderEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: FinishReason }

export interface ProviderRequest {
  messages: ChatMessage[]
  tools?: ToolSpec[]
  temperature?: number
  maxTokens?: number
  /**
   * Send this model name instead of the provider's default. Used for subagent
   * model tiering on the same gateway; absent means use the provider's model.
   */
  model?: string
  signal?: AbortSignal
}

/** One model backend. Adapters are stateless; the agent owns history. */
export interface ChatProvider {
  readonly id: string
  readonly model: string
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>
}

export class ProviderError extends Error {
  readonly status: number | undefined
  readonly body: string | undefined
  /** Server-suggested wait before the next attempt, parsed from `Retry-After` (milliseconds). */
  readonly retryAfterMs: number | undefined

  constructor(
    message: string,
    options: { status?: number; body?: string; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProviderError'
    this.status = options.status
    this.body = options.body
    this.retryAfterMs = options.retryAfterMs
  }
}

/**
 * Parse a `Retry-After` header (RFC 9110): either delta-seconds or an HTTP-date.
 * Returns milliseconds to wait, or undefined when absent/unparseable. Past
 * dates clamp to 0; garbage values never produce NaN.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | undefined {
  if (header === null || header === undefined) return undefined
  const value = header.trim()
  if (value === '') return undefined
  if (/^\d+$/.test(value)) {
    const seconds = Number(value)
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined
  }
  // Date.parse is far too lenient (it accepts "-5" as a date), so only the
  // three RFC 9110 HTTP-date shapes reach it: IMF-fixdate, RFC 850, asctime.
  const httpDate =
    /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/
  if (!httpDate.test(value)) return undefined
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return undefined
  return Math.max(0, timestamp - now)
}
