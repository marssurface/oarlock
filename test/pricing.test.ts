import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { Agent } from '../src/core/agent.ts'
import { autoApproval } from '../src/core/approval.ts'
import { ContextManager } from '../src/core/context.ts'
import { costOf, formatCost, parsePricing, pricingResolver } from '../src/core/pricing.ts'
import type { ModelPricing } from '../src/core/pricing.ts'
import { resolveConfig, enableModel, readEnabledModels } from '../src/config.ts'
import { summarizeTrace } from '../src/session/store.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { createAgentServer } from '../src/web/server.ts'
import { collect, scripted, tempDir, text } from './helpers.ts'

test('costOf bills uncached input, cached input and completion separately', () => {
  const pricing: ModelPricing = { input: 2, output: 8, cached: 0.5, currency: 'USD' }
  const cost = costOf(
    { promptTokens: 1_200_000, completionTokens: 100_000, totalTokens: 1_300_000, cachedTokens: 200_000, reasoningTokens: 40_000 },
    pricing,
  )
  assert.ok(cost !== undefined)
  assert.equal(cost.currency, 'USD')
  // 1M uncached * $2 + 0.2M cached * $0.5 + 0.1M output * $8; reasoning sits inside completion already.
  assert.ok(Math.abs(cost.amount - 2.9) < 1e-9, `unexpected amount: ${cost.amount}`)
})

test('costOf falls back to the input rate when no cached price is set', () => {
  const cost = costOf(
    { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 400_000 },
    { input: 3, output: 9, currency: 'CNY' },
  )
  assert.ok(cost !== undefined)
  assert.equal(cost.amount, 3)
  assert.equal(cost.currency, 'CNY')
})

test('unpriced models and missing usage yield no cost', () => {
  assert.equal(costOf({ promptTokens: 10, completionTokens: 2, totalTokens: 12 }, undefined), undefined)
  const cost = costOf({}, { input: 1, output: 1, currency: 'USD' })
  assert.deepEqual(cost, { amount: 0, currency: 'USD' })
})

test('parsePricing validates the block and defaults the currency to USD', () => {
  assert.deepEqual(parsePricing({ input: 2, output: 8, cached: 0.5, currency: 'CNY' }), {
    input: 2,
    output: 8,
    currency: 'CNY',
    cached: 0.5,
  })
  assert.deepEqual(parsePricing({ input: 2, output: 8 }), { input: 2, output: 8, currency: 'USD' })
  assert.deepEqual(parsePricing({ input: 0, output: 0, currency: 'EUR' }), { input: 0, output: 0, currency: 'USD' })
  for (const bad of [undefined, null, 'x', [], { input: 2 }, { input: -1, output: 2 }, { input: '2', output: 8 }, { input: 2, output: 8, cached: -1 }]) {
    const parsed = parsePricing(bad)
    if (bad !== null && typeof bad === 'object' && !Array.isArray(bad) && (bad as Record<string, unknown>)['cached'] === -1) {
      assert.deepEqual(parsed, { input: 2, output: 8, currency: 'USD' }, 'a bad cached price is ignored')
    } else {
      assert.equal(parsed, undefined, `should reject: ${JSON.stringify(bad)}`)
    }
  }
})

test('pricingResolver prefers the active endpoint when model names collide', () => {
  const local: ModelPricing = { input: 1, output: 2, currency: 'CNY' }
  const remote: ModelPricing = { input: 5, output: 10, currency: 'USD' }
  const resolve = pricingResolver(
    [
      { baseUrl: 'https://a/v1', model: 'shared', pricing: local },
      { baseUrl: 'https://b/v1', model: 'shared', pricing: remote },
      { baseUrl: 'https://b/v1', model: 'free' },
    ],
    { baseUrl: 'https://b/v1', model: 'shared' },
  )
  assert.deepEqual(resolve('shared'), remote)
  assert.equal(resolve('free'), undefined, 'models without a stored price resolve to nothing')
  assert.equal(resolve('missing'), undefined)
})

test('formatCost keeps the right precision per magnitude', () => {
  assert.equal(formatCost({ amount: 4.25, currency: 'USD' }), '$4.25')
  assert.equal(formatCost({ amount: 0.42, currency: 'CNY' }), '¥0.420')
  assert.equal(formatCost({ amount: 0.0012, currency: 'USD' }), '$0.0012')
})

