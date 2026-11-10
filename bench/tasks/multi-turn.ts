import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, runNodeTests, say } from './shared.ts'

export const multiTurn: BenchTask = {
  id: 'multi-turn',
  title: '多轮澄清后再动手',
  prompt: "给 src/greeter.ts 的 greet 加一个默认参数 name = 'world'。先告诉我你打算怎么改。",
  turns: [
    "给 src/greeter.ts 的 greet 加一个默认参数 name = 'world'。先告诉我你打算怎么改。",
    '确认，改吧，然后跑测试。',
  ],
  setup(dir) {
    fixture(dir, {
      'src/greeter.ts': `export function greet(name: string): string {
  return \`hello \${name}\`
}
`,
      'test/greeter.test.ts': `import assert from 'node:assert/strict'
import test from 'node:test'
import { greet } from '../src/greeter.ts'

test('greets the world by default', () => {
  assert.equal(greet(), 'hello world')
})
`,
    })
  },
  script(request) {
    const turns = request.messages.filter((message) => message.role === 'user').length
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (turns === 1) return [say('我打算把签名改成 name: string = \'world\'，不动函数体。确认吗？'), done('stop')]
    if (results === 0) {
      return [
        call('u1', 'edit_file', { path: 'src/greeter.ts', old_string: 'name: string', new_string: "name: string = 'world'" }),
        done('tool_calls'),
      ]
    }
    if (results === 1) {
      return [call('u2', 'bash', { command: 'node --test test/greeter.test.ts' }), done('tool_calls')]
    }
    return [say('改好了，测试通过。'), done('stop')]
  },
  verify(ctx) {
    assert.match(readFileSync(join(ctx.dir, 'src/greeter.ts'), 'utf8'), /name: string = 'world'/)
    const result = runNodeTests(ctx.dir, 'test/greeter.test.ts')
    assert.equal(result.code, 0, result.output)
    const turnEnds = ctx.events.filter((event) => event.type === 'turn-end')
    assert.equal(turnEnds.length, 2, 'expected two completed turns')
    assert.match(ctx.answer, /改好/)
  },
}
