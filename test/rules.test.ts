import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { RuleApprovalGate } from '../src/core/approval.ts'
import { PermissionRules, permissionsFile, readRules } from '../src/core/rules.ts'
import type { ApprovalRequest } from '../src/tools/types.ts'
import { createAgentServer } from '../src/web/server.ts'
import { tempDir } from './helpers.ts'

const ask = (ruleKey?: string): ApprovalRequest & { id: string } => ({
  id: 'a1',
  tool: 'bash',
  summary: 'bash: git status',
  risk: 'exec',
  ...(ruleKey !== undefined ? { ruleKey } : {}),
})

test('readRules tolerates missing, malformed and duplicate entries', () => {
  const cwd = tempDir()
  assert.deepEqual(readRules(cwd), [])
  mkdirSync(join(cwd, '.agent'), { recursive: true })
  writeFileSync(permissionsFile(cwd), 'not json')
  assert.deepEqual(readRules(cwd), [])
  writeFileSync(permissionsFile(cwd), JSON.stringify({ version: 1, rules: ['bash:git status', ' bash:git status ', 42, ''] }))
  assert.deepEqual(readRules(cwd), ['bash:git status'])
  writeFileSync(permissionsFile(cwd), JSON.stringify({ rules: 'nope' }))
  assert.deepEqual(readRules(cwd), [])
})

test('PermissionRules persists add / remove / clear as JSON', () => {
  const cwd = tempDir()
  const rules = new PermissionRules(cwd)
  assert.equal(rules.add('bash:git status'), true)
  assert.equal(rules.add('bash:git status'), true, 'duplicates are a no-op')
  assert.equal(rules.add('write_file:src'), true)
  assert.deepEqual(rules.list(), ['bash:git status', 'write_file:src'])

  const persisted = JSON.parse(readFileSync(permissionsFile(cwd), 'utf8'))
  assert.equal(persisted.version, 1)
  assert.deepEqual(persisted.rules, ['bash:git status', 'write_file:src'])

  // A fresh instance (new process, cleared cache) sees the same rules.
  assert.deepEqual(new PermissionRules(cwd).list(), ['bash:git status', 'write_file:src'])

  assert.equal(rules.remove('bash:git status'), true)
  assert.deepEqual(new PermissionRules(cwd).list(), ['write_file:src'])
  assert.equal(rules.remove('missing'), true, 'removing an unknown rule is a no-op')

  assert.equal(rules.clear(), true)
  assert.deepEqual(new PermissionRules(cwd).list(), [])
  assert.equal(existsSync(permissionsFile(cwd)), false, 'clearing removes the file (empty state is the default)')
  assert.deepEqual(readRules(cwd), [])
})

test('a rule gate honours the persisted store and remembers always decisions', async () => {
  const cwd = tempDir()
  const store = new PermissionRules(cwd)
  const gate = new RuleApprovalGate(async () => 'always', store)
  assert.equal(gate.precheck(ask('bash:git status')), undefined)
  await gate.request(ask('bash:git status'))
  assert.equal(store.has('bash:git status'), true)
  assert.equal(gate.ruleCount(), 1)

  // A new gate in the same process (e.g. next session) pre-approves silently.
  const next = new RuleApprovalGate(async () => 'deny', store)
  assert.equal(next.precheck(ask('bash:git status')), 'allow')
  assert.equal(next.precheck(ask('bash:rm -rf x')), undefined)

  // Gates without a store keep the old in-memory behaviour.
  const memory = new RuleApprovalGate(async () => 'always')
  assert.equal(memory.precheck(ask('bash:git status')), undefined)
  await memory.request(ask('bash:git status'))
  assert.equal(memory.precheck(ask('bash:git status')), 'allow')
})

async function withServer(run: (base: string, cwd: string) => Promise<void>): Promise<void> {
  const cwd = tempDir()
  const config = resolveConfig({ cwd, provider: 'mock', model: 'mock-1', approval: 'ask' })
  const agent = createAgentServer(config)
  const { server } = agent
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => done())
  })
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, cwd)
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done())
    })
  }
}

test('settings expose and clear persisted rules', async () => {
  await withServer(async (base, cwd) => {
    const rules = new PermissionRules(cwd)
    rules.add('bash:git status')
    rules.add('write_file:src')

    const loaded = (await (await fetch(`${base}/api/settings`)).json()) as { rules?: string[] }
    assert.deepEqual(loaded.rules, ['bash:git status', 'write_file:src'])

    const removed = await fetch(`${base}/api/settings/rules`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule: 'bash:git status' }),
    })
    assert.equal(removed.status, 200)
    assert.deepEqual(((await removed.json()) as { rules?: string[] }).rules, ['write_file:src'])
    assert.deepEqual(new PermissionRules(cwd).list(), ['write_file:src'])

    assert.equal(
      (
        await fetch(`${base}/api/settings/rules`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rule: 42 }),
        })
      ).status,
      400,
    )

    const cleared = await fetch(`${base}/api/settings/rules`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(cleared.status, 200)
    assert.deepEqual(((await cleared.json()) as { rules?: string[] }).rules, [])
    assert.equal(existsSync(join(cwd, '.agent', 'permissions.json')), false)
  })
})
