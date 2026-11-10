import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig, writeSettings } from '../src/config.ts'
import { autoApproval } from '../src/core/approval.ts'
import { createRuntime } from '../src/core/setup.ts'
import { SessionStore } from '../src/session/store.ts'
import { createAgentServer } from '../src/web/server.ts'
import { VENDOR_PRESETS } from '../src/web/presets.ts'
import { tempDir } from './helpers.ts'

async function withServer(
  run: (base: string, cwd: string, agent: ReturnType<typeof createAgentServer>) => Promise<void>,
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
    await run(`http://127.0.0.1:${address.port}`, cwd, agent)
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done())
    })
  }
}

const postJson = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const postSettings = (base: string, body: unknown): Promise<Response> => postJson(`${base}/api/settings`, body)

test('aborting a running turn releases pending gates and aborts the controller', async () => {
  await withServer(async (base, _cwd, agent) => {
    const created = await postJson(`${base}/api/sessions`, {})
    const { id } = (await created.json()) as { id: string }
    await fetch(`${base}/api/sessions/${id}`)
    const state = agent.sessions.get(id)
    assert.ok(state !== undefined, 'session state should exist after opening it')

    const controller = new AbortController()
    state.running = true
    state.abort = controller
    let decision: string | undefined
    let answer: string | undefined
    state.pending.set('a1', (value) => {
      decision = value
    })
    state.pendingAsks.set('q1', (value) => {
      answer = value.status
    })

    const response = await postJson(`${base}/api/sessions/${id}/abort`, {})
    assert.equal(response.status, 200)
    assert.equal(controller.signal.aborted, true)
    assert.equal(decision, 'deny')
    assert.equal(answer, 'skipped')
    assert.equal(state.pending.size, 0)
    assert.equal(state.pendingAsks.size, 0)
  })
})

test('runtime takes the context window from the active enabled model', () => {
  const cwd = tempDir()
  writeSettings(cwd, {
    provider: 'mock',
    model: 'mock-1',
    baseUrl: 'http://mock.invalid/v1',
    models: [
      {
        provider: 'mock',
        baseUrl: 'http://mock.invalid/v1',
        model: 'mock-1',
        contextWindow: 12_345,
        maxOutputTokens: 100,
      },
    ],
  })
  const config = resolveConfig({ cwd })
  const store = new SessionStore(config.sessionsDir)
  const session = store.create({ cwd: config.cwd, provider: config.provider, model: config.model })
  const runtime = createRuntime(config, session, { approval: autoApproval() })
  assert.equal(runtime.context.options.window, 12_345)
})

test('per-turn budgets resolve from env, honour overrides and ignore invalid values', () => {
  const cwd = tempDir()
  const previous = {
    tokens: process.env['AGENT_MAX_TURN_TOKENS'],
    ms: process.env['AGENT_MAX_TURN_MS'],
  }
  try {
    process.env['AGENT_MAX_TURN_TOKENS'] = '5000'
    process.env['AGENT_MAX_TURN_MS'] = '60000'
    const fromEnv = resolveConfig({ cwd, provider: 'mock' })
    assert.equal(fromEnv.maxTurnTokens, 5000)
    assert.equal(fromEnv.maxTurnMs, 60000)

    const overridden = resolveConfig({ cwd, provider: 'mock', maxTurnTokens: 100, maxTurnMs: 200 })
    assert.equal(overridden.maxTurnTokens, 100)
    assert.equal(overridden.maxTurnMs, 200)

    delete process.env['AGENT_MAX_TURN_TOKENS']
    delete process.env['AGENT_MAX_TURN_MS']
    const unset = resolveConfig({ cwd, provider: 'mock' })
    assert.equal(unset.maxTurnTokens, undefined, 'no env means no budget')
    assert.equal(unset.maxTurnMs, undefined)

    process.env['AGENT_MAX_TURN_TOKENS'] = 'not-a-number'
    const invalid = resolveConfig({ cwd, provider: 'mock' })
    assert.equal(invalid.maxTurnTokens, undefined, 'invalid env values are ignored')
  } finally {
    if (previous.tokens === undefined) delete process.env['AGENT_MAX_TURN_TOKENS']
    else process.env['AGENT_MAX_TURN_TOKENS'] = previous.tokens
    if (previous.ms === undefined) delete process.env['AGENT_MAX_TURN_MS']
    else process.env['AGENT_MAX_TURN_MS'] = previous.ms
  }
})

