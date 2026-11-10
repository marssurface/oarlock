import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * `always` approval rules persisted per working directory. Rules only widen
 * approval (`deny` policy and explicit denials still win); they never grant
 * anything the gate would not ask about anyway. The file is plain JSON so it
 * stays inspectable and diff-friendly, with a hard cap to bound growth.
 */

const MAX_RULES = 500
const FILE_VERSION = 1

export function permissionsFile(cwd: string): string {
  return join(resolve(cwd), '.agent', 'permissions.json')
}

/** Tolerant read: missing / malformed / foreign files behave like an empty rule set. */
export function readRules(cwd: string): string[] {
  let raw: string
  try {
    raw = readFileSync(permissionsFile(cwd), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const list = (parsed as { rules?: unknown }).rules
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const rule = item.trim()
    if (rule === '' || seen.has(rule)) continue
    seen.add(rule)
    if (seen.size >= MAX_RULES) break
  }
  return [...seen]
}

/** In-memory rules shared by every gate in one process, backed by the JSON file. */
export class PermissionRules {
  readonly cwd: string
  private rules: Set<string>

  constructor(cwd: string) {
    this.cwd = resolve(cwd)
    this.rules = new Set(readRules(this.cwd))
  }

  list(): string[] {
    return [...this.rules]
  }

  has(rule: string): boolean {
    return this.rules.has(rule)
  }

  /** Remember a rule. Returns false when the file could not be written. */
  add(rule: string): boolean {
    const value = rule.trim()
    if (value === '' || this.rules.has(value)) return true
    if (this.rules.size >= MAX_RULES) return false
    const next = [...this.rules, value]
    if (!this.persist(next)) return false
    this.rules = new Set(next)
    return true
  }

  remove(rule: string): boolean {
    if (!this.rules.has(rule)) return true
    const next = [...this.rules].filter((item) => item !== rule)
    if (!this.persist(next)) return false
    this.rules = new Set(next)
    return true
  }

  clear(): boolean {
    if (!this.persist([])) return false
    this.rules = new Set()
    return true
  }

  private persist(rules: string[]): boolean {
    const file = permissionsFile(this.cwd)
    if (rules.length === 0) {
      try {
        rmSync(file, { force: true })
      } catch {
        return false
      }
      return true
    }
    const temp = `${file}.tmp`
    try {
      mkdirSync(join(this.cwd, '.agent'), { recursive: true })
      writeFileSync(temp, `${JSON.stringify({ version: FILE_VERSION, rules }, null, 2)}\n`, 'utf8')
      renameSync(temp, file)
      return true
    } catch {
      try {
        rmSync(temp, { force: true })
      } catch {
        // best effort
      }
      return false
    }
  }
}

const shared = new Map<string, PermissionRules>()

/** One rule set per working directory, shared by all sessions in this process. */
export function permissionRules(cwd: string): PermissionRules {
  const key = resolve(cwd)
  let rules = shared.get(key)
  if (rules === undefined) {
    rules = new PermissionRules(key)
    shared.set(key, rules)
  }
  return rules
}
