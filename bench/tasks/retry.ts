import assert from 'node:assert/strict'
import type { BenchTask } from '../types.ts'
import { ProviderError } from '../../src/providers/types.ts'
import { done, fixture, say } from './shared.ts'

let attempts = 0

export const retry: BenchTask = {
  id: 'retry',
  title: '瞬时错误自动重试',
  scriptOnly: true,
  prompt: '随便说一句话就行。',
  setup(dir) {
    fixture(dir, { 'README.md': 'fixture\n' })
  },
  script() {
    attempts += 1
    if (attempts === 1) throw new ProviderError('upstream is overloaded', { status: 503 })
    return [say('重试之后成功了。'), done('stop')]
  },
  verify(ctx) {
    const retried = ctx.events.some((event) => event.type === 'retry')
    assert.ok(retried, 'no retry event was emitted')
    assert.match(ctx.answer, /成功/)
  },
}
