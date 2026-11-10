import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { Agent } from '../src/core/agent.ts'
import { autoApproval } from '../src/core/approval.ts'
import { CheckpointManager, checkpointForUserMessage, checkpointManager } from '../src/core/checkpoint.ts'
import type { AgentEvent } from '../src/core/events.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { createAgentServer } from '../src/web/server.ts'
import { collect, tempDir } from './helpers.ts'

const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0

const ENV_KEYS = ['AGENT_CHECKPOINT', 'AGENT_GIT_PATH'] as const

async function withEnv(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  run: () => Promise<void> | void,
): Promise<void> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('begin snapshots and restore rewinds tracked files', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const cwd = tempDir()
  writeFileSync(join(cwd, 'a.txt'), 'one\n')
  const manager = new CheckpointManager(cwd)

  const first = await manager.begin('turn 1')
  assert.ok(first !== undefined)
  assert.match(first, /^[0-9a-f]{7,}/)

  writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(cwd, 'created.txt'), 'new file\n')
  writeFileSync(join(cwd, 'doomed.txt'), 'delete me\n')
  const second = await manager.begin('turn 2')
  assert.ok(second !== undefined)
  assert.notEqual(second, first)

  const restored = await manager.restore(first)
  assert.equal(restored.ok, true)
  assert.ok(restored.safety !== undefined)
  assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'one\n')
  assert.equal(existsSync(join(cwd, 'created.txt')), false)
  assert.equal(existsSync(join(cwd, 'doomed.txt')), false)
  assert.ok((restored.filesChanged ?? 0) >= 2)

  // The safety snapshot really restores the pre-rewind state.
  const undone = await manager.restore(restored.safety as string)
  assert.equal(undone.ok, true)
  assert.match(readFileSync(join(cwd, 'a.txt'), 'utf8'), /two/)
  assert.equal(existsSync(join(cwd, 'created.txt')), true)
})

test('an empty workspace still gets a checkpoint and rewinds clean', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const cwd = tempDir()
  const manager = new CheckpointManager(cwd)
  // Nothing on disk: the first commit is empty, and it must be an anchor.
  const first = await manager.begin('first turn')
  assert.ok(first !== undefined)
  writeFileSync(join(cwd, 'later.txt'), 'created during the turn\n')
  const restored = await manager.restore(first)
  assert.equal(restored.ok, true)
  assert.equal(existsSync(join(cwd, 'later.txt')), false)
})

test('restore leaves excluded directories untouched', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const cwd = tempDir()
  writeFileSync(join(cwd, 'a.txt'), 'one\n')
  const manager = new CheckpointManager(cwd)
  const first = await manager.begin()
  assert.ok(first !== undefined)
  mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules', 'pkg', 'index.js'), 'installed\n')
  const restored = await manager.restore(first)
  assert.equal(restored.ok, true)
  assert.equal(readFileSync(join(cwd, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'installed\n')
})

test('checkpointing degrades to a no-op without git or with the switch off', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const cwd = tempDir()
  await withEnv({}, async () => {
    const broken = new CheckpointManager(cwd, { gitPath: join(cwd, 'no-such-git') })
    assert.equal(await broken.begin(), undefined)
    const result = await broken.restore('deadbeef')
    assert.equal(result.ok, false)
  })
  await withEnv({ AGENT_CHECKPOINT: '0' }, async () => {
    assert.equal(await checkpointManager(cwd).begin(), undefined)
    const result = await checkpointManager(cwd).restore('deadbeef')
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /disabled/)
  })
})

test('an unknown checkpoint refuses the restore', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const cwd = tempDir()
  writeFileSync(join(cwd, 'a.txt'), 'one\n')
  const manager = new CheckpointManager(cwd)
  await manager.begin()
  const result = await manager.restore('0000000000000000000000000000000000000000')
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /unknown checkpoint/)
  // The refusal must not have touched the file.
  assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'one\n')
})

test('the agent snapshots once per main turn and stamps turn-start', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const calls: Array<string | undefined> = []
  const hook = {
    begin: async (label?: string): Promise<string | undefined> => {
      calls.push(label)
      return `snap-${calls.length}`
    },
  }
  const provider = {
    id: 'mock',
    model: 'mock-1',
    async *stream(): AsyncGenerator<{ type: 'text-delta'; text: string } | { type: 'done'; finishReason: 'stop' }> {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'done', finishReason: 'stop' }
    },
  }
  const main = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: new ToolRegistry([]),
    checkpoint: hook,
  })
  const events = await collect(main.run('first'))
  assert.equal(calls.length, 1)
  const start = events.find((event) => event.type === 'turn-start')
  assert.ok(start !== undefined && start.type === 'turn-start')
  assert.equal(start.checkpoint, 'snap-1')
  assert.match(calls[0] ?? '', /first/)

  // Subagents inherit the parent snapshot and must not take their own.
  const child = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: new ToolRegistry([]),
    depth: 1,
    checkpoint: hook,
  })
  const childEvents = await collect(child.run('delegated'))
  assert.equal(calls.length, 1)
  const childStart = childEvents.find((event) => event.type === 'turn-start')
  assert.ok(childStart !== undefined && childStart.type === 'turn-start')
  assert.equal(childStart.checkpoint, undefined)
})

