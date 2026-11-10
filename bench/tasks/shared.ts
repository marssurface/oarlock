import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentEvent } from '../../src/core/events.ts'
import type { ProviderEvent } from '../../src/providers/types.ts'

/** Write a map of relative paths to file contents. */
export function fixture(dir: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(dir, relPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
}

export function call(id: string, name: string, args: unknown): ProviderEvent {
  return { type: 'tool-call', call: { id, name, arguments: JSON.stringify(args) } }
}

export function say(text: string): ProviderEvent {
  return { type: 'text-delta', text }
}

export function done(reason: 'stop' | 'tool_calls'): ProviderEvent {
  return { type: 'done', finishReason: reason }
}

type ToolResultEvent = Extract<AgentEvent, { type: 'tool-result' }>

export function toolResults(events: AgentEvent[], name?: string): ToolResultEvent[] {
  return events.filter(
    (event): event is ToolResultEvent =>
      event.type === 'tool-result' && (name === undefined || event.name === name),
  )
}

export function lastAnswer(events: AgentEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn-end') return event.text
  }
  return ''
}

export function toolCalls(events: AgentEvent[], name?: string): AgentEvent[] {
  return events.filter((event) => event.type === 'tool-call' && (name === undefined || event.name === name))
}

/** Run `node --test <file>` inside the fixture directory. */
export function runNodeTests(dir: string, file: string): { code: number; output: string } {
  const result = spawnSync(process.execPath, ['--test', file], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, CI: '1' },
  })
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
