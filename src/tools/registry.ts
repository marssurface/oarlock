import type { ToolSpec } from '../providers/types.ts'
import { askTool } from './ask.ts'
import { bashTool } from './bash.ts'
import { fileTools } from './fs.ts'
import { rememberTool } from './memory.ts'
import { taskTool } from './task.ts'
import { todoTool } from './todo.ts'
import { toolSpec } from './types.ts'
import type { ToolDefinition } from './types.ts'
import { webFetchTool } from './web_fetch.ts'

/** Ordered, name-addressed tool set; the agent renders its `specs()` for the model. */
export class ToolRegistry {
  private readonly tools: Map<string, ToolDefinition>

  constructor(tools: ToolDefinition[] = []) {
    this.tools = new Map()
    for (const tool of tools) this.add(tool)
  }

  add(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`)
    this.tools.set(tool.name, tool)
    return this
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  names(): string[] {
    return this.list().map((tool) => tool.name)
  }

  specs(): ToolSpec[] {
    return this.list().map(toolSpec)
  }

  /** A copy without one tool; used to stop `task` recursion in subagents. */
  without(name: string): ToolRegistry {
    return new ToolRegistry(this.list().filter((tool) => tool.name !== name))
  }

  static default(options: { allowShell?: boolean; includeTask?: boolean } = {}): ToolRegistry {
    const tools: ToolDefinition[] = [...fileTools, rememberTool, todoTool, askTool, webFetchTool()]
    if (options.allowShell !== false) tools.push(bashTool)
    if (options.includeTask !== false) tools.push(taskTool)
    return new ToolRegistry(tools)
  }
}
