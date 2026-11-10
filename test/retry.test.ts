import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent, MAX_RETRY_DELAY_MS, computeRetryDelayMs } from '../src/core/agent.ts'
import { autoApproval } from '../src/core/approval.ts'
import type { ChatProvider, ProviderEvent } from '../src/providers/types.ts'
import { ProviderError } from '../src/providers/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { collect, tempDir } from './helpers.ts'

function agent(cwd: string, provider: ChatProvider, options: { maxRetries?: number } = {}): Agent {
  return new Agent({
    provider,
    cwd,
    approval: autoApproval(),
    tools: new ToolRegistry([]),
    retryDelayMs: 1,
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  })
}

test('retries a transient failure before any output', async () => {
  let attempts = 0
  const provider: ChatProvider = {
    id: 'flaky',
    model: 'flaky-1',
    async *stream(): AsyncGenerator<ProviderEvent> {
      attempts += 1
      if (attempts === 1) throw new ProviderError('overloaded', { status: 503 })
      yield { type: 'text-delta', text: 'recovered' }
      yield { type: 'done', finishReason: 'stop' }
    },
  }

  const events = await collect(agent(tempDir(), provider).run('hi'))
  assert.equal(attempts, 2)
  assert.ok(events.some((event) => event.type === 'retry' && event.attempt === 1))
  const end = events.at(-1)
  assert.equal(end?.type, 'turn-end')
  assert.equal(end?.type === 'turn-end' ? end.text : '', 'recovered')
})

test('auth errors are not retried', async () => {
  let attempts = 0
  const provider: ChatProvider = {
    id: 'bad',
    model: 'm',
    async *stream(): AsyncGenerator<ProviderEvent> {
      attempts += 1
      throw new ProviderError('bad key', { status: 401 })
    },
  }

  const events = await collect(agent(tempDir(), provider).run('hi'))
  assert.equal(attempts, 1)
  assert.ok(!events.some((event) => event.type === 'retry'))
  assert.equal(events.at(-1)?.type, 'error')
})

test('does not retry once text has been streamed', async () => {
  let attempts = 0
  const provider: ChatProvider = {
    id: 'half',
    model: 'm',
    async *stream(): AsyncGenerator<ProviderEvent> {
      attempts += 1
      yield { type: 'text-delta', text: 'partial answer' }
      throw new ProviderError('boom', { status: 503 })
    },
  }

  const instance = agent(tempDir(), provider)
  const events = await collect(instance.run('hi'))
  assert.equal(attempts, 1)
  assert.ok(!events.some((event) => event.type === 'retry'))
  assert.equal(events.at(-1)?.type, 'error')
  // The partial assistant message is discarded: only the user turn is kept.
  assert.deepEqual(instance.history().map((message) => message.role), ['user'])
})

test('gives up after the retry budget', async () => {
  let attempts = 0
  const provider: ChatProvider = {
    id: 'down',
    model: 'm',
    async *stream(): AsyncGenerator<ProviderEvent> {
      attempts += 1
      throw new ProviderError('still down', { status: 502 })
    },
  }

  const events = await collect(agent(tempDir(), provider, { maxRetries: 1 }).run('hi'))
  assert.equal(attempts, 2)
  assert.equal(events.filter((event) => event.type === 'retry').length, 1)
  assert.equal(events.at(-1)?.type, 'error')
})

test('computeRetryDelayMs combines backoff with Retry-After under a cap', () => {
  // Plain exponential backoff when the server says nothing.
  assert.equal(computeRetryDelayMs(1, 500), 500)
  assert.equal(computeRetryDelayMs(3, 500), 2000)
  // The larger of backoff and the server hint wins.
  assert.equal(computeRetryDelayMs(1, 500, 4000), 4000)
  assert.equal(computeRetryDelayMs(3, 500, 100), 2000)
  assert.equal(computeRetryDelayMs(1, 500, 0), 500)
  // A hostile or mistaken header cannot stall the turn for hours.
  assert.equal(computeRetryDelayMs(1, 500, 3_600_000), MAX_RETRY_DELAY_MS)
  assert.equal(computeRetryDelayMs(20, 500), MAX_RETRY_DELAY_MS)
})

test('retry waits for the server Retry-After and reports it', async () => {
  let attempts = 0
  const provider: ChatProvider = {
    id: 'limited',
    model: 'm',
    async *stream(): AsyncGenerator<ProviderEvent> {
      attempts += 1
      if (attempts === 1) throw new ProviderError('rate limited', { status: 429, retryAfterMs: 25 })
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    },
  }

  const startedAt = Date.now()
  const events = await collect(agent(tempDir(), provider).run('hi'))
  assert.equal(attempts, 2)
  const retry = events.find((event) => event.type === 'retry')
  assert.ok(retry !== undefined && retry.type === 'retry')
  // Base delay is 1ms in this suite; the server hint must dominate.
  assert.equal(retry.delayMs, 25)
  assert.equal(retry.retryAfterMs, 25)
  assert.ok(Date.now() - startedAt >= 20)
  assert.equal(events.at(-1)?.type, 'turn-end')
})

test('retry events without a server hint stay unchanged', async () => {
  let attempts = 0
  const provider: ChatProvider = {
    id: 'flaky',
    model: 'm',
    async *stream(): AsyncGenerator<ProviderEvent> {
      attempts += 1
      if (attempts === 1) throw new ProviderError('overloaded', { status: 503 })
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    },
  }

  const events = await collect(agent(tempDir(), provider).run('hi'))
  const retry = events.find((event) => event.type === 'retry')
  assert.ok(retry !== undefined && retry.type === 'retry')
  assert.equal(retry.delayMs, 1)
  assert.equal(retry.retryAfterMs, undefined)
})
