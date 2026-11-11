import type { AppConfig } from '../config.ts'
import type { ChatProvider } from './types.ts'
import { AnthropicProvider } from './anthropic.ts'
import { MockProvider } from './mock.ts'
import { OpenAICompatibleProvider } from './openai-compatible.ts'

export function createProvider(config: AppConfig): ChatProvider {
  if (config.provider === 'mock') return new MockProvider({ model: config.model })
  if (config.provider === 'anthropic') {
    return new AnthropicProvider({
      id: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    })
  }
  return new OpenAICompatibleProvider({
    id: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
  })
}

export { AnthropicProvider } from './anthropic.ts'
export { MockProvider } from './mock.ts'
export { OpenAICompatibleProvider, readSseData } from './openai-compatible.ts'
export { ProviderError } from './types.ts'
export type {
  ChatMessage,
  ChatProvider,
  FinishReason,
  JsonSchema,
  ProviderEvent,
  ProviderRequest,
  Role,
  ToolCall,
  ToolSpec,
  Usage,
} from './types.ts'
