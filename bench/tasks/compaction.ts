import assert from 'node:assert/strict'
import { fileTools } from '../../src/tools/fs.ts'
import { ToolRegistry } from '../../src/tools/registry.ts'
import { textOf } from '../../src/providers/content.ts'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, say } from './shared.ts'

const readFileTool = fileTools.find((tool) => tool.name === 'read_file')
if (readFileTool === undefined) throw new Error('read_file tool is missing')

export const compaction: BenchTask = {
  id: 'compaction',
  title: '长上下文自动压缩后继续回答',
  prompt: `请阅读 README.md 的第一行并告诉我。${'另外请保持回答简洁。'.repeat(20)}`,
  contextWindow: 700,
  contextOptions: { keepRecent: 2 },
  tools: new ToolRegistry([readFileTool]),
  history: [
    { role: 'user', content: `需求：${'梳理项目结构并给出计划。'.repeat(30)}` },
    { role: 'assistant', content: `计划：${'先读入口文件再读配置。'.repeat(30)}` },
    { role: 'user', content: `补充：${'不要修改任何文件。'.repeat(30)}` },
    { role: 'assistant', content: `收到：${'只做只读分析。'.repeat(30)}` },
  ],
  setup(dir) {
    fixture(dir, { 'README.md': 'oarlock fixture\nsecond line\n' })
  },
  script(request) {
    const system = textOf(request.messages[0]?.content ?? '')
    if (system.includes('compress an agent conversation')) return [say('SUMMARY: 用户要求只读分析并能简洁回答。'), done('stop')]
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) return [call('c1', 'read_file', { path: 'README.md' }), done('tool_calls')]
    return [say('第一行是 oarlock fixture。'), done('stop')]
  },
  verify(ctx) {
    assert.ok(
      ctx.events.some((event) => event.type === 'compaction'),
      'no compaction event: the context window never overflowed',
    )
    const summary = ctx.messages[0]
    assert.equal(summary?.role, 'system')
    assert.match(textOf(summary?.content ?? ''), /SUMMARY/)
    assert.ok(ctx.events.some((event) => event.type === 'turn-end'))
  },
}
