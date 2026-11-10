import assert from 'node:assert/strict'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, say, toolResults } from './shared.ts'

export const toolTimeout: BenchTask = {
  id: 'tool-timeout',
  title: '工具超时被终止并报错',
  scriptOnly: true,
  prompt: '运行 sleep 10，看看会发生什么。',
  setup(dir) {
    fixture(dir, { 'README.md': 'fixture\n' })
  },
  script(request) {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) return [call('t1', 'bash', { command: 'sleep 10', timeout_ms: 1_000 }), done('tool_calls')]
    return [say('命令超时被终止了，我不会傻等下去。'), done('stop')]
  },
  verify(ctx) {
    const result = toolResults(ctx.events, 'bash')[0]
    assert.ok(result !== undefined, 'bash never ran')
    assert.equal(result.isError, true, 'a timed-out command must be reported as an error')
    assert.match(result.content, /timed out/)
  },
}
