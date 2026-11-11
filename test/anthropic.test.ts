import assert from 'node:assert/strict'
import test from 'node:test'
import { AnthropicProvider } from '../src/providers/anthropic.ts'
import type { ProviderEvent, ProviderRequest } from '../src/providers/types.ts'

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

test('system prompt is split out and user turn is wrapped in messages', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  const { impl, sent } = fakeFetch(events)
  const provider = new AnthropicProvider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test', fetchImpl: impl })

  const got: ProviderEvent[] = []
  for await (const event of provider.stream(makeRequest())) got.push(event)

  assert.ok(sent[0] !== undefined)
  const req = sent[0]
  assert.equal(req.body['system'], 'You are oarlock.')
  assert.deepEqual(req.body['messages'], [[{ type: 'text', text: 'Hello.' }]])
  assert.equal(req.body['model'], 'claude-test')
  assert.equal(req.body['max_tokens'], 4096)
  assert.equal(req.headers['x-api-key'], undefined)

  const deltas = got.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)
  assert.deepEqual(deltas, ['Hi ', 'there.'])
  const usage = got.find((e) => e.type === 'usage')
  assert.ok(usage !== undefined)
  assert.deepEqual((usage as { usage: { promptTokens?: number; completionTokens?: number } }).usage, { promptTokens: 10, completionTokens: 5 })
  const done = got.find((e) => e.type === 'done')
  assert.deepEqual(done, { type: 'done', finishReason: 'stop' })
})

test('tool calls stream across content_block_start and input_json_delta', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"README.md"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]
  const { impl } = fakeFetch(events)
  const provider = new AnthropicProvider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test', fetchImpl: impl })

  const got: ProviderEvent[] = []
  for await (const event of provider.stream(makeRequest())) got.push(event)

  const toolCalls = got.filter((e) => e.type === 'tool-call')
  assert.equal(toolCalls.length, 1)
  const call = (toolCalls[0] as { call: { id: string; name: string; arguments: string } }).call
  assert.equal(call.id, 'toolu_1')
  assert.equal(call.name, 'read_file')
  assert.equal(call.arguments, '{"path":"README.md"}')
  const done = got.find((e) => e.type === 'done')
  assert.deepEqual(done, { type: 'done', finishReason: 'tool_calls' })
})

test('assistant turns with tool_use and tool_result messages map back into the wire shape', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  const { impl, sent } = fakeFetch(events)
  const provider = new AnthropicProvider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test', fetchImpl: impl })

  const stream = provider.stream(
    makeRequest({
      messages: [
        { role: 'user', content: 'Read the file.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
        },
        { role: 'tool', content: 'contents of a', toolCallId: 'toolu_1', toolName: 'read_file' },
        { role: 'user', content: 'Now edit it.' },
      ],
    }),
  )
  for await (const _ of stream) { /* drain */ }

  assert.ok(sent[0] !== undefined)
  const req = sent[0]
  const messages = req.body['messages'] as ContentBlockShape[][]
  assert.equal(messages.length, 3, 'three wire turns: user text, assistant tool_use, merged user(text+tool_result)')
  assert.deepEqual(messages[0], [{ type: 'text', text: 'Read the file.' }])
  assert.deepEqual(messages[1], [
    { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
  ])
  assert.deepEqual(messages[2], [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents of a' },
    { type: 'text', text: 'Now edit it.' },
  ])
})

test('tool definitions, api key and anthropic-version headers are sent', async () => {
  const events = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  const { impl, sent } = fakeFetch(events)
  const provider = new AnthropicProvider({
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-test',
    apiKey: 'sk-ant-test',
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
  assert.equal(req.headers['x-api-key'], 'sk-ant-test')
  assert.equal(req.headers['anthropic-version'], '2023-06-01')
  assert.deepEqual(req.body['tools'], [
    { name: 'read_file', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  ])
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
  const provider = new AnthropicProvider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test', fetchImpl: impl })

  const error = await provider.stream(makeRequest()).next().catch((e: unknown) => e)
  assert.ok(error instanceof Error)
  const providerError = error as Error & { status?: number; retryAfterMs?: number; body?: string }
  assert.equal(providerError.name, 'ProviderError')
  assert.equal(providerError.status, 429)
  assert.equal(providerError.retryAfterMs, 5000)
  assert.match(providerError.body ?? '', /rate limited/)
})

type ContentBlockShape = Record<string, unknown>
