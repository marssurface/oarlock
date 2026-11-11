import type {
  ChatMessage,
  ChatProvider,
  ContentPart,
  FinishReason,
  ImagePart,
  ProviderEvent,
  ProviderRequest,
  ToolSpec,
  Usage,
} from './types.ts'
import { ProviderError, parseRetryAfterMs } from './types.ts'
import { imagesOf, textOf } from './content.ts'
import { readSseData } from './openai-compatible.ts'

export interface AnthropicOptions {
  id: string
  baseUrl: string
  model: string
  apiKey?: string
  headers?: Record<string, string>
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Extra request-body fields merged last (provider flags). */
  bodyDefaults?: Record<string, unknown>
}

type ContentBlock = Record<string, unknown>

interface UsageWire {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  server_tool_use?: { web_requests?: number }
}

interface MessageStartWire {
  type: 'message_start'
  message?: { usage?: UsageWire }
}
interface ContentBlockStart {
  type: 'content_block_start'
  index?: number
  content_block?: { type?: string; id?: string; name?: string; input?: unknown }
}
interface ContentBlockDelta {
  type: 'content_block_delta'
  index?: number
  delta?:
    | { type: 'text_delta'; text?: string }
    | { type: 'input_json_delta'; partial_json?: string }
    | { type: 'thinking_delta'; thinking?: string }
}
interface ContentBlockStop {
  type: 'content_block_stop'
  index?: number
}
interface MessageDelta {
  type: 'message_delta'
  delta?: { stop_reason?: string | null }
  usage?: UsageWire
}
interface MessageStop {
  type: 'message_stop'
}
interface ErrorEvent {
  type: 'error'
  error?: { type?: string; message?: string }
}

type WireEvent =
  | MessageStartWire
  | ContentBlockStart
  | ContentBlockDelta
  | ContentBlockStop
  | MessageDelta
  | MessageStop
  | ErrorEvent
  | Record<string, unknown>

/**
 * Adapter for the Anthropic Messages API (`/v1/messages`) and gateways that
 * mirror it. It speaks Anthropic's native wire format, so prompt cache
 * (`cache_control`) and first-class tool_use blocks are available without the
 * OpenAI-compat translation layer.
 *
 * The runtime keeps the OpenAI-compatible format as its default; this adapter
 * is opt-in via `provider: 'anthropic'`.
 */
export class AnthropicProvider implements ChatProvider {
  readonly id: string
  readonly model: string
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof fetch
  private readonly bodyDefaults: Record<string, unknown>

  constructor(options: AnthropicOptions) {
    this.id = options.id
    this.model = options.model
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetchImpl ?? fetch
    this.bodyDefaults = options.bodyDefaults ?? {}
  }

  private endpoint(): string {
    return this.baseUrl.endsWith('/messages') ? this.baseUrl : `${this.baseUrl}/messages`
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const { system, messages } = splitSystem(request.messages)
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      stream: true,
      ...(system !== undefined && system !== '' ? { system } : {}),
      ...(request.tools !== undefined && request.tools.length > 0 ? { tools: request.tools.map(toTool) } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...this.bodyDefaults,
    }

    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(this.apiKey !== undefined ? { 'x-api-key': this.apiKey } : {}),
          'anthropic-version': '2023-06-01',
          ...this.headers,
        },
        body: JSON.stringify(body),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      })
    } catch (error) {
      throw new ProviderError(`${this.id}: request failed`, { cause: error })
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ProviderError(`${this.id}: HTTP ${response.status}`, {
        status: response.status,
        body: text.slice(0, 2000),
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      })
    }
    if (response.body === null) throw new ProviderError(`${this.id}: response has no body`)

    let finishReason: FinishReason = 'stop'
    let usage: Usage | undefined
    // The current tool_use block we are streaming input_json_delta into, by index.
    const toolBlocks = new Map<number, { id: string; name: string; input: string }>()
    let activeToolIndex: number | undefined

    for await (const data of readSseData(response.body)) {
      let event: WireEvent
      try {
        event = JSON.parse(data) as WireEvent
      } catch {
        continue
      }
      const type = (event as { type?: string }).type ?? ''

      if (type === 'error') {
        const errorEvent = event as ErrorEvent
        throw new ProviderError(`${this.id}: ${errorEvent.error?.message ?? 'stream error'}`, { body: data })
      }

      if (type === 'message_start') {
        const start = event as MessageStartWire
        if (start.message?.usage !== undefined) usage = mapUsage(start.message.usage)
        continue
      }

      if (type === 'content_block_start') {
        const start = event as ContentBlockStart
        const index = start.index ?? 0
        if (start.content_block?.type === 'tool_use') {
          toolBlocks.set(index, {
            id: start.content_block.id ?? '',
            name: start.content_block.name ?? '',
            input: typeof start.content_block.input === 'string' ? start.content_block.input : '',
          })
          activeToolIndex = index
        }
        continue
      }

      if (type === 'content_block_delta') {
        const delta = event as ContentBlockDelta
        const inner = delta.delta
        if (inner === undefined) continue
        if (inner.type === 'text_delta' && typeof inner.text === 'string' && inner.text.length > 0) {
          yield { type: 'text-delta', text: inner.text }
        } else if (inner.type === 'thinking_delta' && typeof inner.thinking === 'string' && inner.thinking.length > 0) {
          yield { type: 'reasoning-delta', text: inner.thinking }
        } else if (inner.type === 'input_json_delta' && typeof inner.partial_json === 'string' && activeToolIndex !== undefined) {
          const current = toolBlocks.get(activeToolIndex)
          if (current !== undefined) current.input += inner.partial_json
        }
        continue
      }

      if (type === 'content_block_stop') {
        activeToolIndex = undefined
        continue
      }

      if (type === 'message_delta') {
        const delta = event as MessageDelta
        const stopReason = delta.delta?.stop_reason
        if (stopReason === 'end_turn') finishReason = 'stop'
        else if (stopReason === 'tool_use') finishReason = 'tool_calls'
        else if (stopReason === 'max_tokens') finishReason = 'length'
        if (delta.usage !== undefined) usage = mergeUsage(usage, delta.usage)
        continue
      }

      if (type === 'message_stop') {
        break
      }
    }

    // Emit tool calls in block order.
    const sorted = [...toolBlocks.entries()].sort((left, right) => left[0] - right[0])
    for (const [, block] of sorted) {
      if (block.name.length === 0) continue
      yield {
        type: 'tool-call',
        call: {
          id: block.id.length > 0 ? block.id : `toolu_${Date.now().toString(36)}`,
          name: block.name,
          arguments: block.input.length > 0 ? block.input : '{}',
        },
      }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    if (finishReason === 'stop' && sorted.length > 0) finishReason = 'tool_calls'
    yield { type: 'done', finishReason }
  }
}

