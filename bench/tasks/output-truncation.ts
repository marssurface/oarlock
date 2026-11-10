import assert from 'node:assert/strict'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, say, toolResults } from './shared.ts'

/** ~100 KB of output: well past the agent's per-tool cap (30 KB) but under bash's own cap. */
const COMMAND = `node -e "process.stdout.write('x'.repeat(100000))"`

export const outputTruncation: BenchTask = {
  id: 'output-truncation',
  title: '超长工具输出被截断',
  scriptOnly: true,
  prompt: '执行那条会打印十万个字符的命令。',
  setup(dir) {
    fixture(dir, { 'README.md': 'fixture\n' })
  },
  script(request) {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) return [call('o1', 'bash', { command: COMMAND }), done('tool_calls')]
    return [say('输出太长，已经被截断了。'), done('stop')]
  },
  verify(ctx) {
    const result = toolResults(ctx.events, 'bash')[0]
    assert.ok(result !== undefined, 'bash never ran')
    assert.ok(result.content.length < 40_000, `tool output was not capped (${result.content.length} chars)`)
    assert.match(result.content, /tool output truncated/)
    // Head and tail both survive so the model still sees context.
    assert.match(result.content, /^exit=0/)
  },
}
