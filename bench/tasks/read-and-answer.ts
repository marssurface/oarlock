import assert from 'node:assert/strict'
import type { BenchTask } from '../types.ts'
import { call, done, fixture, say } from './shared.ts'

export const readAndAnswer: BenchTask = {
  id: 'read-and-answer',
  title: '读文件并准确回答',
  prompt: 'src/settings.ts 里定义了哪些导出？一句话回答。',
  setup(dir) {
    fixture(dir, {
      'src/settings.ts': `export interface Settings {
  port: number
  debug: boolean
}

export const DEFAULT_PORT = 8080

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  return { port: DEFAULT_PORT, debug: false, ...overrides }
}
`,
      'src/unrelated.ts': 'export const nothing = true\n',
    })
  },
  script(request) {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) return [call('r1', 'read_file', { path: 'src/settings.ts' }), done('tool_calls')]
    return [say('它导出了 Settings 接口、DEFAULT_PORT 常量和 loadSettings 函数。'), done('stop')]
  },
  verify(ctx) {
    assert.match(ctx.answer, /loadSettings/)
    assert.match(ctx.answer, /DEFAULT_PORT/)
  },
}
