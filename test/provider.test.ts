import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.ts'
import { ProviderError, parseRetryAfterMs } from '../src/providers/types.ts'
import type { ProviderEvent } from '../src/providers/types.ts'

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('adapter streams reasoning, text, tool calls and usage', async () => {
  const chunks: unknown[] = [
    { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ' world' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.txt"}' } }] } }] },
    {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    },
  ]

  let captured: Record<string, unknown> = {}
  const server = await listen((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      captured = JSON.parse(body) as Record<string, unknown>
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  try {
    const provider = new OpenAICompatibleProvider({
      id: 'test',
      baseUrl: server.url,
      model: 'test-model',
      apiKey: 'secret',
    })
    const events: ProviderEvent[] = []
    for await (const event of provider.stream({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'read a.txt' },
      ],
      tools: [{ name: 'read_file', description: 'read it', parameters: { type: 'object', properties: {} } }],
      temperature: 0,
    })) {
      events.push(event)
    }

    const texts = events.filter((event) => event.type === 'text-delta').map((event) => (event.type === 'text-delta' ? event.text : ''))
    assert.deepEqual(texts, ['Hello', ' world'])
    const reasoning = events.find((event) => event.type === 'reasoning-delta')
    assert.equal(reasoning?.type === 'reasoning-delta' ? reasoning.text : '', 'thinking…')
    const call = events.find((event) => event.type === 'tool-call')
    assert.equal(call?.type === 'tool-call' ? call.call.name : '', 'read_file')
    assert.equal(call?.type === 'tool-call' ? call.call.arguments : '', '{"path":"a.txt"}')
    const usage = events.find((event) => event.type === 'usage')
    assert.equal(usage?.type === 'usage' ? usage.usage.totalTokens : 0, 15)
    assert.equal(usage?.type === 'usage' ? usage.usage.cachedTokens : 0, 4)
    assert.equal(usage?.type === 'usage' ? usage.usage.reasoningTokens : 0, 2)
    const done = events.at(-1)
    assert.equal(done?.type === 'done' ? done.finishReason : '', 'tool_calls')

    assert.equal(captured['stream'], true)
    assert.equal(captured['model'], 'test-model')
    const messages = captured['messages'] as Array<Record<string, unknown>>
    assert.equal(messages[1]?.['content'], 'read a.txt')
    const tools = captured['tools'] as Array<{ function: { name: string } }>
    assert.equal(tools[0]?.function.name, 'read_file')
  } finally {
    await server.close()
  }
})

test('adapter honours a per-request model override', async () => {
  const bodies: Record<string, unknown>[] = []
  const server = await listen((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      bodies.push(JSON.parse(body) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  try {
    const provider = new OpenAICompatibleProvider({ id: 'test', baseUrl: server.url, model: 'big-model' })
    for (const model of [undefined, 'small-model']) {
      for await (const _event of provider.stream({
        messages: [{ role: 'user', content: 'hi' }],
        ...(model !== undefined ? { model } : {}),
      })) {
        // drain
      }
    }
    assert.equal(bodies[0]?.['model'], 'big-model', 'no override keeps the provider default')
    assert.equal(bodies[1]?.['model'], 'small-model', 'the override wins')
  } finally {
    await server.close()
  }
})

test('adapter reads DeepSeek prompt-cache fields', async () => {
  const server = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 7 },
      })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
  try {
    const provider = new OpenAICompatibleProvider({ id: 'deepseek', baseUrl: server.url, model: 'm' })
    let usage: ProviderEvent | undefined
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (event.type === 'usage') usage = event
    }
    assert.equal(usage?.type === 'usage' ? usage.usage.cachedTokens : 0, 7)
    assert.equal(usage?.type === 'usage' ? usage.usage.totalTokens : 0, 15)
  } finally {
    await server.close()
  }
})

test('adapter surfaces HTTP failures with status and body', async () => {
  const server = await listen((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
  })
  try {
    const provider = new OpenAICompatibleProvider({ id: 'test', baseUrl: server.url, model: 'm', apiKey: 'wrong' })
    await assert.rejects(
      async () => {
        for await (const _event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          // drain
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.status, 401)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('adapter tolerates null usage chunks and null usage details', async () => {
  // Volcengine Ark streams `usage: null` on every chunk and only fills it in at the end.
  const chunks: unknown[] = [
    { choices: [{ delta: { content: 'hi' } }], usage: null },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
    {
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_tokens_details: null },
    },
  ]

  const server = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })

  try {
    const provider = new OpenAICompatibleProvider({ id: 'test', baseUrl: server.url, model: 'm' })
    const events: ProviderEvent[] = []
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(event)

    assert.ok(events.some((event) => event.type === 'text-delta' && event.text === 'hi'))
    const usage = events.find((event) => event.type === 'usage')
    assert.ok(usage !== undefined && usage.type === 'usage')
    assert.equal(usage.usage.promptTokens, 7)
    assert.equal(usage.usage.totalTokens, 10)
    assert.equal(usage.usage.cachedTokens, undefined)
    assert.equal(events.at(-1)?.type, 'done')
  } finally {
    await server.close()
  }
})

test('parseRetryAfterMs handles delta-seconds, HTTP-date and garbage', () => {
  const now = Date.parse('2026-11-09T12:00:00Z')
  assert.equal(parseRetryAfterMs('2', now), 2000)
  assert.equal(parseRetryAfterMs('0', now), 0)
  assert.equal(parseRetryAfterMs(' 30 ', now), 30_000)
  assert.equal(parseRetryAfterMs('Mon, 09 Nov 2026 12:00:10 GMT', now), 10_000)
  assert.equal(parseRetryAfterMs('Monday, 09-Nov-26 12:00:10 GMT', now), 10_000)
  // Past dates clamp to zero instead of going negative.
  assert.equal(parseRetryAfterMs('Mon, 09 Nov 2026 11:59:50 GMT', now), 0)
  assert.equal(parseRetryAfterMs(null, now), undefined)
  assert.equal(parseRetryAfterMs(undefined, now), undefined)
  assert.equal(parseRetryAfterMs('', now), undefined)
  assert.equal(parseRetryAfterMs('soon', now), undefined)
  assert.equal(parseRetryAfterMs('-5', now), undefined)
  assert.equal(parseRetryAfterMs('1.5', now), undefined)
})

test('adapter surfaces Retry-After on HTTP failures', async () => {
  const server = await listen((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
    res.end(JSON.stringify({ error: { message: 'rate limited' } }))
  })
  try {
    const provider = new OpenAICompatibleProvider({ id: 'test', baseUrl: server.url, model: 'm' })
    await assert.rejects(
      async () => {
        for await (const _event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          // drain
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.status, 429)
        assert.equal(error.retryAfterMs, 7000)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('adapter leaves retryAfterMs undefined without the header', async () => {
  const server = await listen((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{}')
  })
  try {
    const provider = new OpenAICompatibleProvider({ id: 'test', baseUrl: server.url, model: 'm' })
    await assert.rejects(
      async () => {
        for await (const _event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          // drain
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.retryAfterMs, undefined)
        return true
      },
    )
  } finally {
    await server.close()
  }
})
