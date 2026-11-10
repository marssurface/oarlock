import { MEMORY_KINDS, MEMORY_RELATIVE_DIR, memorySlug, memoryStore } from '../core/memory.ts'
import type { MemoryKind } from '../core/memory.ts'
import type { ToolDefinition, ToolResult } from './types.ts'
import { objectSchema, stringArg } from './util.ts'

export const MEMORY_TOOL_NAME = 'remember'

const ACTIONS = ['write', 'remove'] as const
type MemoryAction = (typeof ACTIONS)[number]

/**
 * Notes are the only memory the runtime keeps, so writing one is a visible,
 * approved action rather than a side effect of the model talking to itself.
 */
export const rememberTool: ToolDefinition = {
  name: MEMORY_TOOL_NAME,
  description:
    'Save or drop a short note that survives this session (stored as markdown under `.agent/memory/`). Write one when a fact, preference, decision or procedure you just learned would save real work in a later session — the file name is a slug, `description` is the one line shown in every future session, and the body is the note itself. Drop one when it turns out to be wrong or stale. Do not store what the repo already records, and do not store secrets.',
  risk: 'write',
  parameters: objectSchema(
    {
      action: { type: 'string', enum: ACTIONS, description: 'write creates or replaces a note; remove deletes it.' },
      name: {
        type: 'string',
        description: 'Short kebab-case slug identifying the note, e.g. "dev-server-cwd". Reusing a name replaces that note.',
      },
      description: {
        type: 'string',
        description: 'One line saying what the note is for; shown in every later session so you know whether to read it.',
      },
      kind: {
        type: 'string',
        enum: [...MEMORY_KINDS],
        description: 'fact (how things are), preference (what the user wants), decision (what was settled), procedure (how to do it).',
      },
      content: { type: 'string', description: 'The note body. Short, self-contained, and true without this conversation.' },
    },
    ['action', 'name'],
  ),
  ruleKeyFor(args) {
    const slug = memorySlug(String(args['name'] ?? ''))
    if (slug === '') return undefined
    return `${MEMORY_TOOL_NAME}:${String(args['action'] ?? 'write')}:${slug}`
  },
  summaryFor(args) {
    const slug = memorySlug(String(args['name'] ?? ''))
    const action = args['action'] === 'remove' ? 'remove' : 'write'
    return `${MEMORY_TOOL_NAME} ${action}: ${slug === '' ? '(invalid name)' : `${MEMORY_RELATIVE_DIR}/${slug}.md`}`
  },
  async execute(args, ctx): Promise<ToolResult> {
    const actionRaw = String(args['action'] ?? '')
    if (!(ACTIONS as readonly string[]).includes(actionRaw)) {
      return { content: `action must be ${ACTIONS.join(' or ')}`, isError: true }
    }
    const action = actionRaw as MemoryAction
    const store = memoryStore(ctx.cwd)
    const requested = stringArg(args, 'name')

    if (action === 'remove') {
      const result = store.remove(requested)
      if (!result.removed) return { content: result.error ?? 'nothing removed', isError: true }
      return { content: `removed memory ${requested} (${store.list().length} left)` }
    }

    const result = store.write({
      name: requested,
      description: typeof args['description'] === 'string' ? args['description'] : undefined,
      kind: (typeof args['kind'] === 'string' ? args['kind'] : undefined) as MemoryKind | undefined,
      body: typeof args['content'] === 'string' ? args['content'] : '',
    })
    if (!result.ok) return { content: result.error, isError: true }
    return {
      content: [
        `${result.created ? 'saved' : 'updated'} memory "${result.entry.name}" (${result.entry.kind}) in ${store.dir}`,
        `It will be listed in the system prompt of later sessions; read it back with read_file on ${result.entry.name}.md if you need the full note.`,
      ].join('\n'),
    }
  },
}
