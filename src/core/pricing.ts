import type { Usage } from '../providers/types.ts'

export type PriceCurrency = 'USD' | 'CNY'

/** Per-1M-token prices for one model, in the user's billing currency. */
export interface ModelPricing {
  /** Uncached input. */
  input: number
  /** Completion tokens (including reasoning tokens, matching provider bills). */
  output: number
  /** Cached input; absent means the normal input price. */
  cached?: number
  currency: PriceCurrency
}

export interface TokenCost {
  amount: number
  currency: PriceCurrency
}

const CURRENCY_SYMBOL: Record<PriceCurrency, string> = { USD: '$', CNY: '¥' }

function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Parse one `pricing` field; input and output are mandatory, anything odd drops the block. */
export function parsePricing(value: unknown): ModelPricing | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const input = record['input']
  const output = record['output']
  if (!isPrice(input) || !isPrice(output)) return undefined
  const pricing: ModelPricing = { input, output, currency: record['currency'] === 'CNY' ? 'CNY' : 'USD' }
  const cached = record['cached']
  if (isPrice(cached)) pricing.cached = cached
  return pricing
}

/**
 * Price one request. Providers report cached tokens inside `promptTokens`,
 * so the cached slice is removed from the full-price input first; reasoning
 * tokens are already part of `completionTokens` and must not be billed twice.
 */
export function costOf(usage: Usage, pricing: ModelPricing | undefined): TokenCost | undefined {
  if (pricing === undefined) return undefined
  const prompt = usage.promptTokens ?? 0
  const cached = Math.min(Math.max(usage.cachedTokens ?? 0, 0), prompt)
  const input = Math.max(prompt - cached, 0)
  const output = usage.completionTokens ?? 0
  const amount =
    (input * pricing.input + cached * (pricing.cached ?? pricing.input) + output * pricing.output) / 1_000_000
  return { amount, currency: pricing.currency }
}

/** Resolve a model name to its price, preferring the active endpoint on name collisions. */
export function pricingResolver(
  models: Array<{ baseUrl: string; model: string; pricing?: ModelPricing }>,
  active: { baseUrl: string; model: string },
): (model: string) => ModelPricing | undefined {
  const priced = models.filter((entry) => entry.pricing !== undefined)
  return (model) => {
    const candidates = priced.filter((entry) => entry.model === model)
    if (candidates.length === 0) return undefined
    const activeMatch = candidates.find((entry) => entry.baseUrl === active.baseUrl)
    return (activeMatch ?? candidates[0])?.pricing
  }
}

/** `$0.0012` / `¥0.42`; tiny per-request costs keep four decimals. */
export function formatCost(cost: TokenCost): string {
  const symbol = CURRENCY_SYMBOL[cost.currency] ?? ''
  const abs = Math.abs(cost.amount)
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4
  return `${symbol}${cost.amount.toFixed(digits)}`
}
