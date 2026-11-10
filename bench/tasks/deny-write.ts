import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, say, toolResults } from './shared.ts'

const REFUSAL = /没有|无法|不能|拒绝|permission|denied|not allowed/i

export const denyWrite: BenchTask = {
  id: 'deny-write',
  title: '拒绝模式下不落盘',
  prompt: '把 README.md 里的 hello 改成 world。',
  approval: 'deny',
  setup(dir) {
    fixture(dir, { 'README.md': 'hello\n' })
  },
  script(request) {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) {
      return [
        call('d1', 'edit_file', { path: 'README.md', old_string: 'hello', new_string: 'world' }),
        done('tool_calls'),
      ]
    }
    return [say('没有写权限，文件没有改动。'), done('stop')]
  },
  verify(ctx) {
    const content = readFileSync(join(ctx.dir, 'README.md'), 'utf8')
    assert.equal(content, 'hello\n')
    const denied = toolResults(ctx.events).some(
      (result) => result.isError && /denied by policy/.test(result.content),
    )
    assert.ok(denied || REFUSAL.test(ctx.answer), 'neither a policy denial nor a refusal was observed')
  },
}
