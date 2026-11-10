import type { ChatProvider, ProviderRequest, Usage } from '../providers/types.ts'
import { normalizeUsage } from './usage.ts'

export interface CompletionResult {
  text: string
  /** Usage reported by the provider for this internal request, if any. */
  usage?: Usage
}

/** Non-streaming helper for internal calls (compaction, titles, subagent checks). */
export async function completeText(provider: ChatProvider, request: ProviderRequest): Promise<CompletionResult> {
  let text = ''
  let usage: Usage | undefined
  for await (const event of provider.stream(request)) {
    if (event.type === 'text-delta') text += event.text
    else if (event.type === 'usage') usage = normalizeUsage(event.usage)
  }
  return {
    text: text.trim(),
    ...(usage !== undefined ? { usage } : {}),
  }
}
