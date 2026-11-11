import assert from 'node:assert/strict'
import test from 'node:test'
import { GeminiProvider } from '../src/providers/gemini.ts'
import type { ProviderEvent, ProviderRequest, Usage } from '../src/providers/types.ts'

type SentRequest = { url: string; body: Record<string, unknown>; headers: Record<string, string> }

function sseBody(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const lines = events.map((event) => `data: ${JSON.stringify(event)}\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines))
      controller.close()
    },
  })
}

function fakeFetch(events: Array<Record<string, unknown>>, status = 200) {
  const sent: SentRequest[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: typeof input === 'string' ? input : input.toString(),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return {
      ok: status >= 200 && status < 300,
      status,
      body: sseBody(events),
      headers: { get: () => null },
      text: async () => '',
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, sent }
}

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    messages: [
      { role: 'system', content: 'You are oarlock.' },
      { role: 'user', content: 'Hello.' },
    ],
    ...overrides,
  }
}

test('systemInstruction is split out and user turn is wrapped in contents', async () => {
  const events = [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Hi ' }] } }] },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'there.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    },
  ]
  const { impl, sent } = fakeFetch(events)
  const provider = new GeminiProvider({ id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-test', fetchImpl: impl })

  const got: ProviderEvent[] = []
  for await (const event of provider.stream(makeRequest())) got.push(event)

  assert.ok(sent[0] !== undefined)
  const req = sent[0]
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse')
  assert.deepEqual(req.body['systemInstruction'], { role: 'user', parts: [{ text: 'You are oarlock.' }] })
  assert.deepEqual(req.body['contents'], [{ role: 'user', parts: [{ text: 'Hello.' }] }])
  assert.equal(req.headers['x-goog-api-key'], undefined)

  const deltas = got.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)
  assert.deepEqual(deltas, ['Hi ', 'there.'])
  const usage = got.find((e) => e.type === 'usage')
  assert.ok(usage !== undefined)
  assert.deepEqual((usage as { usage: Usage }).usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  const done = got.find((e) => e.type === 'done')
  assert.deepEqual(done, { type: 'done', finishReason: 'stop' })
})

test('functionCall parts stream into tool-call events', async () => {
  const events = [
    {
      candidates: [
        { content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'README.md' } } }] }, finishReason: 'STOP' },
      ],
    },
  ]
  const { impl } = fakeFetch(events)
  const provider = new GeminiProvider({ id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-test', fetchImpl: impl })

  const got: ProviderEvent[] = []
  for await (const event of provider.stream(makeRequest())) got.push(event)

  const toolCalls = got.filter((e) => e.type === 'tool-call')
  assert.equal(toolCalls.length, 1)
  const call = (toolCalls[0] as { call: { id: string; name: string; arguments: string } }).call
  assert.match(call.id, /^call_/)
  assert.equal(call.name, 'read_file')
  assert.equal(call.arguments, '{"path":"README.md"}')
  const done = got.find((e) => e.type === 'done')
  assert.deepEqual(done, { type: 'done', finishReason: 'tool_calls' })
})

test('assistant functionCall and tool functionResponse map back into the wire shape', async () => {
  const events = [{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]
  const { impl, sent } = fakeFetch(events)
  const provider = new GeminiProvider({ id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-test', fetchImpl: impl })

  const stream = provider.stream(
    makeRequest({
      messages: [
        { role: 'user', content: 'Read the file.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
        { role: 'tool', content: 'contents of a', toolCallId: 'call_1', toolName: 'read_file' },
        { role: 'user', content: 'Now edit it.' },
      ],
    }),
  )
  for await (const _ of stream) { /* drain */ }

  assert.ok(sent[0] !== undefined)
  const contents = sent[0].body['contents'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>
  assert.equal(contents.length, 3, 'three wire turns: user text, model functionCall, merged user(functionResponse+text)')
  assert.deepEqual(contents[0], { role: 'user', parts: [{ text: 'Read the file.' }] })
  assert.deepEqual(contents[1], { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] })
  assert.deepEqual(contents[2], {
    role: 'user',
    parts: [
      { functionResponse: { name: 'read_file', response: { result: 'contents of a' } } },
      { text: 'Now edit it.' },
    ],
  })
})

test('functionDeclarations and x-goog-api-key header are sent', async () => {
  const events = [{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]
  const { impl, sent } = fakeFetch(events)
  const provider = new GeminiProvider({
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-test',
    apiKey: 'goog-test',
    fetchImpl: impl,
  })

  const stream = provider.stream(
    makeRequest({
      tools: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    }),
  )
  for await (const _ of stream) { /* drain */ }

  assert.ok(sent[0] !== undefined)
  const req = sent[0]
  assert.equal(req.headers['x-goog-api-key'], 'goog-test')
  assert.deepEqual(req.body['tools'], [
    { functionDeclarations: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] },
  ])
})

test('thought parts become reasoning-delta and usage maps cache + reasoning tokens', async () => {
  const events = [
    { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }] },
    {
      candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28, cachedContentTokenCount: 12, thoughtsTokenCount: 3 },
    },
  ]
  const { impl } = fakeFetch(events)
  const provider = new GeminiProvider({ id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-test', fetchImpl: impl })

  const got: ProviderEvent[] = []
  for await (const event of provider.stream(makeRequest())) got.push(event)

  const reasoning = got.filter((e) => e.type === 'reasoning-delta').map((e) => (e as { text: string }).text)
  assert.deepEqual(reasoning, ['thinking'])
  const text = got.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)
  assert.deepEqual(text, ['answer'])
  const usage = got.find((e) => e.type === 'usage')
  assert.ok(usage !== undefined)
  assert.deepEqual((usage as { usage: Usage }).usage, {
    promptTokens: 20,
    completionTokens: 8,
    totalTokens: 28,
    cachedTokens: 12,
    reasoningTokens: 3,
  })
})

test('MAX_TOKENS finish reason maps to length', async () => {
  const events = [{ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] }]
  const { impl } = fakeFetch(events)
  const provider = new GeminiProvider({ id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-test', fetchImpl: impl })

  const got: ProviderEvent[] = []
  for await (const event of provider.stream(makeRequest())) got.push(event)
  const done = got.find((e) => e.type === 'done')
  assert.deepEqual(done, { type: 'done', finishReason: 'length' })
})

test('model override and a /models-suffixed baseUrl build the endpoint correctly', async () => {
  const events = [{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]
  const { impl, sent } = fakeFetch(events)
  const provider = new GeminiProvider({ id: 'gemini', baseUrl: 'https://gw.example/v1beta/models/', model: 'gemini-base', fetchImpl: impl })

  const stream = provider.stream(makeRequest({ model: 'gemini-override' }))
  for await (const _ of stream) { /* drain */ }

  assert.ok(sent[0] !== undefined)
  assert.equal(sent[0].url, 'https://gw.example/v1beta/models/gemini-override:streamGenerateContent?alt=sse')
})

test('HTTP errors carry status, body and retry-after', async () => {
  const impl = (async () => {
    return {
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '5' : null) },
      text: async () => 'rate limited',
    } as unknown as Response
  }) as unknown as typeof fetch
  const provider = new GeminiProvider({ id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-test', fetchImpl: impl })

  const error = await provider.stream(makeRequest()).next().catch((e: unknown) => e)
  assert.ok(error instanceof Error)
  const providerError = error as Error & { status?: number; retryAfterMs?: number; body?: string }
  assert.equal(providerError.name, 'ProviderError')
  assert.equal(providerError.status, 429)
  assert.equal(providerError.retryAfterMs, 5000)
  assert.match(providerError.body ?? '', /rate limited/)
})