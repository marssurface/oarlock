import assert from 'node:assert/strict'
import type { BenchTask } from '../types.ts'
import { done, fixture, say } from './shared.ts'

export const abortTurn: BenchTask = {
  id: 'abort-turn',
  title: '流式输出中途中断',
  scriptOnly: true,
  expectError: true,
  abortAfterFirstDelta: true,
  prompt: '说一段很长的话。',
  setup(dir) {
    fixture(dir, { 'README.md': 'fixture\n' })
  },
  script() {
    return [say('这是一段会被中断的回答。'), say('后面还有更多内容。'), done('stop')]
  },
  verify(ctx) {
    assert.ok(
      ctx.events.some((event) => event.type === 'text-delta'),
      'the stream never produced a delta',
    )
    const end = ctx.events.at(-1)
    assert.equal(end?.type, 'error')
    assert.match(end?.type === 'error' ? end.message : '', /aborted/)
    // A half-finished assistant turn is discarded: only the user message is kept.
    assert.deepEqual(ctx.messages.map((message) => message.role), ['user'])
  },
}
