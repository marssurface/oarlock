import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, runNodeTests, say, toolCalls } from './shared.ts'

export const fixBug: BenchTask = {
  id: 'fix-bug',
  title: '修复失败的测试',
  prompt: 'test/sum.test.ts 现在失败。找到原因，用最小改动修好，然后跑一遍测试确认。',
  setup(dir) {
    fixture(dir, {
      'src/sum.ts': 'export function sum(a: number, b: number): number {\n  return a - b\n}\n',
      'test/sum.test.ts': `import assert from 'node:assert/strict'
import test from 'node:test'
import { sum } from '../src/sum.ts'

test('adds', () => {
  assert.equal(sum(2, 3), 5)
})
`,
    })
  },
  script(request) {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) return [call('c1', 'read_file', { path: 'src/sum.ts' }), done('tool_calls')]
    if (results === 1) {
      return [
        call('c2', 'edit_file', { path: 'src/sum.ts', old_string: 'return a - b', new_string: 'return a + b' }),
        done('tool_calls'),
      ]
    }
    if (results === 2) return [call('c3', 'bash', { command: 'node --test test/sum.test.ts' }), done('tool_calls')]
    return [say('已修好：把减法改成加法，测试通过。'), done('stop')]
  },
  verify(ctx) {
    assert.match(readFileSync(join(ctx.dir, 'src/sum.ts'), 'utf8'), /return a \+ b/)
    const result = runNodeTests(ctx.dir, 'test/sum.test.ts')
    assert.equal(result.code, 0, result.output)
    assert.ok(toolCalls(ctx.events, 'bash').length > 0, 'agent never ran the test suite')
  },
}