test('checkpointForUserMessage aligns turns, tolerates compaction and fails safe', () => {
  const turns = (texts: Array<{ input: string; checkpoint?: string }>): Array<{ event: AgentEvent }> =>
    texts.map((item) => ({
      event: {
        type: 'turn-start',
        input: item.input,
        depth: 0,
        ...(item.checkpoint !== undefined ? { checkpoint: item.checkpoint } : {}),
      } as AgentEvent,
    }))
  const user = (text: string): { role: 'user'; content: string } => ({ role: 'user', content: text })
  const assistant = (text: string): { role: 'assistant'; content: string } => ({ role: 'assistant', content: text })

  const records = turns([
    { input: 'u1', checkpoint: 'c1' },
    { input: 'u2', checkpoint: 'c2' },
    { input: 'u3', checkpoint: 'c3' },
  ])
  const messages = [user('u1'), assistant('a1'), user('u2'), assistant('a2'), user('u3'), assistant('a3')]
  assert.equal(checkpointForUserMessage(records, messages, 0), 'c1')
  assert.equal(checkpointForUserMessage(records, messages, 2), 'c2')
  assert.equal(checkpointForUserMessage(records, messages, 4), 'c3')
  // Not a user message / out of range.
  assert.equal(checkpointForUserMessage(records, messages, 1), undefined)
  assert.equal(checkpointForUserMessage(records, messages, 6), undefined)
  // Compaction dropped the first turns: records still hold them, alignment
  // must follow the suffix, not the absolute index.
  const compacted = [user('u2'), assistant('a2'), user('u3'), assistant('a3')]
  assert.equal(checkpointForUserMessage(records, compacted, 0), 'c2')
  assert.equal(checkpointForUserMessage(records, compacted, 2), 'c3')
  // Text mismatch (stale trace) fails safe instead of rewinding the wrong turn.
  const drifted = [user('something else'), assistant('a'), user('u3'), assistant('a3')]
  assert.equal(checkpointForUserMessage(records, drifted, 0), undefined)
  // Old traces (no checkpoint field) resolve to undefined.
  const legacy = turns([{ input: 'u1' }, { input: 'u2' }])
  assert.equal(checkpointForUserMessage(legacy, [user('u1'), assistant('a'), user('u2')], 0), undefined)
})

async function withServer(
  run: (base: string, cwd: string, agent: ReturnType<typeof createAgentServer>) => Promise<void>,
): Promise<void> {
  const cwd = tempDir()
  const config = resolveConfig({ cwd, provider: 'mock', model: 'mock-1', approval: 'auto' })
  const agent = createAgentServer(config)
  const { server } = agent
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, cwd, agent)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function createSession(base: string): Promise<string> {
  const response = await post(`${base}/api/sessions`, {})
  return ((await response.json()) as { id: string }).id
}

test('fork with restoreFiles rewinds the workspace to the branch point', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  await withEnv({}, async () => {
    await withServer(async (base, cwd) => {
      const id = await createSession(base)
      // The mock model writes a real file when driven through !tool.
      const turn = await post(`${base}/api/sessions/${id}/messages`, {
        text: '!tool write_file {"path":"x.txt","content":"written by the agent"}',
      })
      assert.equal(turn.status, 200)
      await turn.text()
      assert.equal(existsSync(join(cwd, 'x.txt')), true)

      const response = await post(`${base}/api/sessions/${id}/fork`, { keep: 0, restoreFiles: true })
      assert.equal(response.status, 200)
      const data = (await response.json()) as {
        id: string
        restored: boolean
        filesChanged?: number
        checkpoint?: string
      }
      assert.equal(data.restored, true)
      assert.ok((data.checkpoint ?? '').length > 0)
      assert.ok((data.filesChanged ?? 0) >= 1)
      assert.equal(existsSync(join(cwd, 'x.txt')), false)

      // Invalid combinations are rejected before anything is touched.
      assert.equal((await post(`${base}/api/sessions/${id}/fork`, { restoreFiles: true })).status, 400)
      assert.equal(
        (await post(`${base}/api/sessions/${id}/fork`, { keep: 1, restoreFiles: true })).status,
        400,
      )
    })
  })
})

test('restoreFiles falls back to a conversation-only fork without a snapshot', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  await withEnv({}, async () => {
    await withServer(async (base, _cwd, agent) => {
      const id = await createSession(base)
      // A hand-written transcript has no turn-start trace, so no checkpoint.
      const stored = agent.store.open(id)
      stored.append({ role: 'user', content: 'hello' })
      stored.append({ role: 'assistant', content: 'hi' })
      const response = await post(`${base}/api/sessions/${id}/fork`, { keep: 0, restoreFiles: true })
      assert.equal(response.status, 200)
      const data = (await response.json()) as { restored: boolean; warning?: string }
      assert.equal(data.restored, false)
      assert.match(data.warning ?? '', /快照/)
    })
  })
})