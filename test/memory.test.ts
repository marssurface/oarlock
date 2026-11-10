import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Agent } from '../src/core/agent.ts'
import { autoApproval } from '../src/core/approval.ts'
import { MemoryStore, memorySlug, memoryStore } from '../src/core/memory.ts'
import { buildSystemPrompt, memorySection } from '../src/core/prompt.ts'
import { ContextManager } from '../src/core/context.ts'
import type { ProviderRequest } from '../src/providers/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { rememberTool } from '../src/tools/memory.ts'
import { collect, scripted, tempDir, text } from './helpers.ts'

function storeAt(cwd: string): MemoryStore {
  return new MemoryStore(join(cwd, '.agent', 'memory'))
}

test('a saved note round-trips through markdown with its frontmatter intact', () => {
  const dir = tempDir()
  const store = storeAt(dir)

  const written = store.write({
    name: 'dev-server-cwd',
    description: 'the dev server needs the real agent root as --cwd',
    kind: 'procedure',
    body: 'Start 4173 with --cwd pointing at the agent package root, otherwise settings read empty.',
  })
  assert.equal(written.ok, true)
  if (!written.ok) return

  const file = join(dir, '.agent', 'memory', 'dev-server-cwd.md')
  assert.equal(existsSync(file), true)
  const raw = readFileSync(file, 'utf8')
  assert.ok(raw.startsWith('---\n'), 'notes are plain markdown with a frontmatter block')
  assert.match(raw, /name: dev-server-cwd/)
  assert.match(raw, /kind: procedure/)

  const entry = store.read('dev-server-cwd')
  assert.equal(entry?.description, 'the dev server needs the real agent root as --cwd')
  assert.equal(entry?.kind, 'procedure')
  assert.match(entry?.body ?? '', /agent package root/)
  assert.notEqual(entry?.updatedAt, '')

  assert.deepEqual(
    store.list().map((item) => item.name),
    ['dev-server-cwd'],
  )
})

test('names are normalised into slugs and cannot escape the memory directory', () => {
  assert.equal(memorySlug('  Dev Server CWD '), 'dev-server-cwd')
  assert.equal(memorySlug('model_switch:scope'), 'model-switch-scope', 'underscores and colons fold into dashes')
  assert.equal(memorySlug('../../etc/passwd'), 'etc-passwd')
  assert.equal(memorySlug('..'), '')
  assert.equal(memorySlug(''), '')

  const dir = tempDir()
  const store = storeAt(dir)
  const result = store.write({ name: 'Dev Server CWD', body: 'one' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.entry.name, 'dev-server-cwd')
  assert.equal(existsSync(join(dir, '.agent', 'memory', 'dev-server-cwd.md')), true)
  assert.equal(store.write({ name: '', body: 'x' }).ok, false, 'an empty name is refused')
})

test('reusing a name replaces the note instead of duplicating it', () => {
  const dir = tempDir()
  const store = storeAt(dir)
  const first = store.write({ name: 'pricing', description: 'old', body: 'v1' })
  const second = store.write({ name: 'pricing', description: 'new', body: 'v2' })
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.created, false, 'the first write created it, the second updates it')
  assert.equal(store.list().length, 1)
  assert.equal(store.read('pricing')?.description, 'new')
  assert.equal(store.read('pricing')?.kind, 'fact', 'kind defaults to fact')
})

test('an empty or oversized body is refused, and a failed write keeps the previous note', () => {
  const dir = tempDir()
  const store = storeAt(dir)
  store.write({ name: 'keep-me', body: 'the original text' })
  assert.equal(store.write({ name: 'keep-me', body: '   ' }).ok, false)
  assert.equal(store.read('keep-me')?.body, 'the original text')

  const tooLong = store.write({ name: 'keep-me', body: 'x'.repeat(20_000) })
  assert.equal(tooLong.ok, false)
  assert.match(tooLong.ok === false ? tooLong.error : '', /too long/)
  assert.equal(store.read('keep-me')?.body, 'the original text', 'a rejected write must not truncate the note')
  assert.equal(existsSync(join(dir, '.agent', 'memory', 'keep-me.md.tmp')), false, 'the temp file is cleaned up')
})

