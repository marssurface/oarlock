import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent } from '../src/core/agent.ts'
import { autoApproval } from '../src/core/approval.ts'
import { ContextManager } from '../src/core/context.ts'
import type { ChatMessage, ImagePart, ProviderRequest } from '../src/providers/types.ts'
import { imagesOf, messageContent, textOf } from '../src/providers/content.ts'
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.ts'
import { SessionStore } from '../src/session/store.ts'
import { createAgentServer } from '../src/web/server.ts'
import { resolveConfig } from '../src/config.ts'
import { collect, scripted, tempDir, text } from './helpers.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const IMAGE: ImagePart = { type: 'image', mimeType: 'image/png', data: PNG }

test('content helpers read text and images without losing either', () => {
  assert.equal(textOf('plain'), 'plain')
  assert.equal(textOf([{ type: 'text', text: 'a' }, IMAGE, { type: 'text', text: 'b' }]), 'a\nb')
  assert.deepEqual(imagesOf('plain'), [])
  assert.deepEqual(imagesOf([IMAGE]), [IMAGE])
  assert.equal(messageContent('hi', []), 'hi')
  assert.deepEqual(messageContent('hi', [IMAGE]), [{ type: 'text', text: 'hi' }, IMAGE])
  assert.deepEqual(messageContent('', [IMAGE]), [IMAGE])
})

test('the OpenAI adapter maps image parts to image_url data URLs', async () => {
  let body: Record<string, unknown> | undefined
  const provider = new OpenAICompatibleProvider({
    id: 'wire',
    baseUrl: 'https://example.test/v1',
    model: 'vision-1',
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const chunk = { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 })
    },
  })

  const events = []
  for await (const event of provider.stream({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'describe' }, IMAGE] },
      { role: 'assistant', content: [{ type: 'text', text: 'looks fine' }] },
    ],
  })) {
    events.push(event)
  }

  const messages = body?.['messages'] as Array<Record<string, unknown>>
  assert.deepEqual(messages[1]?.['content'], [
    { type: 'text', text: 'describe' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
  ])
  // Assistant content is always flattened back to text on the wire.
  assert.equal(messages[2]?.['content'], 'looks fine')
  assert.equal(events.at(-1)?.type, 'done')
})

test('Agent.run stores images as user content parts and announces them', async () => {
  const requests: ProviderRequest[] = []
  const provider = scripted((request) => {
    requests.push(request)
    return text('seen')
  })
  const agent = new Agent({ provider, cwd: tempDir(), approval: autoApproval() })

  const events = await collect(agent.run('describe', undefined, [IMAGE]))
  const start = events.find((event) => event.type === 'turn-start')
  assert.equal(start?.type === 'turn-start' ? start.attachments : undefined, 1)

  const user = agent.history().find((message) => message.role === 'user')
  assert.deepEqual(user?.content, [{ type: 'text', text: 'describe' }, IMAGE])
  const sent = requests[0]?.messages.find((message) => message.role === 'user')
  assert.deepEqual(sent?.content, [{ type: 'text', text: 'describe' }, IMAGE])
})

test('Agent.run without images keeps the transcript a plain string', async () => {
  const provider = scripted(() => text('ok'))
  const agent = new Agent({ provider, cwd: tempDir(), approval: autoApproval() })
  await collect(agent.run('hello'))
  assert.equal(agent.history()[0]?.content, 'hello')
})

test('context estimates images and serializes them as placeholders', async () => {
  const context = new ContextManager({ window: 10_000, keepRecent: 4 })
  const plain = context.estimate([{ role: 'user', content: 'hello' }])
  const withImage = context.estimate([{ role: 'user', content: [IMAGE] }])
  assert.ok(withImage >= 1200, `image estimate too small: ${withImage}`)
  assert.ok(withImage > plain, 'an image should outweigh a short text message')

  let summaryRequest = ''
  const conversation: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'what is this?' }, IMAGE] },
    ...Array.from({ length: 7 }, (_, index): ChatMessage => ({
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `turn ${index}`,
    })),
  ]
  const provider = scripted((request) => {
    summaryRequest = textOf(request.messages[1]?.content ?? '')
    return text('SUMMARY')
  })
  const result = await context.compact(conversation, provider, undefined, { force: true })
  assert.ok(result !== undefined)
  assert.match(summaryRequest, /\[image: image\/png\]/)
  assert.ok(!summaryRequest.includes(PNG), 'base64 must not leak into the summary request')
})

test('sessions persist image parts and title image-only conversations', () => {
  const dir = tempDir()
  const store = new SessionStore(dir)
  const session = store.create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  session.append({ role: 'user', content: [IMAGE] })

  const reopened = store.open(session.id)
  assert.deepEqual(reopened.messages[0]?.content, [IMAGE])
  assert.equal(store.list()[0]?.title, '[1 张图片]')
})

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const dir = tempDir()
  const config = resolveConfig({ provider: 'mock', cwd: dir, approval: 'auto' })
  const agent = createAgentServer(config)
  await new Promise<void>((resolve) => agent.server.listen(0, '127.0.0.1', resolve))
  const address = agent.server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    agent.server.closeAllConnections()
    await new Promise<void>((resolve) => agent.server.close(() => resolve()))
  }
}

async function newSession(base: string): Promise<string> {
  const response = await fetch(`${base}/api/sessions`, { method: 'POST' })
  const data = (await response.json()) as { id: string }
  return data.id
}

async function postMessage(
  base: string,
  id: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (response.status === 200) {
    await response.text()
    return { status: 200, body: {} }
  }
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('POST /messages accepts an image-only turn and records the attachment', async () => {
  await withServer(async (base) => {
    const id = await newSession(base)
    const sent = await postMessage(base, id, {
      text: '',
      images: [{ mimeType: 'image/png', data: PNG }],
    })
    assert.equal(sent.status, 200)

    const session = (await (await fetch(`${base}/api/sessions/${id}`)).json()) as {
      messages: ChatMessage[]
    }
    const user = session.messages.find((message) => message.role === 'user')
    assert.deepEqual(user?.content, [IMAGE])

    const trace = (await (await fetch(`${base}/api/sessions/${id}/trace`)).json()) as {
      events: Array<{ event: Record<string, unknown> }>
    }
    const start = trace.events.find((record) => record.event['type'] === 'turn-start')
    assert.equal(start?.event['attachments'], 1)
    assert.equal(start?.event['input'], '')
  })
})

test('POST /messages rejects malformed image payloads with 400', async () => {
  await withServer(async (base) => {
    const id = await newSession(base)
    const cases: Array<{ payload: Record<string, unknown>; pattern: RegExp }> = [
      { payload: { text: 'hi', images: 'nope' }, pattern: /images must be an array/ },
      { payload: { text: 'hi', images: [{ mimeType: 'image/svg+xml', data: PNG }] }, pattern: /unsupported image type/ },
      { payload: { text: 'hi', images: [{ mimeType: 'image/png', data: 'not base64' }] }, pattern: /must be base64/ },
      {
        payload: {
          text: 'hi',
          images: Array.from({ length: 5 }, () => ({ mimeType: 'image/png', data: PNG })),
        },
        pattern: /at most 4 images/,
      },
      { payload: {}, pattern: /text or images is required/ },
    ]
    for (const { payload, pattern } of cases) {
      const response = await postMessage(base, id, payload)
      assert.equal(response.status, 400)
      assert.match(String(response.body['error']), pattern)
    }
  })
})
