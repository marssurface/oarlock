import assert from 'node:assert/strict'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, say, toolCalls } from './shared.ts'

export const multiTool: BenchTask = {
  id: 'multi-tool',
  title: '跨文件定位常量',
  prompt: '仓库里哪个文件定义了 MAX_RETRIES？它现在是多少？',
  setup(dir) {
    fixture(dir, {
      'src/retry.ts': 'export const MAX_RETRIES = 3\n\nexport function shouldRetry(attempt: number): boolean {\n  return attempt < MAX_RETRIES\n}\n',
      'src/net.ts': 'export const TIMEOUT_MS = 1_000\n',
      'README.md': '# fixture\n\nA tiny project for the benchmark.\n',
    })
  },
  script(request) {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) return [call('m1', 'grep_files', { pattern: 'MAX_RETRIES' }), done('tool_calls')]
    if (results === 1) return [call('m2', 'read_file', { path: 'src/retry.ts' }), done('tool_calls')]
    return [say('在 src/retry.ts 里定义，值是 3。'), done('stop')]
  },
  verify(ctx) {
    assert.match(ctx.answer, /retry/i)
    assert.match(ctx.answer, /\b3\b/)
    const searched =
      toolCalls(ctx.events, 'grep_files').length +
      toolCalls(ctx.events, 'glob_files').length +
      toolCalls(ctx.events, 'read_file').length +
      toolCalls(ctx.events, 'bash').length
    assert.ok(searched > 0, 'agent answered without looking at the repository')
  },
}
