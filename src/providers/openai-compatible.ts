import type {
  ChatMessage,
  ChatProvider,
  ContentPart,
  FinishReason,
  MessageContent,
  ProviderEvent,
  ProviderRequest,
  ToolSpec,
  Usage,
} from './types.ts'
import { ProviderError, parseRetryAfterMs } from './types.ts'
import { imageDataUrl, textOf } from './content.ts'

export interface OpenAICompatibleOptions {
  id: string
  baseUrl: string
  model: string
  apiKey?: string
  headers?: Record<string, string>
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Extra request-body fields merged last (reasoning knobs, provider flags). */
  bodyDefaults?: Record<string, unknown>
}

interface WireToolCall {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface WireDelta {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: WireToolCall[]
}

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  /** DeepSeek reports prompt-cache hits explicitly. */
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  /** OpenAI and most compatible gateways put cached tokens under details. */
  prompt_tokens_details?: { cached_tokens?: number } | null
  completion_tokens_details?: { reasoning_tokens?: number } | null
  /** Some gateways pass Anthropic-style cache fields through unchanged. */
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface WireChunk {
  choices?: Array<{ index?: number; delta?: WireDelta; finish_reason?: string | null }>
  /** Gateways send `usage: null` on every chunk until the final one. */
  usage?: WireUsage | null
  error?: { message?: string; type?: string }
}

/** Yield each SSE `data:` payload, one line at a time. */
export async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart()
          if (data.length > 0) yield data
        }
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    const tail = buffer.replace(/\r$/, '')
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trimStart()
      if (data.length > 0) yield data
    }
  } finally {
    reader.releaseLock()
  }
}

/** Text stays a single string; image parts become OpenAI `image_url` data URLs. */
function toWireContent(content: MessageContent): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  return content.map((part: ContentPart) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: imageDataUrl(part) } },
  )
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: textOf(message.content) }
  }
  if (message.role === 'assistant') {
    const wire: Record<string, unknown> = { role: 'assistant', content: textOf(message.content) }
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      wire['tool_calls'] = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }))
    }
    return wire
  }
  return { role: message.role, content: toWireContent(message.content) }
}

function toWireTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}

function mapUsage(usage: WireUsage): Usage {
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.cache_read_input_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

function mapFinish(reason: string | null | undefined): FinishReason | undefined {
  if (reason === 'stop' || reason === 'tool_calls' || reason === 'length') return reason
  return undefined
}

/**
 * Adapter for every `/v1/chat/completions` service: DeepSeek, OpenAI,
 * Ollama, and any compatible gateway. It only knows the OpenAI wire format,
 * so provider-specific behaviour stays in configuration.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly id: string
  readonly model: string
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof fetch
  private readonly bodyDefaults: Record<string, unknown>

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id
    this.model = options.model
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetchImpl ?? fetch
    this.bodyDefaults = options.bodyDefaults ?? {}
  }

  private endpoint(): string {
    return this.baseUrl.endsWith('/chat/completions') ? this.baseUrl : `${this.baseUrl}/chat/completions`
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      messages: request.messages.map(toWireMessage),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.tools !== undefined && request.tools.length > 0 ? { tools: request.tools.map(toWireTool) } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...this.bodyDefaults,
    }

    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(this.apiKey !== undefined ? { authorization: `Bearer ${this.apiKey}` } : {}),
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

    const partialCalls = new Map<number, { id: string; name: string; args: string }>()
    let finishReason: FinishReason = 'stop'
    let usage: Usage | undefined

    for await (const data of readSseData(response.body)) {
      if (data === '[DONE]') break
      let chunk: WireChunk
      try {
        chunk = JSON.parse(data) as WireChunk
      } catch {
        continue
      }
      if (chunk.error?.message !== undefined) {
        throw new ProviderError(`${this.id}: ${chunk.error.message}`, { body: data })
      }
      if (chunk.usage != null) usage = mapUsage(chunk.usage)

      const choice = chunk.choices?.[0]
      if (choice === undefined) continue
      const delta = choice.delta ?? {}

      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : delta.reasoning
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        yield { type: 'reasoning-delta', text: reasoning }
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text-delta', text: delta.content }
      }

      for (const wireCall of delta.tool_calls ?? []) {
        const index = wireCall.index ?? 0
        const current = partialCalls.get(index) ?? { id: '', name: '', args: '' }
        if (wireCall.id !== undefined && wireCall.id.length > 0) current.id = wireCall.id
        if (wireCall.function?.name !== undefined) current.name += wireCall.function.name
        if (wireCall.function?.arguments !== undefined) current.args += wireCall.function.arguments
        partialCalls.set(index, current)
      }

      const finish = mapFinish(choice.finish_reason)
      if (finish !== undefined) finishReason = finish
    }

    for (const [index, call] of [...partialCalls.entries()].sort((left, right) => left[0] - right[0])) {
      if (call.name.length === 0) continue
      yield {
        type: 'tool-call',
        call: {
          id: call.id.length > 0 ? call.id : `call_${index}_${Date.now().toString(36)}`,
          name: call.name,
          arguments: call.args.length > 0 ? call.args : '{}',
        },
      }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    if (finishReason === 'stop' && partialCalls.size > 0) finishReason = 'tool_calls'
    yield { type: 'done', finishReason }
  }
}
