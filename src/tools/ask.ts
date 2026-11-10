import type { AskAnswer, AskOption, AskRequest, ToolDefinition, ToolResult } from './types.ts'
import { objectSchema } from './util.ts'

export const ASK_TOOL_NAME = 'ask_user'

const MIN_OPTIONS = 2
const MAX_OPTIONS = 4

/**
 * Validate the model's arguments for `ask_user`. Returns either a ready
 * request or a one-line error the agent hands back to the model.
 */
export function parseAskArgs(args: Record<string, unknown>): { request: AskRequest } | { error: string } {
  const question = typeof args['question'] === 'string' ? args['question'].trim() : ''
  if (question.length === 0) return { error: 'question is required' }
  const header = typeof args['header'] === 'string' && args['header'].trim().length > 0 ? args['header'].trim() : undefined
  const raw = args['options']
  if (!Array.isArray(raw)) return { error: 'options must be an array' }
  const options: AskOption[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { error: 'each option must be an object' }
    const entry = item as Record<string, unknown>
    const label = typeof entry['label'] === 'string' ? entry['label'].trim() : ''
    if (label.length === 0) return { error: 'each option needs a non-empty label' }
    const description = typeof entry['description'] === 'string' && entry['description'].trim() !== ''
      ? entry['description'].trim()
      : undefined
    options.push({
      label,
      ...(description !== undefined ? { description } : {}),
      recommended: entry['recommended'] === true,
    })
  }
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return { error: `ask_user needs ${MIN_OPTIONS}–${MAX_OPTIONS} options` }
  }
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    return { error: 'option labels must be unique' }
  }
  return {
    request: {
      question,
      ...(header !== undefined ? { header } : {}),
      options,
      multiSelect: args['multiSelect'] === true,
      allowOther: args['allowOther'] === true,
    },
  }
}

/** The text the model sees as the tool result for `ask_user`. */
export function formatAskAnswer(request: AskRequest, answer: AskAnswer): string {
  if (answer.status === 'skipped') {
    return 'The user skipped the question. Proceed with your best judgment and state the assumption you made.'
  }
  const lines = [`The user answered "${request.question}".`]
  lines.push(`Selected: ${answer.selected.join('; ')}`)
  if (answer.other !== undefined && answer.other.trim() !== '') lines.push(`Other: ${answer.other.trim()}`)
  return lines.join('\n')
}

export const askTool: ToolDefinition = {
  name: ASK_TOOL_NAME,
  description:
    'Ask the user a question when a real decision is ambiguous: a preference, a missing requirement, or a choice between approaches. Offer 2-4 concrete, mutually exclusive options, mark the one you recommend, and set multiSelect when several can apply at once. Do not ask when you can make a reasonable choice and continue.',
  risk: 'read',
  parameters: objectSchema(
    {
      question: { type: 'string', description: 'The question to ask, one line and concrete.' },
      header: { type: 'string', description: 'Optional short section title for the question card (max ~12 chars).' },
      options: {
        type: 'array',
        description: '2-4 concrete options; mark the one you recommend.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short option label (one line).' },
            description: { type: 'string', description: 'One line clarifying what choosing this means.' },
            recommended: { type: 'boolean', description: 'Mark the option you recommend (at most one).' },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
      multiSelect: { type: 'boolean', description: 'Whether the user may pick several options at once.' },
      allowOther: { type: 'boolean', description: 'Whether the user may type a custom answer instead.' },
    },
    ['question', 'options'],
  ),
  async execute(): Promise<ToolResult> {
    // The Agent intercepts ask_user before execution; reaching this point
    // means the runtime is not wired for questions.
    return { content: 'ask_user is not available in this context', isError: true }
  },
}
