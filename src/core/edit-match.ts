/**
 * Resolve `old_string` against file text. Exact matches always win; only when
 * there are none do we try a deliberately narrow whitespace-tolerant match:
 * line endings, leading indentation and trailing whitespace are normalized,
 * interior whitespace is not. The fallback must be unique, and the replacement
 * span always covers whole lines, so a short snippet can never match inside
 * another line.
 */

/** Shorter snippets are too easy to hit by accident; they stay exact-only. */
const MIN_FUZZY_CHARS = 10

export interface IndentShift {
  mode: 'add' | 'remove'
  text: string
}

export interface IndentPlan {
  /** Applied when new_string's line count differs from old_string's. */
  uniform: IndentShift
  /** Per old line; applied line-by-line when the line counts align. */
  lines?: Array<IndentShift | undefined>
}

export interface EditPlan {
  /** Occurrences found (exact, or after whitespace normalization). */
  count: number
  /** True when the plan came from the whitespace-tolerant fallback. */
  fuzzy: boolean
  /** Set only when count === 1 and a replacement span is known. */
  start?: number
  end?: number
  reason?: 'empty' | 'too-short' | 'not-found'
  /** Fuzzy match only: shift replacement lines to the file's real indentation. */
  indent?: IndentPlan
  /** Fuzzy match only: matched region uses CRLF, so the replacement must too. */
  eol?: '\r\n'
}

function leading(line: string): string {
  const match = /^[ \t]*/.exec(line)
  return match === null ? '' : match[0]
}

function normalizeLine(line: string): string {
  return line.replace(/\s+$/, '').replace(/^[ \t]*/, '')
}

function countExact(text: string, oldString: string): number {
  let count = 0
  let index = text.indexOf(oldString)
  while (index >= 0) {
    count += 1
    if (count > 1000) break
    index = text.indexOf(oldString, index + oldString.length)
  }
  return count
}

interface FuzzyResult {
  count: number
  start?: number
  end?: number
  reason?: 'too-short' | 'not-found'
  indent?: IndentPlan
  eol?: '\r\n'
}

function fuzzyFind(text: string, oldString: string): FuzzyResult {
  if (oldString.trim().length < MIN_FUZZY_CHARS) return { count: 0, reason: 'too-short' }

  const oldLines = oldString.split(/\r?\n/)
  if (oldLines.at(-1) === '') oldLines.pop()
  if (oldLines.length === 0) return { count: 0, reason: 'not-found' }
  const normalizedOld = oldLines.map(normalizeLine)

  const fileLines = text.split('\n')
  const normalizedFile = fileLines.map(normalizeLine)
  const lineStarts: number[] = []
  let offset = 0
  for (const line of fileLines) {
    lineStarts.push(offset)
    offset += line.length + 1
  }

  const hits: number[] = []
  for (let index = 0; index + normalizedOld.length <= normalizedFile.length; index += 1) {
    let same = true
    for (let line = 0; line < normalizedOld.length; line += 1) {
      if (normalizedFile[index + line] !== normalizedOld[line]) {
        same = false
        break
      }
    }
    if (same) hits.push(index)
  }
  if (hits.length === 0) return { count: 0, reason: 'not-found' }
  if (hits.length > 1) return { count: hits.length }

  const first = hits[0] as number
  const start = lineStarts[first] as number
  const last = first + normalizedOld.length - 1
  const lastLine = fileLines[last] ?? ''
  const end = (lineStarts[last] as number) + lastLine.replace(/\s+$/, '').length

  // The span covers the newlines between matched lines. If the file uses CRLF
  // there, keep CRLF instead of letting new_string silently rewrite them.
  let eol: '\r\n' | undefined
  for (let line = 0; line < oldLines.length - 1; line += 1) {
    if ((fileLines[first + line] as string).endsWith('\r')) {
      eol = '\r\n'
      break
    }
  }

  // When the model under- or over-indented the snippet, shift new_string so the
  // file keeps one indentation style. If the line structure aligns, each line
  // gets its own delta (2-space vs 4-space style still lands correctly);
  // otherwise the first non-blank line's delta is applied uniformly.
  const lineShifts: Array<IndentShift | undefined> = []
  let uniform: IndentShift | undefined
  for (let line = 0; line < oldLines.length; line += 1) {
    if (normalizeLine(oldLines[line] as string) === '') {
      lineShifts.push(undefined)
      continue
    }
    const oldIndent = leading(oldLines[line] as string)
    const fileIndent = leading(fileLines[first + line] as string)
    let shift: IndentShift | undefined
    if (fileIndent !== oldIndent) {
      if (fileIndent.startsWith(oldIndent)) shift = { mode: 'add', text: fileIndent.slice(oldIndent.length) }
      else if (oldIndent.startsWith(fileIndent)) shift = { mode: 'remove', text: oldIndent.slice(fileIndent.length) }
    }
    lineShifts.push(shift !== undefined && shift.text !== '' ? shift : undefined)
    if (uniform === undefined && shift !== undefined && shift.text !== '') uniform = shift
  }
  const allSame =
    uniform !== undefined &&
    lineShifts.every(
      (shift) =>
        shift === undefined ||
        (uniform !== undefined && shift.mode === uniform.mode && shift.text === uniform.text),
    )
  const indent: IndentPlan | undefined =
    uniform === undefined
      ? undefined
      : allSame
        ? { uniform }
        : {
            uniform,
            lines: lineShifts,
          }

  return {
    count: 1,
    start,
    end,
    ...(indent !== undefined ? { indent } : {}),
    ...(eol !== undefined ? { eol } : {}),
  }
}

