import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { ToolDefinition, ToolResult } from './types.ts'
import { grepWithRg } from './ripgrep.ts'
import { replacePlan, resolveEdit } from '../core/edit-match.ts'
import { ToolArgumentError, booleanArg, numberArg, objectSchema, stringArg } from './util.ts'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.agent',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.cache',
])

const MAX_READ_BYTES = 2_000_000
const MAX_OUTPUT_CHARS = 120_000

interface WalkEntry {
  abs: string
  rel: string
  isDir: boolean
}

/** Resolve a user path and refuse anything that escapes the workspace. */
export function resolveInside(cwd: string, target: string): string {
  const root = resolve(cwd)
  const absolute = resolve(root, target)
  const rel = relative(root, absolute)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new ToolArgumentError(`path escapes the working directory: ${target}`)
  }
  return absolute
}

async function walk(root: string, options: { maxDepth?: number; maxEntries?: number } = {}): Promise<WalkEntry[]> {
  const maxDepth = options.maxDepth ?? 12
  const maxEntries = options.maxEntries ?? 5000
  const entries: WalkEntry[] = []
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: root, rel: '', depth: 0 }]

  while (queue.length > 0 && entries.length < maxEntries) {
    const current = queue.shift()
    if (current === undefined) break
    let children
    try {
      children = await readdir(current.abs, { withFileTypes: true })
    } catch {
      continue
    }
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      if (entries.length >= maxEntries) break
      const rel = current.rel === '' ? child.name : `${current.rel}/${child.name}`
      const abs = resolve(current.abs, child.name)
      if (child.isSymbolicLink()) continue
      if (child.isDirectory()) {
        if (IGNORED_DIRS.has(child.name)) continue
        entries.push({ abs, rel, isDir: true })
        if (current.depth + 1 < maxDepth) queue.push({ abs, rel, depth: current.depth + 1 })
      } else if (child.isFile()) {
        entries.push({ abs, rel, isDir: false })
      }
    }
  }
  return entries
}

function clip(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit - 4000)
  const tail = text.slice(-3000)
  return `${head}\n\n… [output truncated: ${text.length - limit} chars omitted] …\n\n${tail}`
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/\\/g, '/')
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '*' && source[index + 1] === '*') {
      index += 2
      if (source[index] === '/') {
        out += '(?:.*/)?'
        index += 1
      } else {
        out += '.*'
      }
      continue
    }
    if (char === '*') {
      out += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      out += '[^/]'
      index += 1
      continue
    }
    if ('\\^$.|+()[]{}'.includes(char ?? '')) {
      out += `\\${char}`
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return new RegExp(`^${out}$`)
}

function matchGlob(pattern: string, relPath: string): boolean {
  const regex = globToRegExp(pattern)
  return pattern.includes('/') ? regex.test(relPath) : regex.test(basename(relPath))
}

async function looksBinary(abs: string): Promise<boolean> {
  try {
    const handle = await readFile(abs)
    const probe = handle.subarray(0, 4096)
    return probe.includes(0)
  } catch {
    return true
  }
}

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the working directory and return numbered lines. Use offset/limit for large files. Always read a file before editing it.',
  risk: 'read',
  parameters: objectSchema(
    {
      path: { type: 'string', description: 'File path, relative to the working directory.' },
      offset: { type: 'number', description: '1-based first line to return (default 1).' },
      limit: { type: 'number', description: 'Maximum lines to return (default 2000).' },
    },
    ['path'],
  ),
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.cwd, stringArg(args, 'path'))
    const info = await stat(target).catch(() => undefined)
    if (info === undefined) return { content: `file not found: ${stringArg(args, 'path')}`, isError: true }
    if (info.isDirectory()) return { content: `is a directory, use list_files: ${stringArg(args, 'path')}`, isError: true }
    if (info.size > MAX_READ_BYTES) {
      return { content: `file is too large (${info.size} bytes); read a range with offset/limit is not supported for >2MB`, isError: true }
    }
    const text = await readFile(target, 'utf8')
    const lines = text.split('\n')
    const offset = numberArg(args, 'offset', { min: 1 }) ?? 1
    const limit = numberArg(args, 'limit', { min: 1, max: 5000 }) ?? 2000
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    if (slice.length === 0) return { content: `offset ${offset} is past the end of the file (${lines.length} lines)` }
    const numbered = slice.map((line, index) => `${offset + index}|${line}`).join('\n')
    const suffix =
      offset - 1 + slice.length < lines.length
        ? `\n… (${lines.length - (offset - 1 + slice.length)} more lines; continue with offset=${offset + slice.length})`
        : ''
    return { content: clip(numbered) + suffix }
  },
}

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file inside the working directory, creating parent directories as needed. Prefer edit_file for small changes to existing files.',
  risk: 'write',
  parameters: objectSchema(
    {
      path: { type: 'string', description: 'File path, relative to the working directory.' },
      content: { type: 'string', description: 'Complete file content.' },
    },
    ['path', 'content'],
  ),
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.cwd, stringArg(args, 'path'))
    const content = stringArg(args, 'content')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    const lines = content.length === 0 ? 0 : content.split('\n').length
    return { content: `wrote ${Buffer.byteLength(content, 'utf8')} bytes (${lines} lines) to ${relative(ctx.cwd, target) || '.'}` }
  },
}

