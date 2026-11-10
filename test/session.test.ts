import assert from 'node:assert/strict'
import { existsSync, statSync, utimesSync } from 'node:fs'
import test from 'node:test'
import { SessionStore } from '../src/session/store.ts'
import { textOf } from '../src/providers/content.ts'
import { tempDir } from './helpers.ts'

test('sessions persist, reopen and list', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  session.append({ role: 'user', content: 'hello there' })
  session.append({ role: 'assistant', content: 'hi' })

  const reopened = store.open(session.id)
  assert.equal(reopened.messages.length, 2)
  assert.equal(reopened.messages[0]?.content, 'hello there')

  const list = store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0]?.title, 'hello there')
  assert.equal(list[0]?.messages, 2)
})

test('compaction rewrites the transcript into a summary baseline', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  session.append({ role: 'user', content: 'old question' })
  session.append({ role: 'assistant', content: 'old answer' })
  session.append({ role: 'user', content: 'recent question' })

  session.compact('the old turns mattered', [{ role: 'user', content: 'recent question' }])

  const reopened = store.open(session.id)
  assert.equal(reopened.messages.length, 2)
  assert.equal(reopened.messages[0]?.role, 'system')
  assert.match(textOf(reopened.messages[0]?.content ?? ''), /the old turns mattered/)
  assert.equal(reopened.messages[1]?.content, 'recent question')
})

test('reopening repairs a turn that crashed between tool calls and results', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  session.append({ role: 'user', content: 'do it' })
  session.append({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call-1', name: 'write_file', arguments: '{"path":"x"}' }],
  })

  const reopened = store.open(session.id)
  assert.deepEqual(reopened.messages.map((message) => message.role), ['user', 'assistant', 'tool'])
  const tool = reopened.messages[2]
  assert.equal(tool?.role === 'tool' ? tool.toolCallId : '', 'call-1')
  assert.equal(tool?.role === 'tool' ? tool.toolName : '', 'write_file')
  assert.match(textOf(tool?.role === 'tool' ? tool.content : ''), /interrupted/)

  // The repair is persisted as a baseline, so a second open must not duplicate it.
  const again = store.open(session.id)
  assert.equal(again.messages.length, 3)
  assert.equal(again.messages.filter((message) => message.role === 'tool').length, 1)
})

test('reopening drops tool results whose assistant call is missing', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  session.append({ role: 'user', content: 'hi' })
  session.append({ role: 'tool', toolCallId: 'gone', toolName: 'read_file', content: 'orphan' })

  const reopened = store.open(session.id)
  assert.deepEqual(reopened.messages.map((message) => message.role), ['user'])
})

test('rejects ids that would escape the sessions directory', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  assert.throws(() => store.open('../../etc/passwd'), /invalid session id/)
})

test('trace keeps structural events, drops streamed text and truncates results', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })

  session.recordTrace({ type: 'turn-start', input: 'hi' })
  session.recordTrace({ type: 'step-start', step: 1 })
  session.recordTrace({ type: 'text-delta', text: 'x'.repeat(5_000) })
  session.recordTrace({ type: 'reasoning-delta', text: 'y'.repeat(5_000) })
  session.recordTrace({ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a"}' })
  session.recordTrace({ type: 'tool-result', id: 'c1', name: 'read_file', content: 'z'.repeat(5_000), isError: false })
  session.recordTrace({ type: 'usage', usage: { totalTokens: 12 } })
  session.recordTrace({ type: 'turn-end', steps: 1, usage: { totalTokens: 12 }, text: 'done' })

  const trace = session.readTrace()
  assert.deepEqual(
    trace.map((record) => record.event.type),
    ['turn-start', 'step-start', 'tool-call', 'tool-result', 'usage', 'turn-end'],
  )
  const result = trace[3]?.event
  assert.ok(result?.type === 'tool-result')
  assert.ok(result.content.length < 3_000, 'trace tool result must be truncated')
  assert.match(result.content, /omitted from trace/)
})

test('a session without a trace file returns an empty trace', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  assert.deepEqual(session.readTrace(), [])
})

test('trace keeps subagent boundaries', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })

  session.recordTrace({ type: 'subagent-start', id: 'call-1', description: 'scan the repo' })
  session.recordTrace({ type: 'tool-call', id: 'inner', name: 'glob_files', arguments: '{}' })
  session.recordTrace({ type: 'subagent-end', id: 'call-1', ok: true })

  assert.deepEqual(
    session.readTrace().map((record) => record.event.type),
    ['subagent-start', 'tool-call', 'subagent-end'],
  )
})

test('session summaries expose trace token totals and turn counts', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })

  session.recordTrace({ type: 'turn-start', input: 'hi' })
  session.recordTrace({ type: 'step-start', step: 1 })
  session.recordTrace({ type: 'usage', usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, cachedTokens: 6 } })
  session.recordTrace({ type: 'assistant', step: 1, text: 'ok', toolCalls: 0 })
  session.recordTrace({
    type: 'turn-end',
    steps: 1,
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    text: 'ok',
  })

  const summary = store.list()[0]
  assert.equal(summary?.turns, 1)
  assert.equal(summary?.usage.totalTokens, 14)
  assert.equal(summary?.usage.promptTokens, 10)
  assert.equal(summary?.usage.cachedTokens, 6)
  assert.equal(summary?.usage.requests, 1)
  assert.equal(summary?.usage.estimated, false)
})

