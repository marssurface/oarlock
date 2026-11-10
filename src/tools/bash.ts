import { spawn } from 'node:child_process'
import type { ToolDefinition, ToolResult } from './types.ts'
import { numberArg, objectSchema, stringArg } from './util.ts'

const MAX_CAPTURE = 200_000
const DEFAULT_TIMEOUT = 60_000
const MAX_TIMEOUT = 300_000

const FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[A-Za-z]+\s+)*\/(\*?)(\s|$)/, reason: 'refusing to delete the filesystem root' },
  { pattern: /\bmkfs(\.[A-Za-z0-9]+)?\b/, reason: 'refusing to format a filesystem' },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//, reason: 'refusing to write a raw device' },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, reason: 'refusing a fork bomb' },
]

/**
 * Commands run through `bash -c`, not a login shell: the agent already
 * inherits its own environment, and sourcing the user's profile can trigger
 * unrelated hooks (pyenv rehash, version managers) that hang or print noise.
 */
export interface ShellResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  truncated: boolean
}

/** Run one command in bash -lc with a hard timeout and capped output. */
export function runShell(
  command: string,
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ShellResult> {
  const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT))

  return new Promise<ShellResult>((resolvePromise) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd: options.cwd,
      env: {
        ...process.env,
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        TERM: process.env['TERM'] ?? 'dumb',
        CI: process.env['CI'] ?? '1',
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let aborted = false
    let settled = false

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      if (target === 'stdout') {
        if (stdout.length + text.length > MAX_CAPTURE) {
          stdout += text.slice(0, Math.max(0, MAX_CAPTURE - stdout.length))
          truncated = true
        } else {
          stdout += text
        }
      } else if (stderr.length + text.length > MAX_CAPTURE) {
        stderr += text.slice(0, Math.max(0, MAX_CAPTURE - stderr.length))
        truncated = true
      } else {
        stderr += text
      }
    }

    const killTree = (): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
    timer.unref()

    const onAbort = (): void => {
      aborted = true
      killTree()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolvePromise({ code, stdout, stderr, timedOut, aborted, truncated })
    }

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.on('error', (error) => {
      append('stderr', Buffer.from(String(error)))
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Run a shell command with bash -c in the working directory and return its exit code, stdout and stderr. Use it for builds, tests and git; prefer dedicated file tools for reading and editing.',
  risk: 'exec',
  parameters: objectSchema(
    {
      command: { type: 'string', description: 'Shell command to run.' },
      timeout_ms: { type: 'number', description: `Timeout in milliseconds (default 60000, max ${MAX_TIMEOUT}).` },
    },
    ['command'],
  ),
  async execute(args, ctx): Promise<ToolResult> {
    const command = stringArg(args, 'command')
    const timeoutMs = numberArg(args, 'timeout_ms', { min: 1_000, max: MAX_TIMEOUT }) ?? DEFAULT_TIMEOUT

    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(command)) return { content: `${rule.reason}: ${command}`, isError: true }
    }

    const result = await runShell(command, {
      cwd: ctx.cwd,
      timeoutMs,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    })

    const status = [
      `exit=${result.code === null ? 'signal' : String(result.code)}`,
      ...(result.timedOut ? ['timed out'] : []),
      ...(result.aborted ? ['aborted'] : []),
      ...(result.truncated ? ['output truncated'] : []),
    ].join(' ')
    const parts = [status]
    if (result.stdout.length > 0) parts.push(`--- stdout ---\n${result.stdout}`)
    if (result.stderr.length > 0) parts.push(`--- stderr ---\n${result.stderr}`)
    if (result.stdout.length === 0 && result.stderr.length === 0) parts.push('(no output)')
    // A killed command is a failure even though its exit code is null.
    return {
      content: parts.join('\n'),
      isError: result.timedOut || result.aborted || (result.code !== 0 && result.code !== null),
    }
  },
}
