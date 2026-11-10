import type { Usage } from '../providers/types.ts'

/** Add one provider request's usage into a running total (mutates `total`). */
export function addUsage(total: Usage, next: Usage | undefined): void {
  if (next === undefined) return
  if (next.promptTokens !== undefined) total.promptTokens = (total.promptTokens ?? 0) + next.promptTokens
  if (next.completionTokens !== undefined) total.completionTokens = (total.completionTokens ?? 0) + next.completionTokens
  if (next.cachedTokens !== undefined) total.cachedTokens = (total.cachedTokens ?? 0) + next.cachedTokens
  if (next.reasoningTokens !== undefined) total.reasoningTokens = (total.reasoningTokens ?? 0) + next.reasoningTokens
  if (next.estimated === true) total.estimated = true
  const prompt = total.promptTokens ?? 0
  const completion = total.completionTokens ?? 0
  if (next.totalTokens !== undefined) total.totalTokens = (total.totalTokens ?? 0) + next.totalTokens
  else if (prompt > 0 || completion > 0) total.totalTokens = prompt + completion
}

/** True when the provider reported anything we can bill or display. */
export function hasUsage(usage: Usage | undefined): usage is Usage {
  if (usage === undefined) return false
  return (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) + (usage.totalTokens ?? 0) > 0
}

/** Total tokens for budgeting, falling back to input + output when omitted. */
export function totalTokens(usage: Usage): number {
  return usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
}

/** Fill in the totals providers may omit (some gateways send only input/output). */
export function normalizeUsage(usage: Usage): Usage {
  const prompt = usage.promptTokens ?? 0
  const completion = usage.completionTokens ?? 0
  return {
    ...usage,
    ...(usage.totalTokens === undefined && (prompt > 0 || completion > 0)
      ? { totalTokens: prompt + completion }
      : {}),
  }
}

/** Usage for one request that the provider did not report; flagged as estimated. */
export function estimatedUsage(promptTokens: number, completionTokens: number): Usage {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  }
}
