import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent } from '../src/core/agent.ts'
import { autoApproval } from '../src/core/approval.ts'
import { MockProvider } from '../src/providers/mock.ts'
import type { AgentEvent } from '../src/core/events.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { call, done, fixture } from '../bench/tasks/shared.ts'
import { RecordingProvider, ReplayProvider, fingerprintRequest } from '../bench/transcripts.ts'
import type { ProviderRequest } from '../src/providers/types.ts'
import { tempDir } from './helpers.ts'

const script = (request: ProviderRequest) => {
  const results = request.messages.filter((message) => message.role === 'tool').length
  if (results === 0) return [call('r1', 'read_file', { path: 'src/a.ts' }), done('tool_calls')]
  return [
    { type: 'text-delta' as const, text: 'a is 1' },
    { type: 'done' as const, finishReason: 'stop' as const },
  ]
}

async function run(agent: Agent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of agent.run(prompt)) events.push(event)
  return events
}

test('records a run and replays it in a different workspace', async () => {
  const dir = tempDir()
  fixture(dir, { 'src/a.ts': 'export const a = 1\n' })

  const recorder = new RecordingProvider(new MockProvider({ script }), { cwd: dir })
  const agent = new Agent({
    provider: recorder,
    cwd: dir,
    approval: autoApproval(),
    tools: ToolRegistry.default(),
  })
  const events = await run(agent, 'what is a?')
  const end = events.at(-1)
  assert.equal(end?.type, 'turn-end')

  const transcript = recorder.toTranscript({ task: 'demo', provider: 'mock', model: 'mock-1' })
  assert.equal(transcript.streams.length, 2)
  assert.ok(transcript.streams.every((stream) => stream.events.length > 0))

  // Fresh workspace with the same fixture: absolute paths differ but the
  // fingerprint normalizes them, so replay must line up.
  const other = tempDir()
  fixture(other, { 'src/a.ts': 'export const a = 1\n' })
  const replay = new ReplayProvider(transcript, { cwd: other })
  const replayAgent = new Agent({
    provider: replay,
    cwd: other,
    approval: autoApproval(),
    tools: ToolRegistry.default(),
  })
  const replayed = await run(replayAgent, 'what is a?')
  const replayedEnd = replayed.at(-1)
  assert.equal(replayedEnd?.type, 'turn-end')
  assert.equal(replayedEnd?.type === 'turn-end' ? replayedEnd.text : '', 'a is 1')
  assert.equal(replay.consumed, 2)
})

test('replay refuses a request that drifted from the recording', async () => {
  const dir = tempDir()
  fixture(dir, { 'src/a.ts': 'export const a = 1\n' })
  const recorder = new RecordingProvider(new MockProvider({ script }), { cwd: dir })
  const agent = new Agent({ provider: recorder, cwd: dir, approval: autoApproval(), tools: ToolRegistry.default() })
  await run(agent, 'what is a?')
  const transcript = recorder.toTranscript({ task: 'demo', provider: 'mock', model: 'mock-1' })

  const replay = new ReplayProvider(transcript, { cwd: dir })
  const drifted = new Agent({
    provider: replay,
    cwd: dir,
    approval: autoApproval(),
    tools: ToolRegistry.default(),
    systemPrompt: 'a different system prompt',
  })
  const events = await run(drifted, 'what is a?')
  const error = events.at(-1)
  assert.equal(error?.type, 'error')
  assert.match(error?.type === 'error' ? error.message : '', /replay drift/)
})

test('fingerprints ignore the workspace path', () => {
  const request = (cwd: string): ProviderRequest => ({
    messages: [
      { role: 'system', content: `Working directory: ${cwd}` },
      { role: 'user', content: 'hi' },
    ],
  })
  assert.equal(fingerprintRequest(request('/tmp/a'), '/tmp/a'), fingerprintRequest(request('/tmp/b'), '/tmp/b'))
  assert.notEqual(fingerprintRequest(request('/tmp/a'), '/tmp/a'), fingerprintRequest(request('/tmp/a'), '/tmp/c'))
})
