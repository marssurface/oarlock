import type { ProviderKind } from '../config.ts'

export interface VendorPreset {
  id: string
  label: string
  provider: ProviderKind
  baseUrl: string
  models: string[]
  keyHint: string
}

/**
 * Quick-fill presets for the settings panel. Every vendor here speaks the
 * OpenAI chat-completions protocol, so they differ only by baseUrl/model/key.
 */
export const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyHint: 'platform.deepseek.com',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
    keyHint: 'platform.openai.com',
  },
  {
    id: 'qwen',
    label: '通义千问',
    provider: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-coder-plus', 'qwen-max', 'qwen-plus'],
    keyHint: '阿里云百炼 DashScope',
  },
  {
    id: 'volcengine',
    label: '火山方舟',
    provider: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115'],
    keyHint: 'Volcengine Ark',
  },
  {
    id: 'volcengine-coding',
    label: '火山方舟 Coding',
    provider: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: ['ark-code-latest', 'doubao-seed-2.1-pro', 'deepseek-v4-pro', 'kimi-k3', 'glm-5.3'],
    keyHint: 'Coding Plan 专属端点，勿用 /api/v3',
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    provider: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0711-preview', 'moonshot-v1-8k'],
    keyHint: 'platform.moonshot.cn',
  },
  {
    id: 'kimi-coding',
    label: 'Kimi Code',
    provider: 'openai',
    baseUrl: 'https://api.kimi.com/coding/v1',
    models: ['kimi-for-coding'],
    keyHint: 'Kimi Code 会员套餐，模型固定 kimi-for-coding',
  },
  {
    id: 'kimi-coding-intl',
    label: 'Kimi Code 海外',
    provider: 'openai',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    models: ['kimi-for-coding'],
    keyHint: 'Kimi Code 海外会员套餐，模型固定 kimi-for-coding',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    provider: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4-flash'],
    keyHint: 'open.bigmodel.cn',
  },
  {
    id: 'zhipu-coding',
    label: '智谱 GLM Coding',
    provider: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: ['glm-5.3', 'glm-5.1', 'glm-4.7'],
    keyHint: 'Coding Plan 专属端点，勿用 /api/paas/v4',
  },
  {
    id: 'zhipu-coding-intl',
    label: 'GLM Coding 海外',
    provider: 'openai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    models: ['glm-5.3', 'glm-5.1', 'glm-4.7'],
    keyHint: 'Z.ai Coding Plan 专属端点，勿用 /api/paas/v4',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    provider: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-Coder-480B-A35B-Instruct'],
    keyHint: 'siliconflow.cn',
  },
  {
    id: 'stepfun',
    label: '阶跃星辰',
    provider: 'openai',
    baseUrl: 'https://api.stepfun.com/v1',
    models: ['step-2-16k', 'step-1-8k'],
    keyHint: 'platform.stepfun.com',
  },
  {
    id: 'ollama',
    label: '本地 Ollama',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen3:8b', 'llama3.2'],
    keyHint: '本地运行，无需密钥',
  },
  {
    id: 'mock',
    label: '离线 Mock',
    provider: 'mock',
    baseUrl: 'http://mock.invalid/v1',
    models: ['mock-1'],
    keyHint: '无需密钥，体验用',
  },
  {
    id: 'custom',
    label: '自定义',
    provider: 'openai',
    baseUrl: '',
    models: [],
    keyHint: '任意 OpenAI 兼容网关',
  },
]
