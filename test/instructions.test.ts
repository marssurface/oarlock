import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { autoApproval } from '../src/core/approval.ts'
import { Agent } from '../src/core/agent.ts'
import { composeInstructions, readProjectInstructions } from '../src/core/instructions.ts'
import { createRuntime } from '../src/core/setup.ts'
import { resolveConfig } from '../src/config.ts'
import type { ProviderRequest } from '../src/providers/types.ts'
import { textOf } from '../src/providers/content.ts'
import { SessionStore } from '../src/session/store.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { collect, scripted, tempDir, text } from './helpers.ts'

test('readProjectInstructions returns trimmed AGENTS.md content, or empty when absent or blank', () => {
  const dir = tempDir()
  assert.equal(readProjectInstructions(dir), '')

  writeFileSync(join(dir, 'AGENTS.md'), '\n  Use pnpm, never npm.  \n')
  assert.equal(readProjectInstructions(dir), 'Use pnpm, never npm.')

  writeFileSync(join(dir, 'AGENTS.md'), '   \n\t\n')
  assert.equal(readProjectInstructions(dir), '')
})

test('composeInstructions joins parts in order, drops blanks, and returns undefined when empty', () => {
  assert.equal(composeInstructions('rules', undefined, '  extra  ', ''), 'rules\n\nextra')
  assert.equal(composeInstructions(undefined, '', '   '), undefined)
  assert.equal(composeInstructions('only'), 'only')
})

test('createRuntime folds AGENTS.md into the system prompt sent to the provider', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'AGENTS.md'), 'Always answer in one short line.\n')
  const config = resolveConfig({ provider: 'mock', cwd: dir, approval: 'auto' })
  const session = new SessionStore(join(dir, '.agent/sessions')).create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  const runtime = createRuntime(config, session, { approval: autoApproval() })

  const requests: ProviderRequest[] = []
  const inner = runtime.provider.stream.bind(runtime.provider)
  runtime.provider.stream = (request) => {
    requests.push(request)
    return inner(request)
  }
  await collect(runtime.agent.run('hello'))

  const first = requests[0]
  if (first === undefined) throw new Error('provider received no request')
  assert.match(textOf(first.messages[0]?.content ?? ''), /Always answer in one short line\./)
})

test('a subagent inherits the parent project rules', async () => {
  const childSystems: string[] = []
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    if (system.includes('subagent')) {
      childSystems.push(system)
      return text('child done')
    }
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('parent finished')
    return [
      { type: 'tool-call', call: { id: 't1', name: 'task', arguments: JSON.stringify({ description: 'x', prompt: 'y' }) } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })

  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: ToolRegistry.default(),
    maxDepth: 1,
    extraInstructions: 'PROJECT-RULE prefer pnpm over npm',
  })
  await collect(agent.run('go'))

  assert.equal(childSystems.length, 1)
  assert.match(childSystems[0] ?? '', /PROJECT-RULE prefer pnpm over npm/)
})
