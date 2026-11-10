import type { ToolDefinition } from './types.ts'

export const TODO_TOOL_NAME = 'todo_write'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  /** Stable short id the model reuses between updates, e.g. `1` or `scan`. */
  id: string
  content: string
  status: TodoStatus
}

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']
const MAX_ITEMS = 20
const MAX_CONTENT = 200

export type ParsedTodos = { todos: TodoItem[] } | { error: string }

export function parseTodoArgs(args: Record<string, unknown>): ParsedTodos {
  const raw = args['todos']
  if (!Array.isArray(raw)) return { error: 'todos must be an array' }
  if (raw.length > MAX_ITEMS) return { error: `todos may hold at most ${MAX_ITEMS} items` }
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  for (let index = 0; index < raw.length; index += 1) {
    const entry: unknown = raw[index]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: `todos[${index}] must be an object` }
    }
    const record = entry as Record<string, unknown>
    const content = typeof record['content'] === 'string' ? record['content'].trim() : ''
    if (content.length === 0) return { error: `todos[${index}].content must be a non-empty string` }
    if (content.length > MAX_CONTENT) return { error: `todos[${index}].content is longer than ${MAX_CONTENT} chars` }
    const status = STATUSES.find((candidate) => candidate === record['status'])
    if (status === undefined) {
      return { error: `todos[${index}].status must be pending, in_progress or completed` }
    }
    const id =
      typeof record['id'] === 'string' && record['id'].trim().length > 0
        ? record['id'].trim()
        : `t${index + 1}`
    if (seen.has(id)) return { error: `duplicate todo id: ${id}` }
    seen.add(id)
    todos.push({ id, content, status })
  }
  if (todos.filter((todo) => todo.status === 'in_progress').length > 1) {
    return { error: 'at most one todo may be in_progress' }
  }
  return { todos }
}

const MARKS: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
}

/** The tool result the model sees after each update. */
export function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Todo list cleared.'
  const done = todos.filter((todo) => todo.status === 'completed').length
  return [
    `Current plan (${done}/${todos.length} done):`,
    ...todos.map((todo) => `${MARKS[todo.status]} ${todo.id}: ${todo.content}`),
  ].join('\n')
}

/** One-line form for trace rows and CLI summaries. */
export function summarizeTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '已清空'
  const done = todos.filter((todo) => todo.status === 'completed').length
  const current = todos.find((todo) => todo.status === 'in_progress')
  return `${done}/${todos.length} 完成${current !== undefined ? ` · ${current.content}` : ''}`
}

export const todoTool: ToolDefinition = {
  name: TODO_TOOL_NAME,
  description:
    'Create or update the task plan for this turn. Send the complete list every time; it replaces the previous plan. Keep at most one item in_progress, and mark items completed as soon as they are done. Use it for multi-step work, not for a single trivial action.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full todo list, replacing the previous plan. Send [] to clear it.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable short id reused between updates, e.g. "1" or "scan".' },
            content: { type: 'string', description: 'One-line description of the task.' },
            status: { type: 'string', enum: STATUSES, description: 'pending, in_progress or completed.' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  risk: 'read',
  execute(args) {
    const parsed = parseTodoArgs(args)
    if ('error' in parsed) return Promise.resolve({ content: parsed.error, isError: true })
    return Promise.resolve({ content: formatTodoList(parsed.todos) })
  },
}