/** Exact match first; whitespace-tolerant fallback only when exact finds nothing. */
export function resolveEdit(text: string, oldString: string): EditPlan {
  if (oldString.length === 0) return { count: 0, fuzzy: false, reason: 'empty' }
  if (text.includes(oldString)) {
    const count = countExact(text, oldString)
    if (count > 1) return { count, fuzzy: false }
    const start = text.indexOf(oldString)
    return { count: 1, fuzzy: false, start, end: start + oldString.length }
  }
  const fuzzy = fuzzyFind(text, oldString)
  return {
    count: fuzzy.count,
    fuzzy: fuzzy.count > 0,
    ...(fuzzy.start !== undefined ? { start: fuzzy.start } : {}),
    ...(fuzzy.end !== undefined ? { end: fuzzy.end } : {}),
    ...(fuzzy.reason !== undefined ? { reason: fuzzy.reason } : {}),
    ...(fuzzy.indent !== undefined ? { indent: fuzzy.indent } : {}),
    ...(fuzzy.eol !== undefined ? { eol: fuzzy.eol } : {}),
  }
}

/** Shift every non-blank line of a replacement by one indentation delta. */
export function shiftIndent(text: string, shift: IndentShift): string {
  return text
    .split('\n')
    .map((line) => shiftLine(line, shift))
    .join('\n')
}

function shiftLine(line: string, shift: IndentShift | undefined): string {
  if (shift === undefined || line.trim() === '') return line
  if (shift.mode === 'add') return `${shift.text}${line}`
  return line.startsWith(shift.text) ? line.slice(shift.text.length) : line
}

/**
 * Re-indent new_string for a fuzzy match. When the replacement has the same
 * number of lines as the snippet it replaces, each line keeps its own delta
 * (a 2-space snippet inside a 4-space file still lands correctly); otherwise
 * the first non-blank line's delta is applied uniformly.
 */
function applyIndent(newString: string, indent: IndentPlan): string {
  const lines = newString.split('\n')
  if (indent.lines !== undefined && indent.lines.length === lines.length) {
    return lines.map((line, index) => shiftLine(line, indent.lines?.[index])).join('\n')
  }
  return shiftIndent(newString, indent.uniform)
}

/** Apply a single-match plan; callers must ensure `plan.start`/`plan.end` exist. */
export function replacePlan(text: string, plan: EditPlan, newString: string): string {
  if (plan.start === undefined || plan.end === undefined) {
    throw new Error('replacePlan requires a single resolved match')
  }
  const replacement = plan.indent === undefined ? newString : applyIndent(newString, plan.indent)
  const result = plan.eol === '\r\n' ? replacement.replace(/\r?\n/g, '\r\n') : replacement
  return text.slice(0, plan.start) + result + text.slice(plan.end)
}
