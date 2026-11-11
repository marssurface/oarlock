import type {
  ChatMessage,
  ChatProvider,
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

export interface GeminiOptions {
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

type Part = Record<string, unknown>
type Content = { role: string; parts: Part[] }

interface UsageMetadataWire {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
}

interface FunctionCallWire {
  name?: string
  args?: unknown
}

interface PartWire {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
  functionCall?: FunctionCallWire
  thought?: boolean
}

interface CandidateWire {
  content?: { parts?: PartWire[]; role?: string }
  finishReason?: string
}

interface ChunkWire {
  candidates?: CandidateWire[]
  usageMetadata?: UsageMetadataWire
  error?: { code?: number; message?: string; status?: string }
}

/**
 * Adapter for the Gemini `generateContent` / `streamGenerateContent` API. It
 * speaks Gemini's native wire format, so first-class `functionCall` /
 * `functionResponse` parts and `cachedContent` are available without the
 * OpenAI-compat translation layer.
 *
 * The runtime keeps the OpenAI-compatible format as its default; this adapter
 * is opt-in via `provider: 'gemini'`.
 */
export class GeminiProvider implements ChatProvider {
  readonly id: string
  readonly model: string
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof fetch
  private readonly bodyDefaults: Record<string, unknown>

  constructor(options: GeminiOptions) {
    this.id = options.id
    this.model = options.model
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetchImpl ?? fetch
    this.bodyDefaults = options.bodyDefaults ?? {}
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const model = request.model ?? this.model
    const { systemInstruction, contents } = toContents(request.messages)
    const body: Record<string, unknown> = {
      contents,
      ...(systemInstruction !== undefined ? { systemInstruction } : {}),
      ...(request.tools !== undefined && request.tools.length > 0
        ? { tools: [{ functionDeclarations: request.tools.map(toFunctionDeclaration) }] }
        : {}),
      generationConfig: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      },
      ...this.bodyDefaults,
    }

    let response: Response
    try {
      const url = this.baseUrl.endsWith('/models')
        ? `${this.baseUrl}/${model}:streamGenerateContent?alt=sse`
        : `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(this.apiKey !== undefined ? { 'x-goog-api-key': this.apiKey } : {}),
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
    // Gemini streams functionCall args as complete JSON in a single part, but
    // text arrives incrementally. We accumulate text deltas and collect tool
    // calls as they appear.
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
    let callIndex = 0

    for await (const data of readSseData(response.body)) {
      let chunk: ChunkWire
      try {
        chunk = JSON.parse(data) as ChunkWire
      } catch {
        continue
      }
      if (chunk.error !== undefined) {
        throw new ProviderError(`${this.id}: ${chunk.error.message ?? 'stream error'}`, { body: data })
      }
      if (chunk.usageMetadata !== undefined) usage = mapUsage(chunk.usageMetadata)

      const candidate = chunk.candidates?.[0]
      if (candidate === undefined) continue

      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          if (part.thought === true) {
            yield { type: 'reasoning-delta', text: part.text }
          } else {
            yield { type: 'text-delta', text: part.text }
          }
        }
        if (part.functionCall !== undefined) {
          const call = part.functionCall
          callIndex += 1
          toolCalls.push({
            id: `call_${callIndex}_${Date.now().toString(36)}`,
            name: call.name ?? '',
            arguments: call.args !== undefined ? JSON.stringify(call.args) : '{}',
          })
        }
      }

      const reason = mapFinish(candidate.finishReason)
      if (reason !== undefined) finishReason = reason
    }

    for (const call of toolCalls) {
      if (call.name.length === 0) continue
      yield { type: 'tool-call', call }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    if (finishReason === 'stop' && toolCalls.length > 0) finishReason = 'tool_calls'
    yield { type: 'done', finishReason }
  }
}

/**
 * Gemini carries the system prompt in `systemInstruction` and everything else
 * in `contents` as alternating user/model turns. Tool results become
 * `functionResponse` parts inside a user turn.
 */
function toContents(messages: ChatMessage[]): { systemInstruction: Content | undefined; contents: Content[] } {
  const systemParts: string[] = []
  const out: Content[] = []
  let userAcc: Part[] | undefined

  const pushUser = (parts: Part[]): void => {
    if (userAcc === undefined) {
      userAcc = [...parts]
    } else {
      userAcc.push(...parts)
    }
  }
  const closeUser = (): void => {
    if (userAcc !== undefined && userAcc.length > 0) {
      out.push({ role: 'user', parts: userAcc })
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
      const parts: Part[] = []
      const text = textOf(message.content)
      if (text.length > 0) parts.push({ text })
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: safeJson(call.arguments) } })
      }
      out.push({ role: 'model', parts })
      continue
    }
    if (message.role === 'user') {
      const parts: Part[] = []
      const text = textOf(message.content)
      if (text.length > 0) parts.push({ text })
      for (const image of imagesOf(message.content)) parts.push(toInlineData(image))
      pushUser(parts)
      continue
    }
    // role === 'tool' → functionResponse inside the current user turn
    pushUser([
      {
        functionResponse: {
          name: message.toolName ?? '',
          response: { result: textOf(message.content) },
        },
      },
    ])
  }
  closeUser()
  const systemInstruction = systemParts.length > 0 ? { role: 'user', parts: [{ text: systemParts.join('\n\n') }] } : undefined
  return { systemInstruction, contents: out }
}

function toFunctionDeclaration(spec: ToolSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  }
}

function toInlineData(image: ImagePart): Part {
  return { inlineData: { mimeType: image.mimeType, data: image.data } }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

function mapUsage(usage: UsageMetadataWire): Usage {
  const out: Usage = {}
  if (usage.promptTokenCount !== undefined) out.promptTokens = usage.promptTokenCount
  if (usage.candidatesTokenCount !== undefined) out.completionTokens = usage.candidatesTokenCount
  if (usage.totalTokenCount !== undefined) out.totalTokens = usage.totalTokenCount
  if (usage.cachedContentTokenCount !== undefined) out.cachedTokens = usage.cachedContentTokenCount
  if (usage.thoughtsTokenCount !== undefined) out.reasoningTokens = usage.thoughtsTokenCount
  return out
}

function mapFinish(reason: string | undefined): FinishReason | undefined {
  if (reason === 'STOP') return 'stop'
  if (reason === 'MAX_TOKENS') return 'length'
  return undefined
}
