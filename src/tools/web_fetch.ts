import type { ToolDefinition, ToolResult } from './types.ts'
import { objectSchema, stringArg } from './util.ts'

export const WEB_FETCH_TOOL_NAME = 'web_fetch'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 1_500_000
const MAX_REDIRECTS = 5
/** Anything larger than this is almost certainly not what the model asked to read. */
const HARD_MAX_BYTES = 8_000_000

interface FetchOptions {
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Built-in WebFetch. The runtime keeps zero third-party dependencies, and Node
 * ≥ 22 ships a global `fetch`, so this is deliberately thin: fetch, cap the
 * stream, turn HTML into approximate plain text, and hand the text to the
 * model. WebSearch is a separate question — it needs a search backend, which
 * WebFetch does not.
 */
export function webFetchTool(options: FetchOptions = {}): ToolDefinition {
  const doFetch = options.fetchImpl ?? fetch
  return {
    name: WEB_FETCH_TOOL_NAME,
    description:
      'Fetch a single http(s) URL and return its content as text (HTML pages are converted to an approximate plain-text form). Use it for pages, docs, issue trackers, release notes and APIs you already know the address of — this tool does not search. Responses are capped, so prefer a specific page over a whole site. For authenticated or private pages it works the same as a plain browser tab without a login session.',
    risk: 'read',
    timeoutMs: DEFAULT_TIMEOUT_MS * (MAX_REDIRECTS + 1),
    parameters: objectSchema(
      {
        url: {
          type: 'string',
          description: 'Absolute http:// or https:// URL to fetch.',
        },
        maxChars: {
          type: 'number',
          description:
            'Approximate maximum characters to return (default 50_000). If the page is longer, content is truncated and the tail is dropped.',
        },
      },
      ['url'],
    ),
    async execute(args, ctx): Promise<ToolResult> {
      const url = stringArg(args, 'url', { required: true }).trim()
      const target = parsePublicUrl(url)
      if (target.error !== undefined) return { content: target.error, isError: true }

      const requestedChars = Number(args['maxChars'] ?? 0)
      const charBudget = Number.isFinite(requestedChars) && requestedChars > 0
        ? Math.min(Math.trunc(requestedChars), 200_000)
        : 50_000
      const byteBudget = Math.min(HARD_MAX_BYTES, Math.max(DEFAULT_MAX_BYTES, charBudget * 4))

      const controller = new AbortController()
      const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      const onAbort = () => controller.abort()
      timeout.addEventListener('abort', onAbort, { once: true })
      ctx.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        let current = target.url
        let redirected = 0
        for (;;) {
          const response = await doFetch(current, {
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': 'oarlock-runtime (+https://github.com/marssurface/oarlock; read-only fetch)' },
          })

          if (isRedirect(response.status)) {
            const location = response.headers.get('location')
            await response.body?.cancel().catch(() => undefined)
            if (location === null || location.trim() === '') {
              return { content: `got ${response.status} with no Location header from ${current}`, isError: true }
            }
            redirected += 1
            if (redirected > MAX_REDIRECTS) {
              return { content: `stopped after ${MAX_REDIRECTS} redirects; last hop was ${current}`, isError: true }
            }
            const next = parsePublicUrl(new URL(location, current).toString())
            if (next.error !== undefined) {
              return { content: `redirect to ${location} refused: ${next.error}`, isError: true }
            }
            current = next.url
            continue
          }

          const contentType = response.headers.get('content-type') ?? ''
          const body = await readCapped(response, byteBudget)
          if (!response.ok) {
            return {
              content: `HTTP ${response.status} ${response.statusText} for ${current}\n${body.text.slice(0, 2_000)}`,
              isError: true,
            }
          }

          const converted = convertBody(body.text, contentType)
          const truncated = converted.text.length > charBudget
          const kept = truncated ? converted.text.slice(0, charBudget) : converted.text
          const header = [
            `${response.status} ${response.statusText} · ${current}`,
            contentType.trim() !== '' ? `content-type: ${(contentType.split(';')[0] ?? '').trim()}` : undefined,
            body.truncated ? `truncated by byte cap at ${body.bytesRead} bytes` : undefined,
            truncated ? `truncated to ${charBudget} of ${converted.text.length} chars (${converted.kind} conversion)` : `${converted.text.length} chars (${converted.kind} conversion)`,
          ].filter((line) => line !== undefined)
          if (kept.trim() === '') return { content: `${header.join('\n')}\n(no usable text body)`, isError: true }
          return { content: `${header.join('\n')}\n\n${kept}` }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return { content: `fetch of ${url} timed out or was cancelled`, isError: true }
        }
        return { content: `fetch of ${url} failed: ${errorMessage(error)}`, isError: true }
      } finally {
        timeout.removeEventListener('abort', onAbort)
        ctx.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}

function parsePublicUrl(raw: string): { url: URL; error?: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { url: new URL('about:blank'), error: `not a valid URL: ${raw.slice(0, 200)}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: parsed, error: `only http(s) URLs are supported, got ${parsed.protocol}` }
  }
  const host = parsed.hostname
  if (isPrivateHost(host)) {
    return { url: parsed, error: `refusing to fetch ${host}: private, loopback or link-local addresses are out of scope` }
  }
  return { url: parsed }
}

/**
 * Best-effort SSRF guard. It cannot hold against a name that resolves to a
 * private address after DNS — true protection would need to pin the resolved
 * IP and re-check it, which `fetch` does not expose. What this catches is the
 * obvious in-URL cases (localhost, 127/8, 169.254/16, RFC1918, ::1) that an
 * attacker plants inside a redirect target.
 */
export function isPrivateHost(host: string): boolean {
  // Strip a trailing FQDN dot (`localhost.`) before matching suffixes.
  const normalized = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal')) {
    return true
  }
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' || normalized.startsWith('fe80:') || normalized === '::') {
    return true
  }
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4 !== null) {
    const parts = ipv4.slice(1).map((octet) => Number(octet))
    if (parts.some((octet) => octet > 255)) return true
    const a = parts[0] ?? 0
    const b = parts[1] ?? 0
    if (a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 0) return true
  }
  return false
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  if (response.body === null) {
    const text = await response.text()
    return { text, bytesRead: Buffer.byteLength(text, 'utf8'), truncated: false }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) {
        const room = maxBytes - bytes
        if (room <= 0) {
          truncated = true
          break
        }
        chunks.push(value.subarray(0, room))
        bytes += Math.min(value.byteLength, room)
        if (value.byteLength > room) truncated = true
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const all = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
  return { text: all.toString('utf8'), bytesRead: bytes, truncated }
}

/**
 * Deliberately not a full HTML parser: strip scripts/styles, strip tags,
 * collapse whitespace. Good enough for docs, release notes and most pages;
 * layouts and interactive content are lost, which is what reading-as-text
 * means.
 */
function convertBody(text: string, contentType: string): { text: string; kind: 'html' | 'binary' | 'raw' } {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/') || type === 'application/pdf') {
    return { text: `(${type} payload, ${text.length} bytes — binary content is not extracted)`, kind: 'binary' }
  }
  if (!type.includes('html') && looksBinary(text)) {
    return { text: `(content-type ${type} looks binary; ${text.length} bytes not extracted)`, kind: 'binary' }
  }
  if (!type.includes('html') && !looksHtml(text)) {
    return { text, kind: 'raw' }
  }
  let html = text
  html = html.replace(/<!doctype[\s\S]*?>/i, '')
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '')
  html = html.replace(/<!--[\s\S]*?-->/g, '')
  html = html.replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|br|header|footer|main|table)>/gi, '\n')
  html = html.replace(/<br\s*\/?>/gi, '\n')
  html = html.replace(/<[^>]+>/g, '')
  html = html
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  html = html.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()
  return { text: html, kind: 'html' }
}

function looksHtml(text: string): boolean {
  const head = text.slice(0, 2_000).toLowerCase()
  return head.includes('<html') || head.includes('<body') || head.includes('<!doctype html')
}

function looksBinary(text: string): boolean {
  const sample = text.slice(0, 1_024)
  let zeros = 0
  for (const char of sample) if (char === ' ') zeros += 1
  return zeros > sample.length / 200
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
