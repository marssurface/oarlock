import assert from 'node:assert/strict'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, say, toolResults } from './shared.ts'

export const badArguments: BenchTask = {
  id: 'bad-arguments',
  title: '非法工具参数不崩溃',
  scriptOnly: true,
  prompt: '读一下 ok.txt，告诉我里面写了什么。',
  setup(dir) {
    fixture(dir, { 'ok.txt': 'hello from the fixture\n' })
  },
  script(request) {
    const results = request.messages.filter((message) => message.role === 'tool').length
    // First response contains truncated JSON: the runtime must reject it and
    // keep the turn alive instead of throwing.
    if (results === 0) {
      return [
        { type: 'tool-call', call: { id: 'b1', name: 'read_file', arguments: '{"path": ' } },
        done('tool_calls'),
      ]
    }
    if (results === 1) return [call('b2', 'read_file', { path: 'ok.txt' }), done('tool_calls')]
    return [say('文件内容是 hello from the fixture。'), done('stop')]
  },
  verify(ctx) {
    const results = toolResults(ctx.events)
    assert.ok(results.length >= 2, 'the turn did not continue after bad arguments')
    assert.equal(results[0]?.isError, true)
    assert.match(results[0]?.content ?? '', /invalid arguments/)
    assert.match(results[1]?.content ?? '', /hello from the fixture/)
    assert.match(ctx.answer, /hello from the fixture/)
  },
}