const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Replace an exact string in an existing file. old_string must match the file exactly and appear once unless replace_all is true. If exact matching fails, a conservative whitespace-tolerant fallback (indentation / trailing whitespace / line endings) is tried, but only for a unique whole-line match. Read the file first.',
  risk: 'write',
  parameters: objectSchema(
    {
      path: { type: 'string', description: 'File path, relative to the working directory.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
    },
    ['path', 'old_string', 'new_string'],
  ),
  async execute(args, ctx): Promise<ToolResult> {
    const relPath = stringArg(args, 'path')
    const target = resolveInside(ctx.cwd, relPath)
    const oldString = stringArg(args, 'old_string')
    const newString = stringArg(args, 'new_string')
    const replaceAll = booleanArg(args, 'replace_all', false)
    if (oldString.length === 0) return { content: 'old_string must not be empty', isError: true }

    const text = await readFile(target, 'utf8').catch(() => undefined)
    if (text === undefined) return { content: `file not found: ${relPath}`, isError: true }

    const plan = resolveEdit(text, oldString)
    if (plan.count === 0) {
      const hint =
        plan.reason === 'too-short'
          ? ' (too short for whitespace-tolerant matching; add more surrounding context)'
          : ''
      return { content: `old_string was not found in ${relPath}${hint}`, isError: true }
    }
    if (plan.count > 1) {
      if (plan.fuzzy) {
        return {
          content: `old_string appears ${plan.count} times after whitespace normalization in ${relPath}; whitespace-tolerant replacement needs a unique match, add more context`,
          isError: true,
        }
      }
      return { content: `old_string appears ${plan.count} times in ${relPath}; add more context or set replace_all`, isError: true }
    }

    const next = replaceAll && !plan.fuzzy ? text.split(oldString).join(newString) : replacePlan(text, plan, newString)
    await writeFile(target, next, 'utf8')
    const note = plan.fuzzy ? ' (whitespace-tolerant match)' : ''
    return { content: `replaced ${replaceAll && !plan.fuzzy ? plan.count : 1} occurrence(s) in ${relPath}${note}` }
  },
}

const listFilesTool: ToolDefinition = {
  name: 'list_files',
  description: 'List files and directories under a path (default: working directory root), skipping build and dependency folders.',
  risk: 'read',
  parameters: objectSchema({
    path: { type: 'string', description: 'Directory to list (default ".").' },
    depth: { type: 'number', description: 'Recursion depth (default 2).' },
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.cwd, stringArg(args, 'path', { fallback: '.' }))
    const depth = numberArg(args, 'depth', { min: 1, max: 6 }) ?? 2
    const entries = await walk(target, { maxDepth: depth, maxEntries: 400 })
    if (entries.length === 0) return { content: 'no files found' }
    const root = relative(ctx.cwd, target)
    const lines = entries.map((entry) => `${root === '' ? '' : `${root}/`}${entry.rel}${entry.isDir ? '/' : ''}`)
    const body = lines.join('\n')
    return { content: clip(body) + (entries.length >= 400 ? '\n… (listing truncated at 400 entries)' : '') }
  },
}

