/** Argument readers shared by every tool; they fail with a readable message. */

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolArgumentError'
  }
}

export function stringArg(
  args: Record<string, unknown>,
  name: string,
  options: { required?: boolean; fallback?: string } = {},
): string {
  const value = args[name]
  if (value === undefined || value === null) {
    if (options.fallback !== undefined) return options.fallback
    if (options.required === false) return ''
    throw new ToolArgumentError(`missing required argument "${name}"`)
  }
  if (typeof value !== 'string') throw new ToolArgumentError(`argument "${name}" must be a string`)
  return value
}

export function numberArg(
  args: Record<string, unknown>,
  name: string,
  options: { fallback?: number; min?: number; max?: number } = {},
): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return options.fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new ToolArgumentError(`argument "${name}" must be a number`)
  let result = Math.trunc(parsed)
  if (options.min !== undefined) result = Math.max(options.min, result)
  if (options.max !== undefined) result = Math.min(options.max, result)
  return result
}

export function booleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name]
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ToolArgumentError(`argument "${name}" must be a boolean`)
}

export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } {
  return { type: 'object', properties, required, additionalProperties: false }
}
