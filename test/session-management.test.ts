import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { createAgentServer } from '../src/web/server.ts'
import { tempDir } from './helpers.ts'

async function withServer(
  run: (base: string, agent: ReturnType<typeof createAgentServer>) => Promise<void>,
): Promise<void> {
  const cwd = tempDir()
  const config = resolveConfig({ cwd, provider: 'mock', model: 'mock-1' })
  const agent = createAgentServer(config)
  const { server } = agent
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => done())
  })
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, agent)
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done())
    })
  }
}

const sendJson = (url: string, method: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const getJson = async (url: string): Promise<Record<string, unknown>> =>
  (await (await fetch(url)).json()) as Record<string, unknown>

async function createSession(base: string): Promise<string> {
  const response = await sendJson(`${base}/api/sessions`, 'POST', {})
  assert.equal(response.status, 200)
  return ((await response.json()) as { id: string }).id
}

test('PATCH renames a session and clearing the title restores the preview', async () => {
  await withServer(async (base, agent) => {
    const id = await createSession(base)
    const stored = agent.store.open(id)
    stored.append({ role: 'user', content: 'hello there' })
    stored.append({ role: 'assistant', content: 'hi' })

    const renamed = await sendJson(`${base}/api/sessions/${id}`, 'PATCH', { title: '  新标题  ' })
    assert.equal(renamed.status, 200)
    assert.deepEqual(await renamed.json(), { ok: true, id, title: '新标题' })
    const list = (await getJson(`${base}/api/sessions`)) as {
      sessions: Array<{ id: string; title: string }>
    }
    assert.equal(list.sessions[0]?.title, '新标题')

    const reopened = await getJson(`${base}/api/sessions/${id}`)
    assert.equal((reopened['meta'] as { title?: string }).title, '新标题')

    const cleared = await sendJson(`${base}/api/sessions/${id}`, 'PATCH', { title: '' })
    assert.equal(cleared.status, 200)
    assert.equal(((await cleared.json()) as { title: unknown }).title, null)
    const afterClear = (await getJson(`${base}/api/sessions`)) as { sessions: Array<{ title: string }> }
    assert.equal(afterClear.sessions[0]?.title, 'hello there')

    assert.equal((await sendJson(`${base}/api/sessions/${id}`, 'PATCH', { title: 42 })).status, 400)
    assert.equal((await sendJson(`${base}/api/sessions/${id}`, 'PATCH', { title: 'x'.repeat(121) })).status, 400)
    assert.equal((await sendJson(`${base}/api/sessions/nope`, 'PATCH', { title: 'x' })).status, 404)
  })
})

test('DELETE removes the transcript, trace and live state', async () => {
  await withServer(async (base, agent) => {
    const id = await createSession(base)
    const stored = agent.store.open(id)
    stored.append({ role: 'user', content: 'delete me' })
    stored.recordTrace({ type: 'turn-start', input: 'delete me' })
    await getJson(`${base}/api/sessions/${id}`)
    assert.ok(agent.sessions.has(id))

    const response = await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' })
    assert.equal(response.status, 200)
    assert.equal(agent.sessions.has(id), false)
    assert.equal(agent.store.has(id), false)
    assert.equal(existsSync(stored.file), false)
    assert.equal(existsSync(stored.traceFile), false)
    assert.deepEqual(((await getJson(`${base}/api/sessions`)) as { sessions: unknown[] }).sessions, [])
    assert.equal((await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' })).status, 404)
  })
})

test('POST fork copies a prefix, keeps the source and starts a clean trace', async () => {
  await withServer(async (base, agent) => {
    const id = await createSession(base)
    const stored = agent.store.open(id)
    stored.append({ role: 'user', content: 'first question' })
    stored.append({ role: 'assistant', content: 'first answer' })
    stored.append({ role: 'user', content: 'second question' })
    stored.append({ role: 'assistant', content: 'second answer' })
    stored.recordTrace({ type: 'turn-start', input: 'first question' })

    const response = await sendJson(`${base}/api/sessions/${id}/fork`, 'POST', { keep: 2 })
    assert.equal(response.status, 200)
    const forked = (await response.json()) as { id: string; meta: { title: string } }
    assert.notEqual(forked.id, id)
    assert.match(forked.meta.title, /first question · 分支$/)

    const opened = (await getJson(`${base}/api/sessions/${forked.id}`)) as {
      messages: Array<{ role: string; content: string }>
    }
    assert.deepEqual(opened.messages.map((message) => message.role), ['user', 'assistant'])
    assert.equal(opened.messages[1]?.content, 'first answer')
    const trace = (await getJson(`${base}/api/sessions/${forked.id}/trace`)) as { events: unknown[] }
    assert.deepEqual(trace.events, [])

    assert.equal(agent.store.open(id).messages.length, 4, 'the source session is untouched')
    const list = (await getJson(`${base}/api/sessions`)) as { sessions: unknown[] }
    assert.equal(list.sessions.length, 2)

    assert.equal((await sendJson(`${base}/api/sessions/${id}/fork`, 'POST', { keep: 99 })).status, 400)
    assert.equal((await sendJson(`${base}/api/sessions/${id}/fork`, 'POST', { keep: '2' })).status, 400)
    assert.equal((await sendJson(`${base}/api/sessions/nope/fork`, 'POST', {})).status, 404)
  })
})

test('mutations are rejected while a session is running', async () => {
  await withServer(async (base, agent) => {
    const id = await createSession(base)
    await getJson(`${base}/api/sessions/${id}`)
    const state = agent.sessions.get(id)
    assert.ok(state !== undefined)
    state.running = true

    assert.equal((await sendJson(`${base}/api/sessions/${id}`, 'PATCH', { title: 'busy' })).status, 409)
    assert.equal((await sendJson(`${base}/api/sessions/${id}/fork`, 'POST', {})).status, 409)
    assert.equal((await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' })).status, 409)
    assert.equal(agent.store.has(id), true)
  })
})
