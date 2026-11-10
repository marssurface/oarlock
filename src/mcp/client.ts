import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { McpServerConfig } from './config.ts'

/** MCP protocol version we advertise during the handshake. */
const PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_TIMEOUT = 15_000
const MAX_STDERR = 8_000

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export interface McpCallResult {
  content?: McpContentBlock[]
  structuredContent?: unknown
  isError?: boolean
}

export class McpError extends Error {
  readonly code: number | undefined

  constructor(message: string, code?: number) {
    super(message)
    this.name = 'McpError'
    this.code = code
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Minimal MCP stdio client: spawn one server, speak newline-delimited JSON-RPC
 * 2.0 over its stdin/stdout, and expose initialize / tools/list / tools/call.
 * Server logs on stderr are captured for diagnostics only.
 */
export class McpClient {
  private readonly name: string
  private readonly timeoutMs: number
  private readonly child: ChildProcess
  private readonly pending = new Map<number, Pending>()
  private buffer = ''
  private nextId = 1
  private stderrTail = ''
  private closed = false

  private constructor(name: string, child: ChildProcess, timeoutMs: number) {
    this.name = name
    this.child = child
    this.timeoutMs = timeoutMs

    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR)
    })
    child.on('error', (error) => {
      this.closed = true
      this.failAll(new McpError(`mcp server ${name}: ${error.message}`))
    })
    child.on('exit', (code) => {
      this.closed = true
      const detail = this.stderrTail.trim()
      this.failAll(
        new McpError(`mcp server ${name} exited (code ${code === null ? 'signal' : String(code)})${detail !== '' ? `: ${detail}` : ''}`),
      )
    })
  }

  static async connect(name: string, config: McpServerConfig): Promise<McpClient> {
    const child = spawn(config.command, config.args ?? [], {
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = new McpClient(name, child, config.timeoutMs ?? DEFAULT_TIMEOUT)
    await client.handshake()
    return client
  }

  private async handshake(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'oarlock', version: '0.1.0' },
    })
    this.notify('notifications/initialized', {})
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request('tools/list', {})
    const raw = result !== null && typeof result === 'object' ? (result as Record<string, unknown>)['tools'] : undefined
    if (!Array.isArray(raw)) return []
    const tools: McpToolInfo[] = []
    for (const item of raw as unknown[]) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const name = typeof record['name'] === 'string' ? record['name'] : ''
      if (name === '') continue
      const info: McpToolInfo = { name }
      if (typeof record['description'] === 'string') info.description = record['description']
      if (record['inputSchema'] !== undefined) info.inputSchema = record['inputSchema']
      tools.push(info)
    }
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    const record = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {}
    const output: McpCallResult = {}
    if (Array.isArray(record['content'])) output.content = record['content'] as McpContentBlock[]
    if (record['structuredContent'] !== undefined) output.structuredContent = record['structuredContent']
    if (record['isError'] === true) output.isError = true
    return output
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failAll(new McpError(`mcp server ${this.name} closed`))
    try {
      this.child.stdin?.end()
    } catch {
      // already closed
    }
    try {
      this.child.kill('SIGTERM')
    } catch {
      // already gone
    }
    // Escalate if it ignores SIGTERM; the timer is unref'd so it never holds the loop.
    const timer = setTimeout(() => {
      try {
        this.child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, 500)
    timer.unref()
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) this.onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    const record = message as Record<string, unknown>
    const id = record['id']
    if (typeof id !== 'number') return // notifications and server-initiated requests are ignored
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)

    const error = record['error']
    if (error !== null && typeof error === 'object') {
      const detail = error as Record<string, unknown>
      const code = typeof detail['code'] === 'number' ? detail['code'] : undefined
      pending.reject(new McpError(typeof detail['message'] === 'string' ? detail['message'] : 'mcp error', code))
      return
    }
    pending.resolve(record['result'])
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.child.stdin === null) throw new McpError(`mcp server ${this.name} is not running`)
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError(`mcp server ${this.name}: ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
