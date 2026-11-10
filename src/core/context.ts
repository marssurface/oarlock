import type { ChatMessage, ChatProvider, ToolSpec, Usage } from '../providers/types.ts'
import { imagesOf, textOf } from '../providers/content.ts'
import { completeText } from './complete.ts'
import { estimatedUsage } from './usage.ts'

export interface ContextOptions {
  /** Model context size in tokens. */
  window: number
  /** Compact when the estimate passes window × threshold. */
  threshold: number
  /** Newest messages kept verbatim after compaction. */
  keepRecent: number
  /** Per-message cap while serializing history for the summary call. */
  maxMessageChars: number
}

export const DEFAULT_CONTEXT: ContextOptions = {
  window: 65536,
  threshold: 0.75,
  keepRecent: 10,
  maxMessageChars: 3000,
}

const SUMMARY_PROMPT = [
  'You compress an agent conversation into a handover summary.',
  'Keep: the user goals, constraints and preferences; decisions made; files and paths touched;',
  'commands run and their outcomes; errors and unresolved questions.',
  'Drop pleasantries and repeated tool output. Write at most 300 words,',
  'in the same language the user writes in. Return only the summary.',
].join(' ')

/** Rough tokenizer-free estimate: CJK glyphs cost about one token, latin text a quarter. */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xffef)
    if (wide) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

export interface CompactionResult {
  /** Replacement conversation: summary system message followed by kept messages. */
  messages: ChatMessage[]
  summary: string
  beforeTokens: number
  afterTokens: number
  removedMessages: number
  /** Tokens spent generating the summary (measured or estimated). */
  usage?: Usage
  /** Wall-clock time spent on the summary request. */
  durationMs: number
}

/**
 * A high-detail image costs roughly 1–1.5k prompt tokens on the common
 * gateways; without dimensions we use a flat estimate so budgets stay honest.
 */
const IMAGE_TOKENS = 1200

function serialize(messages: ChatMessage[], maxChars: number): string {
  const parts: string[] = []
  for (const message of messages) {
    const text = textOf(message.content)
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
    const images = imagesOf(message.content).map((image) => `[image: ${image.mimeType}]`).join(' ')
    const body = images.length > 0 ? `${clipped}${clipped.length > 0 ? ' ' : ''}${images}` : clipped
    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      const calls = message.toolCalls.map((call) => `${call.name}(${call.arguments.slice(0, 300)})`).join(', ')
      parts.push(`assistant: ${body}\n[tool calls: ${calls}]`)
    } else if (message.role === 'tool') {
      parts.push(`tool(${message.toolName ?? '?'}): ${body}`)
    } else {
      parts.push(`${message.role}: ${body}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * Keeps a conversation under a token budget:
 * estimate → summarize the older prefix → keep the recent tail verbatim.
 */
export class ContextManager {
  readonly options: ContextOptions

  constructor(options: Partial<ContextOptions> = {}) {
    this.options = { ...DEFAULT_CONTEXT, ...options }
  }

  estimate(messages: ChatMessage[], tools?: ToolSpec[]): number {
    let total = 0
    for (const message of messages) {
      total += 4
      total += estimateTokens(textOf(message.content))
      total += imagesOf(message.content).length * IMAGE_TOKENS
      if (message.toolCalls !== undefined) {
        for (const call of message.toolCalls) {
          total += estimateTokens(call.name) + estimateTokens(call.arguments) + 4
        }
      }
    }
    if (tools !== undefined && tools.length > 0) total += estimateTokens(JSON.stringify(tools))
    return total
  }

  needsCompaction(messages: ChatMessage[], tools?: ToolSpec[]): boolean {
    return this.estimate(messages, tools) > this.options.window * this.options.threshold
  }

  async compact(
    conversation: ChatMessage[],
    provider: ChatProvider,
    signal?: AbortSignal,
    options: { force?: boolean; model?: string } = {},
  ): Promise<CompactionResult | undefined> {
    // `force` is the overflow fallback: keep a shorter tail than the normal
    // threshold, because the heuristic estimate already undershot the window.
    const keepRecent = options.force === true ? Math.min(this.options.keepRecent, 4) : this.options.keepRecent
    if (conversation.length <= keepRecent + (options.force === true ? 1 : 2)) return undefined

    let cut = conversation.length - keepRecent
    while (cut > 0) {
      const message = conversation[cut]
      if (message === undefined || message.role !== 'tool') break
      cut -= 1
    }
    if (cut <= 1) return undefined

    const prefix = conversation.slice(0, cut)
    const suffix = conversation.slice(cut)
    const beforeTokens = this.estimate(conversation)
    const summaryRequest = serialize(prefix, this.options.maxMessageChars)
    const startedAt = Date.now()

    let summary = ''
    let usage: Usage | undefined
    try {
      const result = await completeText(provider, {
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: summaryRequest },
        ],
        temperature: 0,
        maxTokens: 800,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      summary = result.text
      usage = result.usage
    } catch (error) {
      if (signal?.aborted === true) throw error
      summary = ''
    }

    if (summary.length === 0) {
      summary = `（前 ${prefix.length} 条消息已因上下文限制被移出，未能生成摘要。）`
    }
    if (usage === undefined && summary.length > 0) {
      // Keep token accounting complete even when the gateway omits usage.
      usage = estimatedUsage(
        estimateTokens(SUMMARY_PROMPT) + estimateTokens(summaryRequest),
        estimateTokens(summary),
      )
    }

    const replacement: ChatMessage = {
      role: 'system',
      content: `[Earlier conversation summary]\n${summary}`,
    }
    const messages = [replacement, ...suffix]
    return {
      messages,
      summary,
      beforeTokens,
      afterTokens: this.estimate(messages),
      removedMessages: prefix.length,
      durationMs: Date.now() - startedAt,
      ...(usage !== undefined ? { usage } : {}),
    }
  }
}
