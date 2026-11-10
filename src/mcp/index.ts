import type { JsonSchema } from '../providers/types.ts'
import type { Risk, ToolDefinition, ToolResult } from '../tools/types.ts'
import { McpClient } from './client.ts'
import type { McpCallResult, McpToolInfo } from './client.ts'
import { readMcpConfig } from './config.ts'

export { McpClient, McpError } from './client.ts'
export type { McpCallResult, McpContentBlock, McpToolInfo } from './client.ts'
export { emptyMcpConfig, parseMcpConfig, readMcpConfig } from './config.ts'
export type { McpConfig, McpServerConfig } from './config.ts'

export interface McpLoadResult {
  /** Tools converted from every reachable server, namespaced `mcp__<server>__<tool>`. */
  tools: ToolDefinition[]
  /** Servers that handshook and listed tools. */
  servers: string[]
  /** Per-server failures; a broken server is skipped rather than blocking the harness. */
  errors: string[]
  close(): Promise<void>
}

const DEFAULT_RISK: Risk = 'exec'

/**
 * Spawn and handshake every configured MCP server, then convert its tools. A
 * server that fails (spawn error, bad handshake, timeout) is skipped and its
 * reason collected, so one bad entry never blocks the rest. No config means no
 * processes and an empty result.
 */
export async function loadMcpServers(cwd: string): Promise<McpLoadResult> {
  const config = readMcpConfig(cwd)
  const tools: ToolDefinition[] = []
  const servers: string[] = []
  const errors: string[] = []
  const clients: McpClient[] = []

  await Promise.all(
    Object.entries(config.servers).map(async ([name, server]) => {
      try {
        const client = await McpClient.connect(name, server)
        clients.push(client)
        const infos = await client.listTools()
        const risk = server.risk ?? DEFAULT_RISK
        for (const info of infos) tools.push(toToolDefinition(name, info, client, risk))
        servers.push(name)
      } catch (error) {
        errors.push(`${name}: ${(error as Error).message}`)
      }
    }),
  )

  tools.sort((a, b) => a.name.localeCompare(b.name))
  return {
    tools,
    servers: servers.sort((a, b) => a.localeCompare(b)),
    errors,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()))
    },
  }
}

function toToolDefinition(server: string, info: McpToolInfo, client: McpClient, risk: Risk): ToolDefinition {
  return {
    name: `mcp__${server}__${info.name}`,
    description:
      info.description !== undefined && info.description.trim() !== ''
        ? info.description
        : `MCP tool ${info.name} from ${server}`,
    parameters: toJsonSchema(info.inputSchema),
    risk,
    async execute(args): Promise<ToolResult> {
      return formatCallResult(await client.callTool(info.name, args))
    },
  }
}

/** MCP inputSchema is JSON Schema; keep the object shape our tool spec needs. */
function toJsonSchema(input: unknown): JsonSchema {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const properties = record['properties']
    if (record['type'] === 'object' && properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      const schema: JsonSchema = { type: 'object', properties: properties as Record<string, unknown> }
      const required = record['required']
      if (Array.isArray(required)) {
        const kept = required.filter((item): item is string => typeof item === 'string')
        if (kept.length > 0) schema.required = kept
      }
      if (typeof record['additionalProperties'] === 'boolean') schema.additionalProperties = record['additionalProperties']
      return schema
    }
  }
  return { type: 'object', properties: {} }
}

function formatCallResult(result: McpCallResult): ToolResult {
  const parts: string[] = []
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else parts.push(typeof block.text === 'string' ? `[${block.type}] ${block.text}` : `[${block.type}]`)
  }
  let content = parts.join('\n').trim()
  if (result.structuredContent !== undefined) {
    const structured = JSON.stringify(result.structuredContent)
    content = content.length > 0 ? `${content}\n\n${structured}` : structured
  }
  if (content.length === 0) content = '(no output)'
  return result.isError === true ? { content, isError: true } : { content }
}
