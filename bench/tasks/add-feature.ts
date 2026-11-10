import assert from 'node:assert/strict'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, runNodeTests, say } from './shared.ts'

const IMPLEMENTATION = `export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
`

const OWN_TEST = `import assert from 'node:assert/strict'
import test from 'node:test'
import { slugify } from '../src/slugify.ts'

test('slugify', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})
`

const HIDDEN_TEST = `import assert from 'node:assert/strict'
import test from 'node:test'
import { slugify } from '../src/slugify.ts'

test('slugify normalizes text', () => {
  assert.equal(slugify('Hello World!'), 'hello-world')
  assert.equal(slugify('  A  b  '), 'a-b')
  assert.equal(slugify('already-fine'), 'already-fine')
})
`

export const addFeature: BenchTask = {
  id: 'add-feature',
  title: '实现新函数并通过隐藏测试',
  prompt:
    '实现 src/slugify.ts 里的 slugify：转小写、把连续的非字母数字替换成一个连字符、去掉首尾连字符。完成后写一条测试并运行 node --test 验证。',
  setup(dir) {
    fixture(dir, {
      'src/slugify.ts': "export function slugify(input: string): string {\n  throw new Error('not implemented')\n}\n",
    })
  },
  script(request) {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) return [call('a1', 'write_file', { path: 'src/slugify.ts', content: IMPLEMENTATION }), done('tool_calls')]
    if (results === 1) {
      return [call('a2', 'write_file', { path: 'test/slugify.test.ts', content: OWN_TEST }), done('tool_calls')]
    }
    if (results === 2) {
      return [call('a3', 'bash', { command: 'node --test test/slugify.test.ts' }), done('tool_calls')]
    }
    return [say('已实现 slugify，测试通过。'), done('stop')]
  },
  verify(ctx) {
    // The visible test may be missing or weak; the hidden test decides.
    fixture(ctx.dir, { 'test/verify.test.ts': HIDDEN_TEST })
    const result = runNodeTests(ctx.dir, 'test/verify.test.ts')
    assert.equal(result.code, 0, result.output)
  },
}
