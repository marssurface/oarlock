import assert from 'node:assert/strict'
import test from 'node:test'
import { isPrivateHost, webFetchTool } from '../src/tools/web_fetch.ts'

type FakeResponse = {
  status?: number
  statusText?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}

function fakeFetch(routes: Record<string, FakeResponse>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = urlOf(input)
    const route = routes[url]
    if (route === undefined) throw new Error(`no route for ${url}`)
    const headers = new Map(Object.entries(route.headers ?? {}))
    const bodyText = typeof route.body === 'string' ? route.body : ''
    const body = typeof route.body === 'string'
      ? {
          async text() {
            return bodyText
          },
          getReader() {
            const bytes = new TextEncoder().encode(bodyText)
            let offset = 0
            return {
              async read() {
                if (offset >= bytes.byteLength) return { done: true, value: undefined }
                const chunk = bytes.subarray(offset, offset + 64)
                offset += chunk.byteLength
                return { done: false, value: chunk }
              },
              async cancel() {},
            }
          },
        }
      : null
    return {
      ok: (route.status ?? 200) >= 200 && (route.status ?? 200) < 300,
      status: route.status ?? 200,
      statusText: route.statusText ?? 'OK',
      headers: {
        get(name: string) {
          return headers.get(name.toLowerCase()) ?? null
        },
      },
      body,
      async text() {
        return bodyText
      },
    } as unknown as Response
  }) as unknown as typeof fetch
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

const ctx = { cwd: process.cwd() }

test('isPrivateHost blocks loopback, link-local, RFC1918 and localhost names', () => {
  for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'api.local', 'vault.internal']) {
    assert.equal(isPrivateHost(host), true, host)
  }
  for (const ip of ['127.0.0.1', '10.2.3.4', '192.168.0.5', '172.16.0.1', '172.31.255.255', '169.254.169.254', '::1', '[::1]', '0.0.0.0']) {
    assert.equal(isPrivateHost(ip), true, ip)
  }
  for (const publicHost of ['example.com', '172.32.0.1', '169.253.0.1', '192.167.0.1', '8.8.8.8', 'docs.github.com']) {
    assert.equal(isPrivateHost(publicHost), false, publicHost)
  }
})

test('rejects non-http URLs and obviously malformed input without calling fetch', async () => {
  let called = 0
  const tool = webFetchTool({
    fetchImpl: (async () => {
      called += 1
      throw new Error('must not be called')
    }) as unknown as typeof fetch,
  })

  const fileResult = await tool.execute({ url: 'file:///etc/passwd' }, ctx)
  assert.equal(fileResult.isError, true)
  assert.match(fileResult.content, /only http/)

  const garbage = await tool.execute({ url: 'not a url' }, ctx)
  assert.equal(garbage.isError, true)
  assert.match(garbage.content, /not a valid URL/)

  const privateResult = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data' }, ctx)
  assert.equal(privateResult.isError, true)
  assert.match(privateResult.content, /private, loopback/)

  assert.equal(called, 0)
})

test('fetches a page, converts HTML to approximate text, and reports what it kept', async () => {
  const tool = webFetchTool({
    fetchImpl: fakeFetch({
      'https://example.com/release': {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><html><head><title>Notes</title><style>.x{color:red}</style></head>' +
          '<body><script>evil()</script><h1>v1.0.0</h1><p>First&nbsp;release<br>with notes.</p></body></html>',
      },
    }),
  })

  const result = await tool.execute({ url: 'https://example.com/release' }, ctx)
  assert.equal(result.isError, undefined)
  assert.match(result.content, /200 OK · https:\/\/example\.com\/release/)
  assert.match(result.content, /v1\.0\.0/)
  assert.match(result.content, /First release/)
  assert.doesNotMatch(result.content, /evil/, 'script bodies are dropped')
  assert.doesNotMatch(result.content, /\.x\{/, 'style bodies are dropped')
})

test('follows redirects, re-validates each hop, and refuses a private redirect target', async () => {
  let hops: string[] = []
  const tool = webFetchTool({
    fetchImpl: (async (input: string | URL | Request) => {
      const url = urlOf(input)
      hops.push(url)
      if (url === 'https://example.com/old') {
        return {
          ok: false,
          status: 301,
          statusText: 'Moved',
          headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://example.com/new' : null) },
          body: null,
          async text() {
            return ''
          },
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/plain' : null) },
        body: null,
        async text() {
          return 'final page'
        },
      } as unknown as Response
    }) as unknown as typeof fetch,
  })

  const result = await tool.execute({ url: 'https://example.com/old' }, ctx)
  assert.equal(result.isError, undefined)
  assert.deepEqual(hops, ['https://example.com/old', 'https://example.com/new'])
  assert.match(result.content, /final page/)

  hops = []
  const tool2 = webFetchTool({
    fetchImpl: (async (input: string | URL | Request) => {
      const url = urlOf(input)
      hops.push(url)
      return {
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'http://127.0.0.1:8080/admin' : null) },
        body: null,
        async text() {
          return ''
        },
      } as unknown as Response
    }) as unknown as typeof fetch,
  })
  const badRedirect = await tool2.execute({ url: 'https://example.com/start' }, ctx)
  assert.equal(badRedirect.isError, true)
  assert.match(badRedirect.content, /redirect to http:\/\/127\.0\.0\.1:8080\/admin refused/)
})

test('caps the body stream and records truncation instead of buffering everything', async () => {
  const big = 'x'.repeat(300_000)
  const tool = webFetchTool({
    fetchImpl: fakeFetch({
      'https://example.com/big': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: big,
      },
    }),
  })

  const result = await tool.execute({ url: 'https://example.com/big', maxChars: 100 }, ctx)
  assert.equal(result.isError, undefined)
  assert.match(result.content, /truncated to 100 of 300000 chars/)
  assert.ok(result.content.length < 1_000, 'only the kept slice is returned')
})

test('surfaces HTTP error bodies and network failures as tool errors', async () => {
  const tool = webFetchTool({
    fetchImpl: fakeFetch({
      'https://example.com/gone': {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'text/plain' },
        body: 'no such page',
      },
    }),
  })
  const notFound = await tool.execute({ url: 'https://example.com/gone' }, ctx)
  assert.equal(notFound.isError, true)
  assert.match(notFound.content, /HTTP 404/)
  assert.match(notFound.content, /no such page/)

  const boom = webFetchTool({
    fetchImpl: (async () => {
      throw new Error('getaddrinfo ENOTFOUND nope.example')
    }) as unknown as typeof fetch,
  })
  const failed = await boom.execute({ url: 'https://nope.example/' }, ctx)
  assert.equal(failed.isError, true)
  assert.match(failed.content, /ENOTFOUND/)
})

test('binary payloads are reported as such rather than decoded as text', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0])
  const tool = webFetchTool({
    fetchImpl: fakeFetch({
      'https://example.com/logo.png': {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: '',
      },
    }),
  })
  // The fake fetch above returns an empty string, so drive convertBody indirectly:
  // image/png content-type must collapse to the binary placeholder.
  const result = await tool.execute({ url: 'https://example.com/logo.png' }, ctx)
  assert.equal(result.isError, undefined)
  assert.match(result.content, /image\/png payload, 0 bytes — binary content is not extracted/)
  assert.ok(bytes.length > 0, 'placeholder kept for lint')
})
