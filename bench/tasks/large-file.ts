import assert from 'node:assert/strict'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, say, toolCalls } from './shared.ts'

const LINES = 5_000
const TARGET_LINE = 3_800

export const largeFile: BenchTask = {
  id: 'large-file',
  title: '大文件分页定位',
  prompt: 'big.log 里有一行包含 found-me，它在第几行？请回答行号。',
  setup(dir) {
    const lines: string[] = []
    for (let index = 1; index <= LINES; index += 1) {
      lines.push(index === TARGET_LINE ? 'MAGIC = "found-me"' : `line ${index}: ${'x'.repeat(40)}`)
    }
    fixture(dir, { 'big.log': lines.join('\n') })
  },
  script(request) {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) {
      return [call('g1', 'read_file', { path: 'big.log', offset: 3_700, limit: 200 }), done('tool_calls')]
    }
    return [say(`包含 found-me 的是第 ${TARGET_LINE} 行。`), done('stop')]
  },
  verify(ctx) {
    assert.match(ctx.answer, new RegExp(String(TARGET_LINE)))
    assert.ok(toolCalls(ctx.events).length > 0, 'agent answered without opening the file')
  },
}