async function withModelServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }))
      return
    }
    if (req.url === '/locked/v1/models') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad key' } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => done())
  })
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done())
    })
  }
}

test('settings endpoint lists vendor presets without leaking the key', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/settings`)
    assert.equal(response.status, 200)
    const body = await response.json()

    assert.equal(body.provider, 'mock')
    assert.equal(body.hasKey, false)
    assert.equal(body.presets.length, VENDOR_PRESETS.length)
    assert.equal('apiKey' in body, false)

    const ids = body.presets.map((preset: { id: string }) => preset.id)
    for (const id of [
      'deepseek',
      'openai',
      'qwen',
      'volcengine',
      'volcengine-coding',
      'moonshot',
      'kimi-coding',
      'kimi-coding-intl',
      'zhipu',
      'zhipu-coding',
      'zhipu-coding-intl',
      'siliconflow',
      'stepfun',
      'ollama',
      'mock',
      'custom',
    ]) {
      assert.ok(ids.includes(id), `missing preset ${id}`)
    }
  })
})

test('saving settings persists them and updates the running config', async () => {
  await withServer(async (base, cwd) => {
    const response = await postSettings(base, {
      provider: 'openai',
      model: 'qwen-max',
      baseUrl: 'https://example.com/v1/',
      apiKey: 'sk-test',
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.provider, 'openai')
    assert.equal(body.model, 'qwen-max')
    assert.equal(body.baseUrl, 'https://example.com/v1')
    assert.equal(body.hasKey, true)
    assert.equal('apiKey' in body, false)

    const persisted = JSON.parse(readFileSync(join(cwd, '.agent/settings.json'), 'utf8'))
    assert.deepEqual(persisted, {
      provider: 'openai',
      model: 'qwen-max',
      baseUrl: 'https://example.com/v1',
      models: [{ provider: 'openai', baseUrl: 'https://example.com/v1', model: 'qwen-max' }],
    })
    const keys = JSON.parse(readFileSync(join(cwd, '.agent/keys.json'), 'utf8'))
    assert.deepEqual(keys, { 'https://example.com/v1': 'sk-test' })

    const config = await (await fetch(`${base}/api/config`)).json()
    assert.equal(config.provider, 'openai')
    assert.equal(config.model, 'qwen-max')
    assert.equal(config.baseUrl, 'https://example.com/v1')
    assert.match(config.summary, /key set/)

    const resolved = resolveConfig({ cwd })
    assert.equal(resolved.provider, 'openai')
    assert.equal(resolved.model, 'qwen-max')
    assert.equal(resolved.apiKey, 'sk-test')
  })
})

test('null apiKey clears the stored key', async () => {
  await withServer(async (base, cwd) => {
    const first = await postSettings(base, {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-first',
    })
    assert.equal((await first.json()).hasKey, true)

    const cleared = await postSettings(base, {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: null,
    })
    assert.equal((await cleared.json()).hasKey, false)

    const persisted = JSON.parse(readFileSync(join(cwd, '.agent/settings.json'), 'utf8'))
    assert.equal('apiKey' in persisted, false)
    const keys = JSON.parse(readFileSync(join(cwd, '.agent/keys.json'), 'utf8'))
    assert.equal('https://api.openai.com/v1' in keys, false)
  })
})

test('keys are scoped per endpoint instead of following the active vendor', async () => {
  await withServer(async (base, cwd) => {
    await postSettings(base, {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-first',
    })

    const switched = await postSettings(base, {
      provider: 'openai',
      model: 'qwen-max',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })
    assert.equal((await switched.json()).hasKey, false, 'the old endpoint key must not travel')

    const keys = JSON.parse(readFileSync(join(cwd, '.agent/keys.json'), 'utf8'))
    assert.deepEqual(keys, { 'https://api.openai.com/v1': 'sk-first' })

    const kept = await postSettings(base, {
      provider: 'openai',
      model: 'qwen-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-qwen',
    })
    assert.equal((await kept.json()).hasKey, true)

    const modelOnly = await postSettings(base, {
      provider: 'openai',
      model: 'qwen3-coder-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })
    assert.equal((await modelOnly.json()).hasKey, true, 'same endpoint should keep the key')

    const keyed = (await (await fetch(`${base}/api/settings`)).json()).keyed
    assert.deepEqual(keyed.sort(), [
      'https://api.openai.com/v1',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    ])
  })
})

test('the enabled list is the switcher source and never carries a key', async () => {
  await withServer(async (base, cwd) => {
    assert.deepEqual((await (await fetch(`${base}/api/settings`)).json()).enabled, [])

    // saving the active model enables it
    const saved = await postSettings(base, {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-first',
    })
    assert.deepEqual((await saved.json()).enabled, [
      { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
    ])

    // enabling is separate from switching: the active config must not move
    const enabled = await postJson(`${base}/api/settings/enabled`, {
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'sk-second',
    })
    const body = await enabled.json()
    assert.equal(body.model, 'gpt-4.1-mini', 'enabling should not switch the active model')
    assert.deepEqual(body.enabled, [
      { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
      { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
    ])
    for (const entry of body.enabled) assert.equal('apiKey' in entry, false)

    const persisted = JSON.parse(readFileSync(join(cwd, '.agent/settings.json'), 'utf8'))
    assert.deepEqual(persisted.models, body.enabled)

    // re-enabling the same model keeps its place instead of moving to the end
    const again = await postJson(`${base}/api/settings/enabled`, {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1',
    })
    assert.deepEqual((await again.json()).enabled, body.enabled)

    const removed = await fetch(`${base}/api/settings/enabled`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' }),
    })
    const removedBody = await removed.json()
    assert.deepEqual(removedBody.enabled, [
      { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
    ])
    assert.equal(removedBody.model, 'gpt-4.1-mini', 'removing should not touch the active model')

    const emptied = await fetch(`${base}/api/settings/enabled`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' }),
    })
    assert.deepEqual((await emptied.json()).enabled, [])

    const badEntry = await postJson(`${base}/api/settings/enabled`, { provider: 'nope', model: 'x', baseUrl: 'https://x.dev/v1' })
    assert.equal(badEntry.status, 400)

    const badRemove = await fetch(`${base}/api/settings/enabled`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://x.dev/v1' }),
    })
    assert.equal(badRemove.status, 400)
  })
})

test('enabled models carry context window, max output tokens and input modalities', async () => {
  await withServer(async (base, cwd) => {
    const enabled = await postJson(`${base}/api/settings/enabled`, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1',
      contextWindow: 1047576,
      maxOutputTokens: 32768,
      input: ['text', 'image', 'audio'],
    })
    assert.equal(enabled.status, 200)
    assert.deepEqual((await enabled.json()).enabled, [
      {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
        contextWindow: 1047576,
        maxOutputTokens: 32768,
        input: ['text', 'image'],
      },
    ])

    // re-enabling merges defined fields and keeps the rest
    const merged = await postJson(`${base}/api/settings/enabled`, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1',
      maxOutputTokens: 16384,
    })
    assert.deepEqual((await merged.json()).enabled, [
      {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
        contextWindow: 1047576,
        maxOutputTokens: 16384,
        input: ['text', 'image'],
      },
    ])

    // invalid option values are dropped, not persisted
    const invalid = await postJson(`${base}/api/settings/enabled`, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      contextWindow: -5,
      maxOutputTokens: 'lots',
      input: 'text',
    })
    assert.deepEqual((await invalid.json()).enabled[1], {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
    })

    const persisted = JSON.parse(readFileSync(join(cwd, '.agent/settings.json'), 'utf8'))
    assert.deepEqual(persisted.models[0], {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1',
      contextWindow: 1047576,
      maxOutputTokens: 16384,
      input: ['text', 'image'],
    })
  })
})

test('switching the model applies to every existing and future session', async () => {
  await withServer(async (base, cwd, agent) => {
    const first = await (await postJson(`${base}/api/sessions`, {})).json()
    const second = await (await postJson(`${base}/api/sessions`, {})).json()
    await fetch(`${base}/api/sessions/${first.id}`)
    const firstState = agent.sessions.get(first.id)
    assert.ok(firstState !== undefined)
    const runtimeBefore = firstState.runtime

    const response = await postSettings(base, {
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/',
      apiKey: 'sk-global',
    })
    assert.equal(response.status, 200)
    const saved = await response.json()
    assert.equal(saved.provider, 'deepseek')
    assert.equal(saved.model, 'deepseek-chat')
    assert.equal(saved.baseUrl, 'https://api.deepseek.com')
    assert.equal(saved.hasKey, true)

    assert.notEqual(firstState.runtime, runtimeBefore, 'idle sessions should pick up the new model now')
    for (const id of [first.id, second.id]) {
      const session = await (await fetch(`${base}/api/sessions/${id}`)).json()
      assert.equal(session.config.provider, 'deepseek')
      assert.equal(session.config.model, 'deepseek-chat')
      assert.equal(session.config.baseUrl, 'https://api.deepseek.com')
    }

    const later = await (await postJson(`${base}/api/sessions`, {})).json()
    const inherited = await (await fetch(`${base}/api/sessions/${later.id}`)).json()
    assert.equal(inherited.config.model, 'deepseek-chat')

    const keys = JSON.parse(readFileSync(join(cwd, '.agent/keys.json'), 'utf8'))
    assert.deepEqual(keys, { 'https://api.deepseek.com': 'sk-global' })
  })
})

test('model refresh reads the vendor /models endpoint', async () => {
  await withModelServer(async (vendor) => {
    await withServer(async (base) => {
      const ok = await postJson(`${base}/api/settings/models`, { baseUrl: `${vendor}/v1`, apiKey: 'sk-x' })
      assert.equal(ok.status, 200)
      assert.deepEqual((await ok.json()).models, ['model-a', 'model-b'])

      const locked = await postJson(`${base}/api/settings/models`, { baseUrl: `${vendor}/locked/v1` })
      assert.equal(locked.status, 502)
      assert.match((await locked.json()).error, /HTTP 401/)

      const badScheme = await postJson(`${base}/api/settings/models`, { baseUrl: 'file:///etc' })
      assert.equal(badScheme.status, 400)

      const missing = await postJson(`${base}/api/settings/models`, { baseUrl: '   ' })
      assert.equal(missing.status, 400)
    })
  })
})

test('rejects unknown providers and empty base urls without writing', async () => {
  await withServer(async (base, cwd) => {
    const unknown = await postSettings(base, { provider: 'nope', model: 'x', baseUrl: 'https://x.dev/v1' })
    assert.equal(unknown.status, 400)

    const empty = await postSettings(base, { provider: 'openai', model: 'x', baseUrl: '' })
    assert.equal(empty.status, 400)

    const missingModel = await postSettings(base, { provider: 'openai', model: '  ', baseUrl: 'https://x.dev/v1' })
    assert.equal(missingModel.status, 400)

    assert.equal(existsSync(join(cwd, '.agent/settings.json')), false)
  })
})
