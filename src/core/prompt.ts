import { presetCatalog, SUBAGENT_RELATIVE_DIR } from './subagents.ts'
import { MEMORY_RELATIVE_DIR } from './memory.ts'

export interface PromptOptions {
  cwd: string
  tools: string[]
  extra?: string
  /** Rendered index of cross-session notes; see `memorySection`. */
  memory?: string
  /** Rendered subagent preset catalog; absent means the built-in presets only. */
  agents?: string
  /** True when the catalog includes presets defined in `.agent/agents/`. */
  agentsFromFiles?: boolean
}

/** The block that carries the note index into a system prompt (main agent and subagents alike). */
export function memorySection(index: string | undefined): string | undefined {
  if (index === undefined || index.trim().length === 0) return undefined
  return [
    `Memory from earlier sessions, one markdown file per note under \`${MEMORY_RELATIVE_DIR}/\`:`,
    index.trim(),
  ].join('\n')
}

export function buildSystemPrompt(options: PromptOptions): string {
  const lines = [
    'You are oarlock, a general-purpose agent running on the user machine. Coding is a first-class scenario, not the only one: the same tools serve documents, research, data work and automation.',
    `Working directory: ${options.cwd}`,
    `Available tools: ${options.tools.join(', ')}.`,
    '',
    'How to work:',
    '- Inspect before you change: read files, list directories, and confirm assumptions.',
    '- Keep changes minimal and reversible, and consistent with what already surrounds them.',
    '- Verify what you claim: run the command or check you are reasoning about, and report failures plainly.',
    '- Pick the output the task actually needs: a file, a table, a script, or the answer in chat.',
    '- When the work is code: use bash for builds, tests and git, and the dedicated file tools for reading and editing.',
    '- Answer in the language the user uses, be direct and concrete, and skip filler.',
  ]
  if (options.tools.includes('task')) {
    const catalog = options.agents !== undefined && options.agents.trim().length > 0 ? options.agents.trim() : presetCatalog()
    lines.push(
      `- Use the task tool for broad, independent work that would flood this conversation. Route it with \`agent\`: ${catalog}. Pass a cheaper \`model\` for simple searches and the smallest \`tools\` allowlist the job needs. Several independent delegations can go in one message — they run in parallel.`,
    )
    if (options.agentsFromFiles === true) {
      lines.push(
        `- Some of those presets are standing personas the user wrote under \`${SUBAGENT_RELATIVE_DIR}/\`. When one clearly fits the job, route to it instead of re-explaining the role in the prompt.`,
      )
    }
  }
  if (options.tools.includes('todo_write')) {
    lines.push(
      '- Use the todo_write tool to keep a short plan for multi-step work: mark exactly one item in_progress, mark items completed as soon as they finish, and clear the list when the work is done.',
    )
  }
  if (options.tools.includes('ask_user')) {
    lines.push(
      '- Use the ask_user tool when a real decision is ambiguous: a preference, a missing requirement, or a choice between approaches. Offer 2-4 concrete options, mark the one you recommend, and never ask something you can reasonably decide yourself.',
    )
  }
  if (options.tools.includes('remember')) {
    lines.push(
      `- Earlier sessions can leave notes (see the Memory section below, when present). Use the remember tool to save one when something you just learned would cost real work to rediscover: a quirk of this machine, a standing user preference, a decision and its reason, a procedure. Keep each note short, self-contained and free of secrets; reuse a name to update rather than duplicating.`,
      '- Memory is a claim, not a fact: check a remembered detail before acting on it, and drop or correct the note as soon as it contradicts what you now know.',
    )
  }
  const memory = memorySection(options.memory)
  if (memory !== undefined) lines.push('', memory)
  if (options.extra !== undefined && options.extra.trim().length > 0) {
    lines.push('', options.extra.trim())
  }
  return lines.join('\n')
}
