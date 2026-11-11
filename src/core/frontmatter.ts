/**
 * The `---` frontmatter block shared by the file-based `.agent/` stores: one
 * `key: value` line per field, then a markdown body a human can read.
 *
 * Parsing is deliberately fail-open — a file without a block, with an
 * unterminated block, or with junk lines keeps all of its text as the body, so
 * something a person wrote by hand is still usable instead of silently dropped.
 */
export function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { fields: {}, body: text.trim() }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { fields: {}, body: text.trim() }
  const fields: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (key.length > 0 && value.length > 0) fields[key] = value
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() }
}

/** First non-empty line without its leading markdown heading or list marker. */
export function firstMeaningfulLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^#+\s*/, '').replace(/^-\s*/, '').trim()
    if (text.length > 0) return text
  }
  return ''
}
