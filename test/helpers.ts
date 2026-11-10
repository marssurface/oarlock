import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockProvider } from '../src/providers/mock.ts'
import type { MockScript } from '../src/providers/mock.ts'
import type { ProviderEvent } from '../src/providers/types.ts'
import type { AgentEvent } from '../src/core/events.ts'

export function tempDir(prefix = 'oarlock-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function scripted(script: MockScript): MockProvider {
  return new MockProvider({ script })
}

export async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

export function text(value: string): ProviderEvent[] {
  return [
    { type: 'text-delta', text: value },
    { type: 'done', finishReason: 'stop' },
  ]
}
