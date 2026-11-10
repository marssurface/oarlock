import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Read `AGENTS.md` from the working directory — the project's rules for the
 * agent. Missing or unreadable files yield an empty string so callers can
 * treat "no rules" the same as "blank rules".
 */
export function readProjectInstructions(cwd: string): string {
  try {
    return readFileSync(resolve(cwd, 'AGENTS.md'), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Join instruction sources in order, dropping blanks. Returns undefined when
 * there is nothing to add, so the caller can leave the field off the Agent.
 */
export function composeInstructions(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.map((part) => part?.trim() ?? '').filter((part) => part.length > 0)
  return kept.length > 0 ? kept.join('\n\n') : undefined
}
