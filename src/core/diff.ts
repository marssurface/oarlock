import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { replacePlan, resolveEdit } from './edit-match.ts'

const MAX_PREVIEW_BYTES = 1_000_000
const MAX_LINES = 200
const MAX_CHARS = 4_000

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** One hunk around the common prefix/suffix: enough context to judge a write. */
export function previewDiff(path: string, before: string, after: string, existed: boolean): string {
  if (before === after) return `${path}: no textual change`

  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  const context = 2
  const start = Math.max(0, prefix - context)
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + context)
  const newEnd = Math.min(newLines.length, newLines.length - suffix + context)

  const header = existed ? `--- a/${path}\n+++ b/${path}` : `--- /dev/null\n+++ b/${path}`
  const hunk = `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`
  const body: string[] = []
  for (let index = start; index < prefix; index += 1) body.push(` ${oldLines[index] ?? ''}`)
  for (const line of removed.slice(0, MAX_LINES)) body.push(`-${line}`)
  if (removed.length > MAX_LINES) body.push(`-… (${removed.length - MAX_LINES} more removed lines)`)
  for (const line of added.slice(0, MAX_LINES)) body.push(`+${line}`)
  if (added.length > MAX_LINES) body.push(`+… (${added.length - MAX_LINES} more added lines)`)
  for (let index = oldLines.length - suffix; index < oldEnd; index += 1) body.push(` ${oldLines[index] ?? ''}`)

  const text = [header, hunk, ...body].join('\n')
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n… (diff truncated)`
}

/** Build the approval detail for a write: an actual change preview, not raw JSON. */
export async function describeToolChange(
  tool: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<string | undefined> {
  if (tool !== 'write_file' && tool !== 'edit_file') return undefined
  const path = typeof args['path'] === 'string' ? args['path'] : ''
  if (path.length === 0) return undefined
  const target = resolve(cwd, path)

  let before: string | undefined
  try {
    const info = await stat(target)
    if (!info.isFile() || info.size > MAX_PREVIEW_BYTES) return undefined
    before = await readFile(target, 'utf8')
  } catch {
    before = undefined
  }

  let after: string
  let note = ''
  if (tool === 'write_file') {
    after = typeof args['content'] === 'string' ? args['content'] : ''
  } else {
    const oldString = typeof args['old_string'] === 'string' ? args['old_string'] : ''
    const newString = typeof args['new_string'] === 'string' ? args['new_string'] : ''
    if (before === undefined || oldString.length === 0) return undefined
    const plan = resolveEdit(before, oldString)
    if (plan.count === 0) return `${path}: old_string was not found`
    if (plan.count > 1 && args['replace_all'] !== true) {
      return `${path}: old_string appears ${plan.count} times${plan.fuzzy ? ' after whitespace normalization' : ''}`
    }
    after =
      args['replace_all'] === true && !plan.fuzzy ? before.split(oldString).join(newString) : replacePlan(before, plan, newString)
    if (plan.fuzzy) note = '\n(whitespace-tolerant match: indentation / trailing whitespace normalized)'
  }
  return previewDiff(path, before ?? '', after, before !== undefined) + note
}