const globFilesTool: ToolDefinition = {
  name: 'glob_files',
  description: 'Find files by glob pattern, e.g. "src/**/*.ts" or "*.json". Use "**" for any depth and "?" for one character.',
  risk: 'read',
  parameters: objectSchema(
    {
      pattern: { type: 'string', description: 'Glob pattern, matched against the relative path.' },
      path: { type: 'string', description: 'Directory to search from (default ".").' },
    },
    ['pattern'],
  ),
  async execute(args, ctx): Promise<ToolResult> {
    const pattern = stringArg(args, 'pattern')
    const target = resolveInside(ctx.cwd, stringArg(args, 'path', { fallback: '.' }))
    const entries = await walk(target, { maxEntries: 8000 })
    const root = relative(ctx.cwd, target)
    const matches = entries
      .filter((entry) => !entry.isDir)
      .map((entry) => (root === '' ? entry.rel : `${root}/${entry.rel}`))
      .filter((rel) => matchGlob(pattern, rel))
      .sort()
    if (matches.length === 0) return { content: `no files match ${pattern}` }
    const shown = matches.slice(0, 200)
    return { content: shown.join('\n') + (matches.length > shown.length ? `\n… (${matches.length - shown.length} more matches)` : '') }
  },
}

const grepFilesTool: ToolDefinition = {
  name: 'grep_files',
  description:
    'Search file contents with a regular expression (uses ripgrep when available). Returns file:line: text for each match.',
  risk: 'read',
  parameters: objectSchema(
    {
      pattern: { type: 'string', description: 'JavaScript regular expression source.' },
      path: { type: 'string', description: 'Directory to search from (default ".").' },
      include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match (default false).' },
      max_results: { type: 'number', description: 'Maximum matches to return (default 100).' },
    },
    ['pattern'],
  ),
  async execute(args, ctx): Promise<ToolResult> {
    const source = stringArg(args, 'pattern')
    const target = resolveInside(ctx.cwd, stringArg(args, 'path', { fallback: '.' }))
    const include = stringArg(args, 'include', { fallback: '' })
    const ignoreCase = booleanArg(args, 'ignore_case', false)
    const maxResults = numberArg(args, 'max_results', { min: 1, max: 500 }) ?? 100
    let regex: RegExp
    try {
      regex = new RegExp(source, ignoreCase ? 'i' : '')
    } catch (error) {
      return { content: `invalid regular expression: ${(error as Error).message}`, isError: true }
    }

    const root = relative(ctx.cwd, target)
    // Fast path: ripgrep when present. It falls back here on any failure or
    // on patterns it cannot compile (the contract stays JavaScript regex).
    const viaRg = await grepWithRg({
      target,
      root,
      pattern: source,
      include,
      ignoreCase,
      maxResults,
      ignoredDirs: IGNORED_DIRS,
      signal: ctx.signal,
    })
    if (viaRg !== undefined) {
      if (viaRg.length === 0) return { content: `no matches for ${source} (ripgrep)` }
      const suffix = viaRg.length >= maxResults ? `\n… (stopped at ${maxResults} matches)` : ''
      return { content: clip(viaRg.join('\n')) + suffix }
    }

    const entries = await walk(target, { maxEntries: 8000 })
    const results: string[] = []
    let scanned = 0
    for (const entry of entries) {
      if (entry.isDir) continue
      const rel = root === '' ? entry.rel : `${root}/${entry.rel}`
      if (include !== '' && !matchGlob(include, rel)) continue
      if (results.length >= maxResults) break
      const info = await stat(entry.abs).catch(() => undefined)
      if (info === undefined || info.size > MAX_READ_BYTES) continue
      if (await looksBinary(entry.abs)) continue
      let text: string
      try {
        text = await readFile(entry.abs, 'utf8')
      } catch {
        continue
      }
      scanned += 1
      const lines = text.split('\n')
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? ''
        if (!regex.test(line)) continue
        results.push(`${rel}:${lineIndex + 1}: ${line.trim().slice(0, 300)}`)
        if (results.length >= maxResults) break
      }
    }
    if (results.length === 0) return { content: `no matches for ${source} (${scanned} files scanned)` }
    const suffix = results.length >= maxResults ? `\n… (stopped at ${maxResults} matches)` : ''
    return { content: clip(results.join('\n')) + suffix }
  },
}

export const fileTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  globFilesTool,
  grepFilesTool,
]

export { walk }
