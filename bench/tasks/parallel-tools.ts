import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, say, toolResults } from './shared.ts'

export const parallelTools: BenchTask = {
  id: 'parallel-tools',
  title: '一次返回多个工具调用',
  scriptOnly: true,
  prompt: '把 A 写进 a.txt，把 B 写进 b.txt。',
  setup(dir) {
    fixture(dir, { 'README.md': 'fixture\n' })
  },
  script(request) {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) {
      return [
        call('p1', 'write_file', { path: 'a.txt', content: 'A\n' }),
        call('p2', 'write_file', { path: 'b.txt', content: 'B\n' }),
        done('tool_calls'),
      ]
    }
    return [say('两个文件都写好了。'), done('stop')]
  },
  verify(ctx) {
    assert.equal(readFileSync(join(ctx.dir, 'a.txt'), 'utf8'), 'A\n')
    assert.equal(readFileSync(join(ctx.dir, 'b.txt'), 'utf8'), 'B\n')
    const results = toolResults(ctx.events)
    assert.equal(results.length, 2)
    assert.ok(results.every((result) => result.isError === false))
    assert.match(ctx.answer, /两个/)
  },
}
