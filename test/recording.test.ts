import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { autoApproval } from '../src/core/approval.ts'
import { createRuntime } from '../src/core/setup.ts'
import { DebugRecordingProvider, recordingTarget } from '../src/providers/recording.ts'
import type { DebugRecording } from '../src/providers/recording.ts'
import { ProviderError } from '../src/providers/types.ts'
import type { ChatProvider, ProviderEvent } from '../src/providers/types.ts'
import { SessionStore } from '../src/session/store.ts'
import { collect, tempDir } from './helpers.ts'

const ENV_KEYS = ['AGENT_RECORD', 'AGENT_RECORD_DIR'] as const

async function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, run: () => Promise<void> | void): Promise<void> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function readRecordings(dir: string): DebugRecording[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as DebugRecording)
}

function provider(events: ProviderEvent[], error?: ProviderError): ChatProvider {
  return {
    id: 'rec-test',
    model: 'base-model',
    async *stream(): AsyncGenerator<ProviderEvent> {
      for (const event of events) yield event
      if (error !== undefined) throw error
    },
  }
}

test('recordingTarget reads the switch and the directory override', async () => {
  const cwd = tempDir()
  await withEnv({}, () => {
    assert.equal(recordingTarget(cwd), undefined)
  })
  await withEnv({ AGENT_RECORD: '1' }, () => {
    assert.equal(recordingTarget(cwd), join(cwd, '.agent', 'recordings'))
  })
  await withEnv({ AGENT_RECORD: '0' }, () => {
    assert.equal(recordingTarget(cwd), undefined)
  })
  await withEnv({ AGENT_RECORD_DIR: 'dumps' }, () => {
    // The directory override enables recording on its own.
    assert.equal(recordingTarget(cwd), join(cwd, 'dumps'))
  })
  await withEnv({ AGENT_RECORD: '1', AGENT_RECORD_DIR: '/tmp/elsewhere' }, () => {
    assert.equal(recordingTarget(cwd), '/tmp/elsewhere')
  })
})

test('each call dumps the request and raw events as one JSON file', async () => {
  const dir = join(tempDir(), 'recordings')
  const inner = provider([
    { type: 'reasoning-delta', text: 'hmm' },
    { type: 'text-delta', text: 'hello' },
    { type: 'done', finishReason: 'stop' },
  ])
  const wrapped = new DebugRecordingProvider(inner, dir)
  const controller = new AbortController()
  const events: ProviderEvent[] = []
  for await (const event of wrapped.stream({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'override-model',
    signal: controller.signal,
  })) {
    events.push(event)
  }
  assert.equal(events.length, 3)
  const recordings = readRecordings(dir)
  assert.equal(recordings.length, 1)
  const record = recordings[0]
  assert.ok(record !== undefined)
  assert.equal(record.version, 1)
  assert.equal(record.provider, 'rec-test')
  assert.equal(record.model, 'override-model')
  assert.deepEqual(record.request.messages, [{ role: 'user', content: 'hi' }])
  // The AbortSignal is not serializable and must not leak into the dump.
  assert.equal('signal' in record.request, false)
  assert.deepEqual(record.events, events)
  assert.equal(record.error, undefined)
  assert.ok(record.durationMs >= 0)

  // A second call lands in a second file, in order.
  for await (const _event of wrapped.stream({ messages: [{ role: 'user', content: 'again' }] })) {
    // drain
  }
  const all = readRecordings(dir)
  assert.equal(all.length, 2)
  assert.equal(all[1]?.model, 'base-model')
})

test('failures are recorded with status and Retry-After, then rethrown', async () => {
  const dir = join(tempDir(), 'recordings')
  const inner = provider(
    [{ type: 'text-delta', text: 'partial' }],
    new ProviderError('rate limited', { status: 429, retryAfterMs: 7000 }),
  )
  const wrapped = new DebugRecordingProvider(inner, dir)
  await assert.rejects(
    async () => {
      for await (const _event of wrapped.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        // drain
      }
    },
    /rate limited/,
  )
  const record = readRecordings(dir)[0]
  assert.ok(record !== undefined)
  assert.deepEqual(record.events, [{ type: 'text-delta', text: 'partial' }])
  assert.deepEqual(record.error, { message: 'rate limited', status: 429, retryAfterMs: 7000 })
})

test('unwritable targets never break the stream', async () => {
  const dir = tempDir()
  const blocker = join(dir, 'not-a-dir')
  writeFileSync(blocker, 'file in the way')
  const inner = provider([{ type: 'text-delta', text: 'still works' }, { type: 'done', finishReason: 'stop' }])
  const wrapped = new DebugRecordingProvider(inner, blocker)
  const events: ProviderEvent[] = []
  for await (const event of wrapped.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(event)
  assert.equal(events.length, 2)
  assert.equal(existsSync(join(blocker, 'anything')), false)
})

test('createRuntime wraps the provider only when the switch is on', async () => {
  const cwd = tempDir()
  const config = resolveConfig({ cwd, provider: 'mock', model: 'mock-1' })
  const store = new SessionStore(config.sessionsDir)

  await withEnv({}, () => {
    const session = store.create({ cwd, provider: config.provider, model: config.model })
    const runtime = createRuntime(config, session, { approval: autoApproval() })
    assert.equal(runtime.provider instanceof DebugRecordingProvider, false)
  })

  await withEnv({ AGENT_RECORD: '1' }, async () => {
    const session = store.create({ cwd, provider: config.provider, model: config.model })
    const runtime = createRuntime(config, session, { approval: autoApproval() })
    assert.equal(runtime.provider instanceof DebugRecordingProvider, true)
    const events = await collect(runtime.agent.run('hello there'))
    assert.equal(events.at(-1)?.type, 'turn-end')
    const recordings = readRecordings(join(cwd, '.agent', 'recordings'))
    assert.ok(recordings.length >= 1)
    const first = recordings[0]
    assert.ok(first !== undefined)
    assert.equal(first.provider, 'mock')
    assert.ok(JSON.stringify(first.request.messages).includes('hello there'))
    assert.ok(first.events.some((event) => event.type === 'done'))
  })
})