test('hand-written and broken notes still show up instead of vanishing', () => {
  const dir = tempDir()
  mkdirSync(join(dir, '.agent', 'memory'), { recursive: true })
  // No frontmatter at all: the first line becomes the description.
  writeFileSync(join(dir, '.agent', 'memory', 'plain-note.md'), '# Just a heading\n\nsome prose\n', 'utf8')
  // Frontmatter with unknown keys and a bad kind: still readable, kind falls back.
  writeFileSync(join(dir, '.agent', 'memory', 'odd-kinds.md'), '---\ndescription: odd one\nkind: vibe\n---\nbody\n', 'utf8')
  // Not a slug the store recognises: stays out of the index rather than breaking it.
  writeFileSync(join(dir, '.agent', 'memory', 'README.md'), 'human documentation\n', 'utf8')

  const store = storeAt(dir)
  assert.equal(store.read('plain-note')?.description, 'Just a heading')
  assert.equal(store.read('plain-note')?.kind, 'fact')
  assert.equal(store.read('odd-kinds')?.description, 'odd one')
  assert.equal(store.read('odd-kinds')?.kind, 'fact')
  assert.equal(store.read('README'), undefined, 'uppercase names are not memory entries')

  const index = store.index() ?? ''
  assert.ok(index.includes('plain-note'))
  assert.equal(index.includes('README'), false)

  // A missing directory is simply "no memory", never an error.
  assert.deepEqual(storeAt(tempDir()).list(), [])
  assert.equal(storeAt(tempDir()).index(), undefined)
})

test('removing a note deletes its file and reports honestly', () => {
  const dir = tempDir()
  const store = storeAt(dir)
  store.write({ name: 'temporary', body: 'note' })
  assert.equal(store.remove('temporary').removed, true)
  assert.equal(existsSync(join(dir, '.agent', 'memory', 'temporary.md')), false)
  const again = store.remove('temporary')
  assert.equal(again.removed, false)
  assert.match(again.error ?? '', /no memory named temporary/)
})

test('the injected index stays bounded as memory grows', () => {
  const dir = tempDir()
  const store = storeAt(dir)
  for (let index = 0; index < 80; index += 1) {
    store.write({
      name: `note-${index.toString().padStart(3, '0')}`,
      description: 'x'.repeat(180),
      body: 'content',
    })
  }
  const index = store.index() ?? ''
  const lines = index.split('\n')
  assert.ok(index.length <= 4400, `index grew to ${index.length} chars`)
  assert.ok(lines.length <= 60, `index listed ${lines.length} lines`)
  assert.match(index, /more not listed/, 'the hidden remainder is stated, not silently dropped')
  assert.equal(store.list().length, 80, 'the notes themselves are all still there')
})

test('the prompt explains memory only when the tool is available', () => {
  const withTool = buildSystemPrompt({ cwd: '/tmp/x', tools: ['remember'], memory: '- demo — a note (fact)' })
  assert.match(withTool, /Use the remember tool|remember tool/)
  assert.match(withTool, /Memory from earlier sessions/)
  assert.match(withTool, /- demo — a note \(fact\)/)
  assert.match(withTool, /Memory is a claim, not a fact/)

  const withoutTool = buildSystemPrompt({ cwd: '/tmp/x', tools: ['read_file'], memory: '- demo — a note (fact)' })
  assert.equal(withoutTool.includes('remember'), false)
  assert.ok(
    memorySection('   ') === undefined,
    'an empty index adds no section',
  )
})

test('remember writes through the tool and describes what it did', async () => {
  const dir = tempDir()
  const result = await rememberTool.execute(
    { action: 'write', name: 'node version', description: 'tests need nvm node 24', kind: 'procedure', content: 'source ~/.nvm/nvm.sh && nvm use 24' },
    { cwd: dir },
  )
  assert.equal(result.isError, undefined)
  assert.match(result.content, /saved memory "node-version"/)
  assert.match(result.content, /procedure/)
  assert.equal(existsSync(join(dir, '.agent', 'memory', 'node-version.md')), true)

  const badAction = await rememberTool.execute({ action: 'edit', name: 'x', content: 'y' }, { cwd: dir })
  assert.equal(badAction.isError, true)
  assert.match(badAction.content, /action must be write or remove/)

  const missing = await rememberTool.execute({ action: 'remove', name: 'nope' }, { cwd: dir })
  assert.equal(missing.isError, true)

  const removed = await rememberTool.execute({ action: 'remove', name: 'node version' }, { cwd: dir })
  assert.equal(removed.isError, undefined)
  assert.match(removed.content, /removed memory node version/)
})

