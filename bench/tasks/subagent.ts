import assert from 'node:assert/strict'
import { textOf } from '../../src/providers/content.ts'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, say, toolCalls, toolResults } from './shared.ts'

export const subagent: BenchTask = {
  id: 'subagent',
  title: '委派子 agent 统计文件',
  prompt: '请用 task 工具委派一个子 agent，让它统计 src 目录下有多少个 .ts 文件，然后把数字告诉我。',
  setup(dir) {
    fixture(dir, {
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export const b = 2\n',
      'src/c.ts': 'export const c = 3\n',
      'src/notes.md': '# notes\n',
    })
  },
  script(request) {
    const system = textOf(request.messages[0]?.content ?? '')
    // Match the child's prompt prefix: the working directory may itself contain "subagent".
    const isChild = system.startsWith('You are a subagent')
    const results = request.messages.filter((message) => message.role === 'tool').length

    if (isChild) {
      if (results === 0) return [call('k1', 'glob_files', { pattern: 'src/**/*.ts' }), done('tool_calls')]
      return [say('src 下有 3 个 .ts 文件。'), done('stop')]
    }
    if (results === 0) {
      return [
        call('t1', 'task', { description: 'count ts files', prompt: '统计 src 目录下有多少个 .ts 文件' }),
        done('tool_calls'),
      ]
    }
    return [say('子 agent 报告：src 下有 3 个 .ts 文件。'), done('stop')]
  },
  verify(ctx) {
    assert.ok(toolCalls(ctx.events, 'task').length > 0, 'task tool was never called')
    const result = toolResults(ctx.events, 'task')[0]
    assert.ok(result !== undefined, 'task produced no result')
    assert.match(result.content, /\b3\b/)
    assert.match(ctx.answer, /\b3\b/)
  },
}
