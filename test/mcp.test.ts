import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { autoApproval } from '../src/core/approval.ts'
import { createRuntime } from '../src/core/setup.ts'
import { resolveConfig } from '../src/config.ts'
import { loadMcpServers, parseMcpConfig, readMcpConfig } from '../src/mcp/index.ts'
import { SessionStore } from '../src/session/store.ts'
import type { ToolDefinition } from '../src/tools/types.ts'
import { tempDir } from './helpers.ts'

// A tiny newline-delimited JSON-RPC MCP server used by the integration tests.
const FAKE = `
import { createInterface } from 'node:readline'
const hangList = process.argv.includes('--hang-list')
const tools = [
  { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } }
]
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let message
  try { message = JSON.parse(line) } catch { return }
  const { id, method, params } = message
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } } })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') {
    if (hangList) return
    send({ jsonrpc: '2.0', id, result: { tools } })
    return
  }
  if (method === 'tools/call') {
    if (params?.name === 'fail') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } })
      return
    }
    const text = params?.arguments?.text ?? ''
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'echo: ' + text }, { type: 'text', text: 'second' }] } })
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
})
`

function setupFake(options: { hangList?: boolean; timeoutMs?: number } = {}): string {
  const dir = tempDir()
  writeFileSync(join(dir, 'fake-mcp.mjs'), FAKE)
  mkdirSync(join(dir, '.agent'), { recursive: true })
  const server: Record<string, unknown> = {
    command: process.execPath,
    args: [join(dir, 'fake-mcp.mjs'), ...(options.hangList === true ? ['--hang-list'] : [])],
    risk: 'read',
  }
  if (options.timeoutMs !== undefined) server['timeoutMs'] = options.timeoutMs
  writeFileSync(join(dir, '.agent/mcp.json'), JSON.stringify({ servers: { fake: server } }))
  return dir
}

test('parseMcpConfig keeps valid servers and drops malformed entries', () => {
  const config = parseMcpConfig({
    servers: {
      ok: { command: 'node', args: ['a.mjs'], risk: 'read', timeoutMs: 5000, env: { A: '1' } },
      'bad name': { command: 'node' },
      noCommand: { args: ['x'] },
      badRisk: { command: 'node', risk: 'nuclear' },
    },
  })
  assert.deepEqual(Object.keys(config.servers), ['ok', 'badRisk'])
  assert.deepEqual(config.servers['ok'], { command: 'node', args: ['a.mjs'], risk: 'read', timeoutMs: 5000, env: { A: '1' } })
  // An unknown risk is dropped, not fatal: the server keeps running with the default risk.
  assert.deepEqual(config.servers['badRisk'], { command: 'node' })
})

test('readMcpConfig defaults to no servers when the file is absent', () => {
  assert.deepEqual(readMcpConfig(tempDir()), { servers: {} })
})

test('loadMcpServers handshakes, lists tools and maps calls', async () => {
  const dir = setupFake()
  const mcp = await loadMcpServers(dir)
  try {
    assert.deepEqual(mcp.servers, ['fake'])
    assert.deepEqual(mcp.errors, [])
    assert.deepEqual(
      mcp.tools.map((tool) => tool.name),
      ['mcp__fake__echo', 'mcp__fake__fail'],
    )
    const echo = mcp.tools.find((tool) => tool.name === 'mcp__fake__echo')
    assert.equal(echo?.description, 'Echo the text back')
    assert.equal(echo?.risk, 'read')
    assert.deepEqual(echo?.parameters.required, ['text'])
    assert.deepEqual(echo?.parameters.properties, { text: { type: 'string' } })

    const echoed = await echo?.execute({ text: 'hi' }, { cwd: dir })
    assert.equal(echoed?.content, 'echo: hi\nsecond')
    assert.equal(echoed?.isError, undefined)

    const fail = mcp.tools.find((tool) => tool.name === 'mcp__fake__fail')
    const failed = await fail?.execute({}, { cwd: dir })
    assert.equal(failed?.isError, true)
    assert.equal(failed?.content, 'boom')
  } finally {
    await mcp.close()
  }
})

test('loadMcpServers skips a broken server without throwing', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, '.agent'), { recursive: true })
  writeFileSync(
    join(dir, '.agent/mcp.json'),
    JSON.stringify({ servers: { ghost: { command: '/nonexistent/mcp-binary-xyz' } } }),
  )
  const mcp = await loadMcpServers(dir)
  try {
    assert.deepEqual(mcp.servers, [])
    assert.deepEqual(mcp.tools, [])
    assert.equal(mcp.errors.length, 1)
    const [firstError] = mcp.errors
    if (firstError === undefined) throw new Error('expected one MCP load error')
    assert.match(firstError, /ghost:/)
  } finally {
    await mcp.close()
  }
})

test('loadMcpServers times out a silent server and skips it', async () => {
  const dir = setupFake({ hangList: true, timeoutMs: 300 })
  const mcp = await loadMcpServers(dir)
  try {
    assert.deepEqual(mcp.servers, [])
    assert.equal(mcp.errors.length, 1)
    const [firstError] = mcp.errors
    if (firstError === undefined) throw new Error('expected one MCP load error')
    assert.match(firstError, /timed out/)
  } finally {
    await mcp.close()
  }
})

test('createRuntime merges extra tools and skips duplicate names', () => {
  const dir = tempDir()
  const config = resolveConfig({ provider: 'mock', cwd: dir, approval: 'auto' })
  const session = new SessionStore(join(dir, '.agent/sessions')).create({ cwd: dir, provider: 'mock', model: 'mock-1' })
  const ping: ToolDefinition = {
    name: 'mcp__t__ping',
    description: 'Ping',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    execute: async () => ({ content: 'pong' }),
  }
  const duplicate: ToolDefinition = {
    name: 'read_file',
    description: 'shadow attempt',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    execute: async () => ({ content: 'nope' }),
  }
  const runtime = createRuntime(config, session, { approval: autoApproval(), extraTools: [ping, duplicate] })
  assert.equal(runtime.tools.has('mcp__t__ping'), true)
  assert.equal(runtime.tools.get('read_file')?.description !== 'shadow attempt', true)
})