test('approval is remembered per note, not for every memory write', () => {
  const writeKey = rememberTool.ruleKeyFor?.({ action: 'write', name: 'Dev Server CWD' }, '/tmp/x')
  const removeKey = rememberTool.ruleKeyFor?.({ action: 'remove', name: 'dev-server-cwd' }, '/tmp/x')
  assert.equal(writeKey, 'remember:write:dev-server-cwd')
  assert.equal(removeKey, 'remember:remove:dev-server-cwd', 'dropping a note is a separate grant')
  assert.equal(rememberTool.ruleKeyFor?.({ action: 'write', name: '../../x' }, '/tmp/x'), 'remember:write:x')
  assert.equal(rememberTool.ruleKeyFor?.({ action: 'write' }, '/tmp/x'), undefined, 'no name, no rule')
  assert.match(rememberTool.summaryFor?.({ action: 'write', name: 'a-b' }) ?? '', /remember write: \.agent\/memory\/a-b\.md/)
})

test('a note saved mid-session reaches the next turn without restarting the agent', async () => {
  const dir = tempDir()
  const store = memoryStore(dir)
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'user' && last.content === 'first') {
      return [
        {
          type: 'tool-call',
          call: {
            id: 'c1',
            name: 'remember',
            arguments: JSON.stringify({ action: 'write', name: 'release-step', description: 'how to publish', content: 'run pnpm build then tag' }),
          },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ]
    }
    if (last?.role === 'tool') return text('saved')
    // Second turn: report what the system prompt now says about memory.
    const system = request.messages[0]
    const prompt = typeof system?.content === 'string' ? system.content : ''
    return text(prompt.includes('release-step') ? 'prompt-has-note' : 'prompt-missing-note')
  })

  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: new ToolRegistry([rememberTool]),
    context: new ContextManager({ window: 200_000 }),
    memoryIndex: () => store.index(),
  })

  await collect(agent.run('first'))
  assert.equal(existsSync(join(dir, '.agent', 'memory', 'release-step.md')), true)

  const events = await collect(agent.run('second'))
  const answer = events.filter((event) => event.type === 'text-delta').map((event) => (event.type === 'text-delta' ? event.text : '')).join('')
  assert.equal(answer, 'prompt-has-note', 'the turn-start refresh must pick up notes saved earlier')

  // A broken store cannot break a turn.
  const broken = new Agent({
    provider: scripted(() => text('fine')),
    cwd: dir,
    approval: autoApproval(),
    tools: new ToolRegistry([rememberTool]),
    memoryIndex: () => {
      throw new Error('disk on fire')
    },
  })
  const brokenEvents = await collect(broken.run('hello'))
  assert.ok(brokenEvents.some((event) => event.type === 'turn-end'))
})

test('subagents see the notes but cannot write them', async () => {
  const dir = tempDir()
  memoryStore(dir).write({ name: 'shared-note', description: 'visible to children', body: 'body' })

  const requests: ProviderRequest[] = []
  const provider = scripted((request) => {
    requests.push(request)
    const system = String(request.messages[0]?.content ?? '')
    if (system.includes('inside a larger agent run')) return text('child report')
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'user') {
      return [
        { type: 'tool-call', call: { id: 't1', name: 'task', arguments: JSON.stringify({ description: 'look', prompt: 'inspect the repo' }) } },
        { type: 'done', finishReason: 'tool_calls' },
      ]
    }
    if (last?.role === 'tool') return text('done')
    return text('ok')
  })

  const parent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: ToolRegistry.default({ allowShell: false }),
    context: new ContextManager({ window: 200_000 }),
    memoryIndex: () => memoryStore(dir).index(),
  })
  await collect(parent.run('delegate'))

  const child = requests.find((request) => String(request.messages[0]?.content ?? '').includes('inside a larger agent run'))
  assert.notEqual(child, undefined, 'the delegation should have reached the provider')
  if (child === undefined) return
  const childTools = (child.tools ?? []).map((spec) => spec.name)
  assert.ok(childTools.includes('read_file'), 'a child is assembled with real tools')
  assert.equal(childTools.includes('remember'), false, 'memory writes stay a top-level decision')
  assert.match(String(child.messages[0]?.content ?? ''), /shared-note/, 'children still read what earlier sessions left')
})