test('legacy traces fall back to turn-end usage totals', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })

  session.recordTrace({ type: 'turn-start', input: 'hi' })
  session.recordTrace({ type: 'step-start', step: 1 })
  session.recordTrace({ type: 'assistant', step: 1, text: 'ok', toolCalls: 0 })
  session.recordTrace({ type: 'turn-end', steps: 1, usage: { totalTokens: 33 }, text: 'ok' })

  const summary = store.list()[0]
  assert.equal(summary?.usage.totalTokens, 33)
  assert.equal(summary?.usage.requests, 1)
})

test('cached trace summaries pick up newly appended usage', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })

  session.recordTrace({ type: 'turn-start', input: 'hi' })
  session.recordTrace({ type: 'step-start', step: 1 })
  session.recordTrace({ type: 'usage', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } })
  session.recordTrace({ type: 'turn-end', steps: 1, usage: { totalTokens: 12 }, text: 'ok' })
  const first = store.list()[0]
  assert.equal(first?.usage.totalTokens, 12)
  assert.equal(first?.turns, 1)

  session.recordTrace({ type: 'turn-start', input: 'again' })
  session.recordTrace({ type: 'step-start', step: 1 })
  session.recordTrace({ type: 'usage', usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 } })
  session.recordTrace({ type: 'turn-end', steps: 1, usage: { totalTokens: 23 }, text: 'ok' })
  const second = store.list()[0]
  assert.equal(second?.usage.totalTokens, 35, 'append must invalidate the cached summary')
  assert.equal(second?.usage.requests, 2)
  assert.equal(second?.turns, 2)
})

test('rename persists a title, clears back to the preview and keeps the listing order', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  session.append({ role: 'user', content: 'hello there' })

  const stamp = new Date(1_700_000_000_000)
  utimesSync(session.file, stamp, stamp)

  const meta = store.rename(session.id, '  renamed  ')
  assert.equal(meta.title, '  renamed  ', 'the store keeps the caller-provided title as-is')
  assert.equal(store.open(session.id).meta.title, '  renamed  ')
  assert.equal(store.list()[0]?.title, '  renamed  ')

  const stats = statSync(session.file)
  assert.ok(Math.abs(stats.mtimeMs - stamp.getTime()) < 1_000, 'rename must not bump the transcript mtime')

  store.rename(session.id, undefined)
  assert.equal(store.open(session.id).meta.title, undefined)
  assert.equal(store.list()[0]?.title, 'hello there', 'an explicit title can be cleared')
})

test('fork copies a message prefix into a fresh session without the trace', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  session.append({ role: 'user', content: 'first question' })
  session.append({ role: 'assistant', content: 'first answer' })
  session.append({ role: 'user', content: 'second question' })
  session.recordTrace({ type: 'turn-start', input: 'first question' })

  const sourceCreatedAt = session.meta.createdAt
  const forkStartedAt = Date.now()
  const branch = store.fork(session.id, 2)
  assert.notEqual(branch.id, session.id)
  // `createdAt` has millisecond resolution, so on a fast runner the create and the
  // fork legitimately land in the same millisecond. Assert the branch carries its
  // own stamp instead of demanding the two strings differ.
  assert.ok(
    new Date(branch.meta.createdAt).getTime() >= forkStartedAt,
    'a branch stamps its own creation time rather than inheriting the source',
  )
  assert.equal(session.meta.createdAt, sourceCreatedAt, 'forking must not rewrite the source meta')
  assert.equal(branch.meta.title, 'first question · 分支')
  assert.deepEqual(branch.messages.map((message) => message.role), ['user', 'assistant'])
  assert.equal(branch.messages[0]?.content, 'first question')
  assert.deepEqual(branch.readTrace(), [], 'a branch starts with a clean trace')
  assert.equal(store.list().length, 2)

  assert.equal(store.open(session.id).messages.length, 3, 'the source session is untouched')
  assert.equal(store.open(session.id).readTrace().length, 1)

  const whole = store.fork(session.id)
  assert.equal(whole.messages.length, 3, 'fork without keep copies the whole conversation')
  const empty = store.fork(session.id, 0)
  assert.equal(empty.messages.length, 0)
  assert.match(empty.meta.title ?? '', /· 分支$/)

  assert.throws(() => store.fork(session.id, 4), /keep must be an integer between 0 and 3/)
  assert.throws(() => store.fork(session.id, -1), /keep must be an integer/)
  assert.throws(() => store.fork(session.id, 1.5), /keep must be an integer/)
})

test('delete removes the transcript and trace and rejects unknown ids', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  session.append({ role: 'user', content: 'bye' })
  session.recordTrace({ type: 'turn-start', input: 'bye' })
  const traceFile = session.traceFile

  assert.equal(store.has(session.id), true)
  store.remove(session.id)
  assert.equal(store.has(session.id), false)
  assert.equal(existsSync(session.file), false)
  assert.equal(existsSync(traceFile), false)
  assert.deepEqual(store.list(), [])
  assert.throws(() => store.remove(session.id), /ENOENT/)
  assert.equal(store.has('../../etc/passwd'), false)
})
