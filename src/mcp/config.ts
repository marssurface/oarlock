import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Risk } from '../tools/types.ts'

/** One stdio MCP server. `risk` decides approval for all of its tools. */
export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Risk assigned to this server's tools; default `exec` (needs approval). */
  risk?: Risk
  /** Per-request timeout for the handshake / list / call; default 15000. */
  timeoutMs?: number
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>
}

const RISKS: readonly Risk[] = ['read', 'write', 'exec']
const NAME = /^[A-Za-z0-9_-]+$/

export function emptyMcpConfig(): McpConfig {
  return { servers: {} }
}

/** Parse an `.agent/mcp.json` shape, dropping malformed servers and fields. */
export function parseMcpConfig(raw: unknown): McpConfig {
  const config = emptyMcpConfig()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return config
  const servers = (raw as Record<string, unknown>)['servers']
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return config
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const parsed = parseServer(name, value)
    if (parsed !== undefined) config.servers[name] = parsed
  }
  return config
}

function parseServer(name: string, value: unknown): McpServerConfig | undefined {
  // The name becomes part of the tool namespace, so keep it identifier-safe.
  if (!NAME.test(name)) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const command = typeof raw['command'] === 'string' ? raw['command'].trim() : ''
  if (command === '') return undefined

  const server: McpServerConfig = { command }
  const args = raw['args']
  if (Array.isArray(args)) {
    const kept = args.filter((item): item is string => typeof item === 'string')
    if (kept.length > 0) server.args = kept
  }
  const env = raw['env']
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    const pairs: Record<string, string> = {}
    for (const [key, item] of Object.entries(env as Record<string, unknown>)) {
      if (typeof item === 'string') pairs[key] = item
    }
    if (Object.keys(pairs).length > 0) server.env = pairs
  }
  const cwd = typeof raw['cwd'] === 'string' ? raw['cwd'].trim() : ''
  if (cwd !== '') server.cwd = cwd
  const risk = typeof raw['risk'] === 'string' ? raw['risk'] : ''
  if ((RISKS as readonly string[]).includes(risk)) server.risk = risk as Risk
  const timeoutMs = raw['timeoutMs']
  if (typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs > 0) server.timeoutMs = timeoutMs
  return server
}

/** Read `.agent/mcp.json`; a missing or malformed file means no servers. */
export function readMcpConfig(cwd: string): McpConfig {
  try {
    return parseMcpConfig(JSON.parse(readFileSync(resolve(cwd, '.agent/mcp.json'), 'utf8')) as unknown)
  } catch {
    return emptyMcpConfig()
  }
}
