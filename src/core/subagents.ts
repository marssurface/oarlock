/**
 * Built-in subagent presets. A preset is a persona + optional tool allowlist
 * + optional model hint that the `task` tool routes to by name. Model names are
 * gateway-specific, so presets keep `model` undefined and let the caller pass a
 * cheaper `model` explicitly; the "cheap" tier for `explore` comes from its
 * read-only tool allowlist and focused prompt, not a hardcoded model id.
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
}

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

export const SUBAGENT_PRESETS: SubagentPreset[] = [
  {
    name: 'general',
    description: 'multi-step work that may edit files or run commands; inherits the parent tools and model',
    systemPrompt: SUBAGENT_PROMPT,
  },
  {
    name: 'explore',
    description: 'read-only search and inspection; only the file read tools, ideal for a cheaper model',
    systemPrompt: EXPLORE_PROMPT,
    tools: ['read_file', 'list_files', 'glob_files', 'grep_files'],
  },
]

export function findPreset(name: string): SubagentPreset | undefined {
  return SUBAGENT_PRESETS.find((preset) => preset.name === name)
}

/** Compact inline list for the system prompt, e.g. `` `general` — …; `explore` — …``. */
export function presetCatalog(): string {
  return SUBAGENT_PRESETS.map((preset) => `\`${preset.name}\` — ${preset.description}`).join('; ')
}
