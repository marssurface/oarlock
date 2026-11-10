import type { ChatProvider, ProviderEvent, ProviderRequest } from './types.ts'
import { imagesOf, textOf } from './content.ts'

export type MockScript = (request: ProviderRequest) => ProviderEvent[] | Promise<ProviderEvent[]>

export interface MockProviderOptions {
  model?: string
  /** Full control for tests: return the exact event sequence. */
  script?: MockScript
}

function lastUser(request: ProviderRequest): { text: string; images: number } {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message !== undefined && message.role === 'user') {
      return { text: textOf(message.content), images: imagesOf(message.content).length }
    }
  }
  return { text: '', images: 0 }
}

function lastToolResult(request: ProviderRequest): { name: string; content: string } | undefined {
  const last = request.messages[request.messages.length - 1]
  if (last === undefined || last.role !== 'tool') return undefined
  return { name: last.toolName ?? 'tool', content: textOf(last.content) }
}

/**
 * The default script keeps the whole runtime runnable without an API key:
 * it streams a short answer, and `!tool <name> <json>` lets you drive one
 * tool call by hand to watch the loop work.
 */
export function demoScript(request: ProviderRequest): ProviderEvent[] {
  const toolResult = lastToolResult(request)
  if (toolResult !== undefined) {
    const preview = toolResult.content.length > 600 ? `${toolResult.content.slice(0, 600)}…` : toolResult.content
    return [
      { type: 'text-delta', text: `（Mock）工具 ${toolResult.name} 返回了结果：\n\n${preview}\n` },
      { type: 'usage', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
      { type: 'done', finishReason: 'stop' },
    ]
  }

  const user = lastUser(request)
  const text = user.text.trim()
  const toolMatch = /^!tool\s+(\S+)\s*(\{[\s\S]*\})?$/.exec(text)
  if (toolMatch !== null && toolMatch[1] !== undefined) {
    return [
      { type: 'text-delta', text: `（Mock）调用工具 ${toolMatch[1]}。\n` },
      {
        type: 'tool-call',
        call: {
          id: `mock_call_${Date.now().toString(36)}`,
          name: toolMatch[1],
          arguments: toolMatch[2] ?? '{}',
        },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  }

  const images = user.images > 0 ? `（附带 ${user.images} 张图片）\n\n` : ''
  return [
    {
      type: 'text-delta',
      text:
        '（Mock 模型）我收到了你的消息：\n\n' +
        `${images}${text.length > 0 ? text : '（空）'}\n\n` +
        '当前没有配置真实模型。在 .env 里填 DEEPSEEK_API_KEY 后重启即可接入；' +
        '想先看工具调用，可以发送 `!tool list_files {"path":"."}`。',
    },
    { type: 'usage', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    { type: 'done', finishReason: 'stop' },
  ]
}

/** Deterministic provider used by tests and by the offline demo. */
export class MockProvider implements ChatProvider {
  readonly id = 'mock'
  readonly model: string
  private readonly script: MockScript

  constructor(options: MockProviderOptions = {}) {
    this.model = options.model ?? 'mock-1'
    this.script = options.script ?? demoScript
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    for (const event of await this.script(request)) {
      if (request.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
      yield event
    }
  }
}