/**
 * Anthropic carries the system string separately; every other message becomes
 * an alternating user/assistant turn of content blocks. Tool results land in a
 * user turn alongside any text/images the user sent.
 */
function splitSystem(messages: ChatMessage[]): { system: string | undefined; messages: ContentBlock[][] } {
  const systemParts: string[] = []
  const out: ContentBlock[][] = []
  // Accumulator for the current user turn. A user message with text/images and
  // the following tool results must merge into one user turn, otherwise
  // adjacent tool_result blocks get split across multiple user messages.
  let userAcc: ContentBlock[] | undefined

  const pushUser = (blocks: ContentBlock[]): void => {
    if (userAcc === undefined) {
      userAcc = [...blocks]
    } else {
      userAcc.push(...blocks)
    }
  }
  const closeUser = (): void => {
    if (userAcc !== undefined && userAcc.length > 0) {
      out.push(userAcc)
      userAcc = undefined
    }
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const text = textOf(message.content)
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (message.role === 'assistant') {
      closeUser()
      const blocks: ContentBlock[] = []
      const text = textOf(message.content)
      if (text.length > 0) blocks.push({ type: 'text', text })
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: safeJson(call.arguments) })
      }
      out.push(blocks)
      continue
    }
    if (message.role === 'user') {
      const blocks: ContentBlock[] = []
      const text = textOf(message.content)
      if (text.length > 0) blocks.push({ type: 'text', text })
      for (const image of imagesOf(message.content)) blocks.push(toImageBlock(image))
      pushUser(blocks)
      continue
    }
    // role === 'tool' → tool_result inside the current user turn
    pushUser([
      {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: textOf(message.content),
      },
    ])
  }
  closeUser()
  return { system: systemParts.join('\n\n') || undefined, messages: out }
}

function toTool(spec: ToolSpec): ContentBlock {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  }
}

function toImageBlock(image: ImagePart): ContentBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: image.mimeType, data: image.data },
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

function mapUsage(usage: UsageWire): Usage {
  const promptTokens = usage.input_tokens
  const completionTokens = usage.output_tokens
  const cached = usage.cache_read_input_tokens
  const out: Usage = {}
  if (promptTokens !== undefined) out.promptTokens = promptTokens
  if (completionTokens !== undefined) out.completionTokens = completionTokens
  if (cached !== undefined) out.cachedTokens = cached
  return out
}

function mergeUsage(base: Usage | undefined, delta: UsageWire): Usage {
  const mapped = mapUsage(delta)
  if (base === undefined) return mapped
  const out: Usage = {}
  if (mapped.promptTokens !== undefined) out.promptTokens = mapped.promptTokens
  else if (base.promptTokens !== undefined) out.promptTokens = base.promptTokens
  if (mapped.completionTokens !== undefined) out.completionTokens = mapped.completionTokens
  else if (base.completionTokens !== undefined) out.completionTokens = base.completionTokens
  if (mapped.cachedTokens !== undefined) out.cachedTokens = mapped.cachedTokens
  else if (base.cachedTokens !== undefined) out.cachedTokens = base.cachedTokens
  return out
}
