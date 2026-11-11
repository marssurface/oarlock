import type { ToolDefinition, ToolResult } from './types.ts'
import { objectSchema, stringArg } from './util.ts'

/** The delegation tool's name; the loop specialises in it (batching, events). */
export const TASK_TOOL_NAME = 'task'

/**
 * Delegation primitive: the parent agent starts a child agent with a fresh
 * context and only the child's final answer comes back. The child keeps the
 * same provider and tool set (minus `task`, so recursion terminates).
 */
export const taskTool: ToolDefinition = {
  name: TASK_TOOL_NAME,
  description:
    'Delegate a self-contained task to a subagent with its own context. Give it a short description and a complete prompt; it returns a final report. Use it for broad searches or independent work that would flood this conversation — independent delegations can be sent in one message and run in parallel. Route with `agent` (explore for read-only search, general for multi-step work), optionally pick a cheaper `model`, and restrict `tools` to the minimum needed.',
  risk: 'read',
  timeoutMs: 300_000,
  parameters: objectSchema(
    {
      description: { type: 'string', description: 'Short task name, 3-5 words.' },
      prompt: { type: 'string', description: 'Complete instructions for the subagent; it cannot see this conversation.' },
      agent: { type: 'string', description: 'Preset to route to. Built-ins are "explore" (read-only search) and "general" (default, may edit/run); the system prompt lists any extra presets this workspace defines under .agent/agents/.' },
      model: { type: 'string', description: 'Model name for the subagent on the same gateway; use a cheaper model for simple searches.' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tool allowlist for the subagent (least privilege); intersected with the parent tools, so it can never exceed them.',
      },
    },
    ['description', 'prompt'],
  ),
  async execute(args, ctx): Promise<ToolResult> {
    if (ctx.spawnSubagent === undefined) {
      return { content: 'subagents are not available in this context', isError: true }
    }
    const description = stringArg(args, 'description')
    const prompt = stringArg(args, 'prompt')
    const agent = typeof args['agent'] === 'string' && args['agent'].trim().length > 0 ? args['agent'].trim() : undefined
    const model = typeof args['model'] === 'string' && args['model'].trim().length > 0 ? args['model'].trim() : undefined
    const tools = Array.isArray(args['tools'])
      ? (args['tools'] as unknown[]).filter((name): name is string => typeof name === 'string' && name.trim().length > 0).map((name) => name.trim())
      : undefined
    try {
      const report = await ctx.spawnSubagent({
        description,
        prompt,
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })
      return { content: report }
    } catch (error) {
      return { content: `subagent failed: ${(error as Error).message}`, isError: true }
    }
  },
}
