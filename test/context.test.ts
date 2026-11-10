import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent } from '../src/core/agent.ts'
import { autoApproval } from '../src/core/approval.ts'
import { ContextManager, estimateTokens } from '../src/core/context.ts'
import { textOf } from '../src/providers/content.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { collect, scripted, tempDir, text } from './helpers.ts'

test('token estimate counts CJK wider than latin', () => {
  assert.ok(estimateTokens('你好世界') >= 4)
  assert.ok(estimateTokens('hello world') < estimateTokens('你好世界你好世界'))
})

test('compaction replaces the old prefix with a summary and keeps the tail', async () => {
  const provider = scripted(() => text('SUMMARY-OF-OLD-TURNS'))
  const context = new ContextManager({ window: 1_000, threshold: 0.5, keepRecent: 2 })
  const conversation = [
    { role: 'user' as const, content: 'u1 '.repeat(80) },
    { role: 'assistant' as const, content: 'a1 '.repeat(80) },
    { role: 'user' as const, content: 'u2 '.repeat(80) },
    { role: 'assistant' as const, content: 'a2 '.repeat(80) },
    { role: 'user' as const, content: 'u3 '.repeat(80) },
    { role: 'assistant' as const, content: 'a3 '.repeat(80) },
  ]

  const result = await context.compact(conversation, provider)
  assert.ok(result !== undefined)
  assert.equal(result.messages[0]?.role, 'system')
  assert.match(textOf(result.messages[0]?.content ?? ''), /SUMMARY-OF-OLD-TURNS/)
  assert.equal(result.messages.length, 3)
  assert.deepEqual(result.messages.slice(1), conversation.slice(-2))
  assert.equal(result.removedMessages, 4)
  assert.ok(result.afterTokens < result.beforeTokens)
})

test('short conversations are left alone', async () => {
  const provider = scripted(() => text('unused'))
  const context = new ContextManager({ keepRecent: 4 })
  const result = await context.compact(
    [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    provider,
  )
  assert.equal(result, undefined)
})

test('the agent compacts during a turn when the budget is exceeded', async () => {
  const dir = tempDir()
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    if (system.includes('compress an agent conversation')) return text('COMPACTED')
    return text('answer')
  })
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: new ToolRegistry([]),
    context: new ContextManager({ window: 120, threshold: 0.5, keepRecent: 2 }),
  })
  agent.setHistory([
    { role: 'user', content: `u1 ${'x'.repeat(220)}` },
    { role: 'assistant', content: `a1 ${'y'.repeat(220)}` },
    { role: 'user', content: `u2 ${'x'.repeat(220)}` },
    { role: 'assistant', content: `a2 ${'y'.repeat(220)}` },
  ])

  const events = await collect(agent.run('continue'))
  assert.ok(events.some((event) => event.type === 'compaction'))
  const summary = agent.history()[0]
  assert.equal(summary?.role, 'system')
  assert.match(textOf(summary?.content ?? ''), /COMPACTED/)
})

test('compaction records usage and duration for the summary request', async () => {
  const provider = scripted(() => [
    { type: 'text-delta', text: 'SUMMARY-OF-OLD-TURNS' },
    { type: 'usage', usage: { promptTokens: 40, completionTokens: 5, totalTokens: 45 } },
    { type: 'done', finishReason: 'stop' },
  ])
  const context = new ContextManager({ window: 1_000, threshold: 0.5, keepRecent: 2 })
  const conversation = [
    { role: 'user' as const, content: 'u1 '.repeat(80) },
    { role: 'assistant' as const, content: 'a1 '.repeat(80) },
    { role: 'user' as const, content: 'u2 '.repeat(80) },
    { role: 'assistant' as const, content: 'a2 '.repeat(80) },
    { role: 'user' as const, content: 'u3 '.repeat(80) },
    { role: 'assistant' as const, content: 'a3 '.repeat(80) },
  ]

  const result = await context.compact(conversation, provider)
  assert.ok(result !== undefined)
  assert.equal(result.usage?.totalTokens, 45)
  assert.ok(result.durationMs >= 0)
})

test('compaction estimates usage when the provider reports none', async () => {
  const provider = scripted(() => text('SUMMARY'))
  const context = new ContextManager({ window: 1_000, threshold: 0.5, keepRecent: 2 })
  const conversation = [
    { role: 'user' as const, content: 'u1 '.repeat(80) },
    { role: 'assistant' as const, content: 'a1 '.repeat(80) },
    { role: 'user' as const, content: 'u2 '.repeat(80) },
    { role: 'assistant' as const, content: 'a2 '.repeat(80) },
    { role: 'user' as const, content: 'u3 '.repeat(80) },
    { role: 'assistant' as const, content: 'a3 '.repeat(80) },
  ]

  const result = await context.compact(conversation, provider)
  assert.ok(result !== undefined)
  assert.equal(result.usage?.estimated, true)
  assert.ok((result.usage?.totalTokens ?? 0) > 0)
})

test('the agent publishes compaction usage into the trace', async () => {
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    if (system.includes('compress an agent conversation')) {
      return [
        { type: 'text-delta', text: 'COMPACTED' },
        { type: 'usage', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } },
        { type: 'done', finishReason: 'stop' },
      ]
    }
    return [
      { type: 'text-delta', text: 'answer' },
      { type: 'usage', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
      { type: 'done', finishReason: 'stop' },
    ]
  })
  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: new ToolRegistry([]),
    context: new ContextManager({ window: 120, threshold: 0.5, keepRecent: 2 }),
  })
  agent.setHistory([
    { role: 'user', content: `u1 ${'x'.repeat(220)}` },
    { role: 'assistant', content: `a1 ${'y'.repeat(220)}` },
    { role: 'user', content: `u2 ${'x'.repeat(220)}` },
    { role: 'assistant', content: `a2 ${'y'.repeat(220)}` },
  ])

  const events = await collect(agent.run('continue'))
  const compaction = events.find((event) => event.type === 'compaction')
  assert.equal(compaction?.type === 'compaction' ? compaction.usage?.totalTokens : 0, 110)
  const compactionUsage = events.find(
    (event) => event.type === 'usage' && event.purpose === 'compaction',
  )
  assert.equal(compactionUsage?.type === 'usage' ? compactionUsage.usage.totalTokens : 0, 110)
  const end = events.at(-1)
  assert.equal(end?.type === 'turn-end' ? end.usage.totalTokens : 0, 135, 'turn total includes compaction')
})
