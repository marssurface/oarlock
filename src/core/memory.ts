import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { firstMeaningfulLine, splitFrontmatter } from './frontmatter.ts'

/**
 * Cross-session memory: short notes that outlive one conversation. One markdown
 * file per entry under `.agent/memory/`, so a human can read, edit or delete
 * them with any editor and nothing has to be migrated when the format changes.
 * There is no index file on purpose — the index is rendered from the directory
 * every time, so it can never drift from the notes it describes.
 *
 * Reading is fail-open like the rest of the runtime: an unreadable or malformed
 * note behaves like no note.
 */

export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'procedure'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** Where the notes live, relative to the working directory. */
export const MEMORY_RELATIVE_DIR = '.agent/memory'

/** Slugs are lowercase and filesystem-safe; uppercase names stay out of the index (README.md and friends). */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_INDEX_ENTRIES = 60
const INDEX_CHAR_BUDGET = 4000
const MAX_BODY_CHARS = 12_000
const MAX_DESCRIPTION_CHARS = 200

export interface MemoryEntry {
  name: string
  description: string
  kind: MemoryKind
  body: string
  /** File modification time as ISO text; empty when it cannot be read. */
  updatedAt: string
}

export interface MemoryDraft {
  name: string
  description?: string
  kind?: string
  body: string
}

export type MemoryWriteResult =
  | { ok: true; entry: MemoryEntry; created: boolean }
  | { ok: false; error: string }

export function memoryDir(cwd: string): string {
  return join(resolve(cwd), MEMORY_RELATIVE_DIR)
}

/** Best-effort slug: lowercase, spaces/underscores become dashes, unsupported characters dropped. */
export function memorySlug(raw: string): string {
  const lowered = raw.trim().toLowerCase()
  const dashed = lowered
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 64)
  return NAME_PATTERN.test(dashed) ? dashed : ''
}

function normalizeKind(value: string | undefined): MemoryKind {
  const lowered = value?.trim().toLowerCase() ?? ''
  return (MEMORY_KINDS as readonly string[]).includes(lowered) ? (lowered as MemoryKind) : 'fact'
}

function serialize(entry: MemoryEntry): string {
  return ['---', `name: ${entry.name}`, `description: ${entry.description}`, `kind: ${entry.kind}`, '---', '', entry.body, ''].join('\n')
}

export class MemoryStore {
  readonly dir: string

  constructor(dir: string) {
    this.dir = resolve(dir)
  }

  private fileFor(name: string): string {
    return join(this.dir, `${name}.md`)
  }

  /** Every readable note, newest first; a missing or unreadable directory is simply empty. */
  list(): MemoryEntry[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const entries: MemoryEntry[] = []
    for (const fileName of names) {
      if (!fileName.endsWith('.md')) continue
      const name = fileName.slice(0, -3)
      if (!NAME_PATTERN.test(name)) continue
      const entry = this.read(name)
      if (entry !== undefined) entries.push(entry)
    }
    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name))
  }

  /** One note by slug, or undefined when it is absent or unreadable. */
  read(name: string): MemoryEntry | undefined {
    if (!NAME_PATTERN.test(name)) return undefined
    const file = this.fileFor(name)
    let text: string
    let updatedAt = ''
    try {
      text = readFileSync(file, 'utf8')
      updatedAt = new Date(statSync(file).mtimeMs).toISOString()
    } catch {
      return undefined
    }
    const { fields, body } = splitFrontmatter(text)
    const description = fields['description'] ?? ''
    return {
      name,
      // A note without a frontmatter description is indexed by its first line.
      description: description !== '' ? description : firstMeaningfulLine(body),
      kind: normalizeKind(fields['kind']),
      body,
      updatedAt,
    }
  }

  /** Create or replace one note. Atomic: a failed write leaves the previous file untouched. */
  write(draft: MemoryDraft): MemoryWriteResult {
    const name = memorySlug(draft.name)
    if (name === '') return { ok: false, error: `invalid memory name: ${draft.name.slice(0, 40) || '(empty)'}` }
    const body = draft.body.trim()
    if (body.length === 0) return { ok: false, error: 'memory body must not be empty' }
    if (body.length > MAX_BODY_CHARS) {
      return { ok: false, error: `memory body is too long (${body.length} chars, max ${MAX_BODY_CHARS}); split it or keep the note short` }
    }
    const description = (draft.description ?? '').trim().replace(/\r?\n/g, ' ').slice(0, MAX_DESCRIPTION_CHARS)
    const previous = this.read(name)
    const entry: MemoryEntry = {
      name,
      description: description !== '' ? description : firstMeaningfulLine(body),
      kind: normalizeKind(draft.kind),
      body,
      updatedAt: new Date().toISOString(),
    }
    const file = this.fileFor(name)
    const temp = `${file}.tmp`
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(temp, serialize(entry), 'utf8')
      renameSync(temp, file)
    } catch (error) {
      try {
        rmSync(temp, { force: true })
      } catch {
        // best effort
      }
      return { ok: false, error: `could not write ${MEMORY_RELATIVE_DIR}/${name}.md: ${(error as Error).message}` }
    }
    return { ok: true, entry, created: previous === undefined }
  }

  remove(name: string): { removed: boolean; error?: string } {
    const slug = memorySlug(name)
    if (slug === '') return { removed: false, error: `invalid memory name: ${name.slice(0, 40) || '(empty)'}` }
    if (this.read(slug) === undefined) return { removed: false, error: `no memory named ${slug}` }
    try {
      rmSync(this.fileFor(slug), { force: true })
    } catch (error) {
      return { removed: false, error: `could not remove ${MEMORY_RELATIVE_DIR}/${slug}.md: ${(error as Error).message}` }
    }
    return { removed: true }
  }

  /**
   * The block injected into the system prompt: one line per note, newest first,
   * capped so a growing memory never eats the context window. Bodies stay on
   * disk — the agent reads the file it needs.
   */
  index(): string | undefined {
    const entries = this.list()
    if (entries.length === 0) return undefined
    const lines: string[] = []
    let used = 0
    let shown = 0
    for (const entry of entries.slice(0, MAX_INDEX_ENTRIES)) {
      const summary = entry.description.length > 0 ? ` — ${entry.description}` : ''
      const line = `- ${entry.name}${summary} (${entry.kind})`
      if (used + line.length > INDEX_CHAR_BUDGET && lines.length > 0) break
      lines.push(line)
      used += line.length
      shown += 1
    }
    const hidden = entries.length - shown
    if (hidden > 0) lines.push(`- … ${hidden} more not listed; \`ls ${MEMORY_RELATIVE_DIR}\` or list_files on it`)
    return lines.join('\n')
  }

  /** Relative path of one note, for messages the user can act on. */
  static pathFor(name: string): string {
    return `${MEMORY_RELATIVE_DIR}/${name}.md`
  }
}

const shared = new Map<string, MemoryStore>()

/** One store per working directory, shared by every session in this process. */
export function memoryStore(cwd: string): MemoryStore {
  const key = resolve(cwd)
  let store = shared.get(key)
  if (store === undefined) {
    store = new MemoryStore(memoryDir(key))
    shared.set(key, store)
  }
  return store
}
