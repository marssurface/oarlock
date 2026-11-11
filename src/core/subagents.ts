import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { firstMeaningfulLine, splitFrontmatter } from './frontmatter.ts'

/**
 * Subagent presets: a persona + optional tool allowlist + optional model hint
 * that the `task` tool routes to by name.
 *
 * Two sources. Built-in presets live here, so the runtime is useful with an
 * empty workspace. File presets live in `.agent/agents/*.md` — frontmatter for
 * the routing fields, markdown body for the persona — so a person can add a
 * specialist for their project with an editor and no code. A file named like a
 * built-in replaces it; everything unreadable or malformed is skipped, the same
 * fail-open rule the rest of the `.agent/` files follow.
 *
 * Model names are gateway-specific, so built-ins keep `model` undefined and let
 * the caller pass a cheaper `model` explicitly; the "cheap" tier for `explore`
 * comes from its read-only tool allowlist and focused prompt, not a hardcoded
 * model id. A file preset may name a model, because there the author knows
 * their own gateway.
 */

export interface SubagentPreset {
  /** Slug the parent passes as the `task` tool's `agent`. */
  name: string
  /** One-line description the parent model routes by. */
  description: string
  /** Persona prepended to the child system prompt. */
  systemPrompt: string
  /** Tool allowlist; undefined means inherit the parent's tools (least privilege still caps it). */
  tools?: string[]
  /** Model override; undefined means inherit the parent's model. */
  model?: string
  /** Where the preset came from, for reporting: built-in or `.agent/agents/<file>.md`. */
  source?: string
}

export const SUBAGENT_RELATIVE_DIR = '.agent/agents'

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** Tool names are snake_case and MCP ones use double underscores. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const MAX_FILES = 32
const MAX_FILE_CHARS = 32_000
const MAX_PERSONA_CHARS = 6_000
const MAX_DESCRIPTION_CHARS = 200
const MAX_TOOL_NAMES = 40

export const SUBAGENT_PROMPT = [
  'You are a subagent inside a larger agent run.',
  'Work only on the task you were given, with the tools you have.',
  'You cannot ask the user questions: make a reasonable choice, do the work, and report.',
  'Finish with a compact report: what you did, what you found, files touched, and any blocker.',
].join('\n')

const EXPLORE_PROMPT = [
  'You are a read-only subagent: inspect and report, never change anything.',
  'Search the workspace with the read tools you have; you cannot write, run commands, or ask the user.',
  'Be efficient: prefer targeted grep/glob over reading whole trees.',
  'Finish with a compact report: what you looked at, what you found (with file:line), and what is unclear.',
].join('\n')

export const BUILTIN_PRESETS: SubagentPreset[] = [
  {
    name: 'general',
    description: 'multi-step work that may edit files or run commands; inherits the parent tools and model',
    systemPrompt: SUBAGENT_PROMPT,
    source: 'builtin',
  },
  {
    name: 'explore',
    description: 'read-only search and inspection; only the file read tools, ideal for a cheaper model',
    systemPrompt: EXPLORE_PROMPT,
    tools: ['read_file', 'list_files', 'glob_files', 'grep_files'],
    source: 'builtin',
  },
]

/** Kept as an alias: the built-in list is also the fallback when a workspace defines nothing. */
export const SUBAGENT_PRESETS: SubagentPreset[] = BUILTIN_PRESETS

/** `tools: read_file, grep_files` and `tools: [read_file, grep_files]` both mean the same list. */
function parseToolList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const names = raw
    .replace(/^\[|\]$/g, '')
    .split(/[,;\s]+/)
    .map((name) => name.trim().replace(/^`|`$/g, ''))
    // Tool names keep their underscores (`read_file`, `mcp__server__tool`);
    // anything that cannot be a tool is dropped rather than silently routing to
    // a name that does not exist.
    .filter((name) => TOOL_NAME_PATTERN.test(name))
  if (names.length === 0) return undefined
  return names.slice(0, MAX_TOOL_NAMES)
}

/**
 * One `.agent/agents/*.md` file, or undefined when it cannot be used. The body
 * is the persona; without one the generic subagent persona still applies, so a
 * file that only narrows tools or model is legal.
 */
export function parseSubagentFile(text: string, fallbackName: string, fileName?: string): SubagentPreset | undefined {
  if (text.length > MAX_FILE_CHARS) return undefined
  const { fields, body } = splitFrontmatter(text)
  const name = (fields['name'] ?? fallbackName).trim().toLowerCase().replace(/\.md$/i, '')
  if (!NAME_PATTERN.test(name)) return undefined
  const persona = body.slice(0, MAX_PERSONA_CHARS).trim()
  const model = (fields['model'] ?? '').trim()
  const tools = parseToolList(fields['tools'] ?? fields['allowed-tools'])
  const description = (fields['description'] ?? '').trim().replace(/\r?\n/g, ' ').slice(0, MAX_DESCRIPTION_CHARS)
  const preset: SubagentPreset = {
    name,
    description: description !== '' ? description : firstMeaningfulLine(persona) || `${name} subagent`,
    systemPrompt: persona !== '' ? persona : SUBAGENT_PROMPT,
    // Report the file it actually came from, which may be named differently.
    source: `${SUBAGENT_RELATIVE_DIR}/${(fileName ?? `${name}.md`).replace(/\.md$/i, '')}.md`,
  }
  if (tools !== undefined) preset.tools = tools
  if (model !== '') preset.model = model
  return preset
}

/** File presets in this workspace, name-ordered; a missing or unreadable directory means none. */
export function fileSubagentPresets(cwd: string): SubagentPreset[] {
  const dir = join(resolve(cwd), SUBAGENT_RELATIVE_DIR)
  let fileNames: string[]
  try {
    fileNames = readdirSync(dir)
  } catch {
    return []
  }
  const presets: SubagentPreset[] = []
  for (const fileName of fileNames.slice(0, MAX_FILES)) {
    if (!fileName.endsWith('.md')) continue
    // A stem that is not a slug is prose for a human (`README.md`), not a preset.
    const stem = fileName.slice(0, -3)
    if (!NAME_PATTERN.test(stem)) continue
    let text: string
    try {
      if (!statSync(join(dir, fileName)).isFile()) continue
      text = readFileSync(join(dir, fileName), 'utf8')
    } catch {
      continue
    }
    const preset = parseSubagentFile(text, stem, fileName)
    if (preset !== undefined) presets.push(preset)
  }
  return presets.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * What the parent can route to: the built-ins, then the file presets, with a
 * file replacing a built-in of the same name in place. Re-read per turn, so
 * adding a file takes effect without restarting the session.
 */
export function subagentPresets(cwd: string): SubagentPreset[] {
  const merged = BUILTIN_PRESETS.map((preset) => ({ ...preset }))
  for (const preset of fileSubagentPresets(cwd)) {
    const existing = merged.findIndex((candidate) => candidate.name === preset.name)
    if (existing < 0) merged.push(preset)
    else merged[existing] = preset
  }
  return merged
}

export function findPreset(name: string, presets: SubagentPreset[] = BUILTIN_PRESETS): SubagentPreset | undefined {
  return presets.find((preset) => preset.name === name)
}

/** Compact inline list for the system prompt, e.g. `` `general` — …; `explore` — ``. */
export function formatPresetCatalog(presets: SubagentPreset[]): string {
  return presets.map((preset) => `\`${preset.name}\` — ${preset.description}`).join('; ')
}

export function presetCatalog(cwd?: string): string {
  return formatPresetCatalog(cwd === undefined ? BUILTIN_PRESETS : subagentPresets(cwd))
}
