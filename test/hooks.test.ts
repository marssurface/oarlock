import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Agent } from '../src/core/agent.ts'
import { autoApproval } from '../src/core/approval.ts'
import { matchesHook, parseHooks, runHooks } from '../src/core/hooks.ts'
import type { HooksConfig } from '../src/core/hooks.ts'
import { ContextManager } from '../src/core/context.ts'
import { readHooks } from '../src/config.ts'
import type { ApprovalGate } from '../src/tools/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { collect, scripted, tempDir, text } from './helpers.ts'

const noTask = (): ToolRegistry => ToolRegistry.default({ allowShell: false, includeTask: false })

function agentWith(dir: string, hooks: HooksConfig, approval: ApprovalGate): Agent {
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('finished')
    return [
      {
        type: 'tool-call',
        call: { id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'hi' }) },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  return new Agent({ provider, cwd: dir, approval, tools: noTask(), context: new ContextManager({ window: 200_000 }), hooks })
}

test('matchesHook treats * as every tool and otherwise matches exactly', () => {
  assert.equal(matchesHook({ command: 'x' }, 'bash'), true)
  assert.equal(matchesHook({ command: 'x', matcher: '*' }, 'read_file'), true)
  assert.equal(matchesHook({ command: 'x', matcher: 'bash' }, 'bash'), true)
  assert.equal(matchesHook({ command: 'x', matcher: 'bash' }, 'read_file'), false)
})

test('parseHooks keeps well-formed entries and drops the rest', () => {
  const config = parseHooks({
    PreToolUse: [
      { command: 'echo ok', matcher: 'bash', timeoutMs: 5000 },
      { matcher: 'bash' },
      { command: '   ' },
      'not-an-object',
    ],
    PostToolUse: 'nope',
    bogus: true,
  })
  assert.equal(config.PreToolUse.length, 1)
  assert.deepEqual(config.PreToolUse[0], { command: 'echo ok', matcher: 'bash', timeoutMs: 5000 })
  assert.deepEqual(config.PostToolUse, [])
})

test('readHooks reads .agent/hooks.json and defaults to empty when absent', () => {
  const dir = tempDir()
  assert.deepEqual(readHooks(dir), { PreToolUse: [], PostToolUse: [] })
  mkdirSync(join(dir, '.agent'), { recursive: true })
  writeFileSync(join(dir, '.agent/hooks.json'), JSON.stringify({ PreToolUse: [{ matcher: 'bash', command: 'echo hi' }] }))
  assert.equal(readHooks(dir).PreToolUse.length, 1)
})

test('runHooks maps exit code 2 to a block with the stderr reason', async () => {
  const outcome = await runHooks('PreToolUse', [{ command: "printf 'no way\\n' >&2; exit 2" }], { tool_name: 'bash', tool_input: {} }, tempDir())
  assert.equal(outcome.decision, 'block')
  assert.equal(outcome.reason, 'no way')
})

test('runHooks reads a JSON decision from stdout', async () => {
  const block = await runHooks('PreToolUse', [{ command: `printf '{"decision":"block","reason":"denied"}'` }], { tool_name: 'bash', tool_input: {} }, tempDir())
  assert.equal(block.decision, 'block')
  assert.equal(block.reason, 'denied')

  const allow = await runHooks('PreToolUse', [{ command: `printf '{"decision":"allow"}'` }], { tool_name: 'write_file', tool_input: {} }, tempDir())
  assert.equal(allow.decision, 'allow')
})

test('runHooks treats a plain stdout line as neutral context', async () => {
  const outcome = await runHooks('PostToolUse', [{ command: 'echo all good' }], { tool_name: 'read_file', tool_input: {} }, tempDir())
  assert.equal(outcome.decision, 'neutral')
  assert.equal(outcome.context, 'all good')
})

test('runHooks fails open on non-zero exits and unmatched tools', async () => {
  const broken = await runHooks('PreToolUse', [{ command: 'exit 1' }], { tool_name: 'bash', tool_input: {} }, tempDir())
  assert.equal(broken.decision, 'neutral')

  const skipped = await runHooks('PreToolUse', [{ command: 'exit 2', matcher: 'bash' }], { tool_name: 'read_file', tool_input: {} }, tempDir())
  assert.equal(skipped.decision, 'neutral')
})

test('a hook sees the tool call on stdin', async () => {
  const outcome = await runHooks(
    'PreToolUse',
    [{ command: `grep -q '"tool_name":"write_file"' || { echo missing >&2; exit 2; }; echo match` }],
    { tool_name: 'write_file', tool_input: { path: 'a.txt' } },
    tempDir(),
  )
  assert.equal(outcome.decision, 'neutral')
  assert.equal(outcome.context, 'match')
})

test('PreToolUse block prevents the tool from running', async () => {
  const dir = tempDir()
  const agent = agentWith(dir, { PreToolUse: [{ matcher: 'write_file', command: 'exit 2' }], PostToolUse: [] }, autoApproval())
  const events = await collect(agent.run('write the note'))
  assert.equal(existsSync(join(dir, 'note.txt')), false)
  const result = events.find((event) => event.type === 'tool-result')
  assert.equal(result?.type === 'tool-result' ? result.isError : false, true)
  assert.match(result?.type === 'tool-result' ? result.content : '', /blocked by PreToolUse hook/)
})

test('PreToolUse allow skips the interactive prompt without touching a deny gate', async () => {
  const dir = tempDir()
  let gateCalls = 0
  const gate: ApprovalGate = { mode: 'ask', request: async () => { gateCalls += 1; return 'deny' } }
  const agent = agentWith(dir, { PreToolUse: [{ matcher: 'write_file', command: `printf '{"decision":"allow"}'` }], PostToolUse: [] }, gate)
  const events = await collect(agent.run('write the note'))
  assert.equal(readFileSync(join(dir, 'note.txt'), 'utf8'), 'hi')
  assert.equal(gateCalls, 0)
  assert.equal(events.some((event) => event.type === 'approval-request'), false)
})

test('a deny policy still wins over a PreToolUse allow', async () => {
  const dir = tempDir()
  const agent = agentWith(dir, { PreToolUse: [{ matcher: 'write_file', command: `printf '{"decision":"allow"}'` }], PostToolUse: [] }, { mode: 'deny', request: async () => 'deny' })
  await collect(agent.run('write the note'))
  assert.equal(existsSync(join(dir, 'note.txt')), false)
})

test('PostToolUse block flags a successful tool result as an error', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'data.txt'), 'contents')
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('ok')
    return [
      { type: 'tool-call', call: { id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'data.txt' }) } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: noTask(),
    context: new ContextManager({ window: 200_000 }),
    hooks: { PreToolUse: [], PostToolUse: [{ matcher: 'read_file', command: "printf 'lint failed\\n' >&2; exit 2" }] },
  })
  const events = await collect(agent.run('read it'))
  const result = events.find((event) => event.type === 'tool-result')
  assert.equal(result?.type === 'tool-result' ? result.isError : false, true)
  assert.match(result?.type === 'tool-result' ? result.content : '', /PostToolUse hook flagged a problem: lint failed/)
  assert.match(result?.type === 'tool-result' ? result.content : '', /contents/)
})