test('enabled models persist unit prices and can clear them explicitly', () => {
  const cwd = tempDir()
  const pricing: ModelPricing = { input: 2, output: 8, cached: 0.5, currency: 'CNY' }
  enableModel(cwd, { provider: 'mock', baseUrl: 'http://priced.test/v1/', model: 'priced-1', pricing })
  const stored = readEnabledModels(cwd)
  assert.equal(stored[0]?.baseUrl, 'http://priced.test/v1', 'the endpoint keeps its trailing-slash-normalized form')
  assert.deepEqual(stored[0]?.pricing, pricing)

  enableModel(cwd, { provider: 'mock', baseUrl: 'http://priced.test/v1', model: 'priced-1', contextWindow: 32_000 })
  assert.deepEqual(readEnabledModels(cwd)[0]?.pricing, pricing, 'a save without a price field keeps the stored prices')

  enableModel(cwd, { provider: 'mock', baseUrl: 'http://priced.test/v1', model: 'priced-1' }, { clearPricing: true })
  assert.equal(readEnabledModels(cwd)[0]?.pricing, undefined)
  assert.equal(readEnabledModels(cwd)[0]?.contextWindow, 32_000, 'clearing prices leaves the other options alone')
})

test('the settings API stores, validates and clears pricing', async () => {
  const cwd = tempDir()
  const agent = createAgentServer(resolveConfig({ cwd, provider: 'mock', model: 'mock-1' }))
  const { server } = agent
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => done())
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/settings/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  try {
    const entry = { provider: 'mock', baseUrl: 'http://billing.test/v1', model: 'billing-1' }
    let response = await post({ ...entry, pricing: { input: 2, output: 8, cached: 0.5, currency: 'CNY' } })
    assert.equal(response.status, 200)
    let payload = (await response.json()) as { enabled: Array<{ pricing?: ModelPricing }> }
    assert.deepEqual(payload.enabled[0]?.pricing, { input: 2, output: 8, currency: 'CNY', cached: 0.5 })

    response = await post({ ...entry, pricing: { input: -2, output: 8 } })
    payload = (await response.json()) as { enabled: Array<{ pricing?: ModelPricing }> }
    assert.deepEqual(payload.enabled[0]?.pricing, { input: 2, output: 8, currency: 'CNY', cached: 0.5 }, 'invalid input is ignored')

    response = await post({ ...entry, pricing: null })
    payload = (await response.json()) as { enabled: Array<{ pricing?: ModelPricing }> }
    assert.equal(payload.enabled[0]?.pricing, undefined, 'pricing: null clears the stored prices')
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
})

test('the usage event carries the cost snapshot for the request model', async () => {
  const provider = scripted(() => [
    {
      type: 'usage',
      usage: { promptTokens: 1_200_000, completionTokens: 100_000, totalTokens: 1_300_000, cachedTokens: 200_000 },
    },
    ...text('done'),
  ])
  const pricing = { input: 2, output: 8, cached: 0.5, currency: 'USD' as const }
  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: ToolRegistry.default({ allowShell: false, includeTask: false }),
    context: new ContextManager({ window: 200_000 }),
    pricing: (model) => (model === 'mock-1' ? pricing : undefined),
  })
  const events = await collect(agent.run('hi'))
  const usage = events.find((event) => event.type === 'usage')
  assert.ok(usage?.type === 'usage')
  assert.ok(Math.abs((usage.cost?.amount ?? -1) - 2.9) < 1e-9, `unexpected cost: ${JSON.stringify(usage.cost)}`)
  assert.equal(usage.cost?.currency, 'USD')

  const unpriced = await collect(
    new Agent({ provider: scripted(() => text('ok')), cwd: tempDir(), approval: autoApproval(), tools: ToolRegistry.default({ allowShell: false, includeTask: false }) }).run('hi'),
  )
  const plain = unpriced.find((event) => event.type === 'usage')
  assert.equal(plain?.type === 'usage' ? plain.cost : 'missing', undefined, 'no pricing means no cost field')
})

test('summarizeTrace aggregates costs per currency', () => {
  const records = [
    { at: 1, event: { type: 'usage', step: 1, purpose: 'turn', model: 'a', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, cost: { amount: 0.5, currency: 'USD' } } },
    { at: 2, event: { type: 'usage', step: 2, purpose: 'turn', model: 'b', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, cost: { amount: 2, currency: 'CNY' } } },
    { at: 3, event: { type: 'usage', step: 3, purpose: 'turn', model: 'c', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { amount: 0.25, currency: 'USD' } } },
    { at: 4, event: { type: 'usage', step: 4, purpose: 'turn', model: 'd', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } },
  ] as Parameters<typeof summarizeTrace>[0]
  const summary = summarizeTrace(records)
  assert.equal(summary.requests, 4)
  assert.equal(summary.totalTokens, 169)
  const costs = new Map(summary.costs?.map((cost) => [cost.currency, cost.amount]))
  assert.equal(costs.get('USD'), 0.75)
  assert.equal(costs.get('CNY'), 2)

  assert.equal(summarizeTrace([]).costs, undefined, 'a trace without costs omits the field entirely')
})
