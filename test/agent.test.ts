import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Agent } from '../src/core/agent.ts'
import { autoApproval, denyApproval, promptApproval, ruleApproval } from '../src/core/approval.ts'
import { describeToolChange } from '../src/core/diff.ts'
import { ProviderError } from '../src/providers/types.ts'
import { textOf } from '../src/providers/content.ts'
import type { ChatProvider } from '../src/providers/types.ts'
import { promptAsk } from '../src/core/ask.ts'
import { ContextManager } from '../src/core/context.ts'
import type { AgentEvent } from '../src/core/events.ts'
import type { ToolDefinition } from '../src/tools/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { taskTool } from '../src/tools/task.ts'
import { todoTool } from '../src/tools/todo.ts'
import { call, done } from '../bench/tasks/shared.ts'
import { collect, scripted, tempDir, text } from './helpers.ts'

const noTaskNoShell = () => ToolRegistry.default({ allowShell: false, includeTask: false })

test('runs a tool loop, writes the file and stops on a final answer', async () => {
  const dir = tempDir()
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('done')
    return [
      { type: 'text-delta', text: 'writing the note\n' },
      {
        type: 'tool-call',
        call: { id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'hello world' }) },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })

  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: noTaskNoShell(),
    context: new ContextManager({ window: 200_000 }),
  })

  const events = await collect(agent.run('write the note'))
  assert.equal(readFileSync(join(dir, 'note.txt'), 'utf8'), 'hello world')
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'turn-start',
      'step-start',
      'text-delta',
      'usage',
      'assistant',
      'tool-call',
      'tool-result',
      'step-start',
      'text-delta',
      'usage',
      'assistant',
      'turn-end',
    ],
  )
  const toolResult = events.find((event) => event.type === 'tool-result')
  assert.equal(toolResult?.type === 'tool-result' ? toolResult.isError : true, false)
  assert.equal(agent.history().length, 4)
})

test('reports an unknown tool instead of crashing', async () => {
  const dir = tempDir()
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('recovered')
    return [
      { type: 'tool-call', call: { id: 'call-1', name: 'nope', arguments: '{}' } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({ provider, cwd: dir, approval: autoApproval(), tools: noTaskNoShell() })
  const events = await collect(agent.run('try'))
  const result = events.find((event) => event.type === 'tool-result')
  assert.equal(result?.type === 'tool-result' ? result.isError : false, true)
  assert.match(result?.type === 'tool-result' ? result.content : '', /unknown tool/)
  assert.equal(events.at(-1)?.type, 'turn-end')
})

test('runs consecutive read-only tools concurrently and keeps call order', async () => {
  const dir = tempDir()
  const order: string[] = []
  let active = 0
  let peak = 0
  const slow = (name: string, delay: number): ToolDefinition => ({
    name,
    description: `${name} waits before answering`,
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'read',
    async execute() {
      order.push(`start:${name}`)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, delay))
      active -= 1
      order.push(`end:${name}`)
      return { content: `${name} done` }
    },
  })

  const tools = new ToolRegistry([slow('slow_a', 80), slow('slow_b', 5)])
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('done')
    return [
      { type: 'tool-call', call: { id: 'a', name: 'slow_a', arguments: '{}' } },
      { type: 'tool-call', call: { id: 'b', name: 'slow_b', arguments: '{}' } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({ provider, cwd: dir, approval: autoApproval(), tools })
  const events = await collect(agent.run('go'))

  assert.equal(peak, 2, 'both reads should be in flight together')
  assert.ok(
    order.indexOf('start:slow_b') < order.indexOf('end:slow_a'),
    'the fast call should start before the slow one finishes',
  )

  const calls = events.flatMap((event) => (event.type === 'tool-call' ? [event.id] : []))
  const results = events.flatMap((event) => (event.type === 'tool-result' ? [event.id] : []))
  assert.deepEqual(calls, ['a', 'b'])
  assert.deepEqual(results, ['a', 'b'], 'results keep the model call order, not completion order')

  const toolMessages = agent
    .history()
    .flatMap((message) => (message.role === 'tool' ? [message.toolName] : []))
  assert.deepEqual(toolMessages, ['slow_a', 'slow_b'])
})

test('todo_write publishes the plan, replaces it on update and keeps state on invalid input', async () => {
  const dir = tempDir()
  const first = [
    { id: 'scan', content: '读代码', status: 'completed' },
    { id: 'impl', content: '改实现', status: 'in_progress' },
    { id: 'test', content: '补测试', status: 'pending' },
  ]
  const second = [
    { id: 'scan', content: '读代码', status: 'completed' },
    { id: 'impl', content: '改实现', status: 'completed' },
    { id: 'test', content: '补测试', status: 'in_progress' },
  ]
  const provider = scripted((request) => {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) return [call('t1', 'todo_write', { todos: first }), done('tool_calls')]
    if (results === 1) return [call('t2', 'todo_write', { todos: second }), done('tool_calls')]
    if (results === 2) return [call('t3', 'todo_write', { todos: 'not-an-array' }), done('tool_calls')]
    return text('done')
  })
  const agent = new Agent({ provider, cwd: dir, approval: autoApproval(), tools: noTaskNoShell() })
  assert.deepEqual(agent.plan(), [])
  const events = await collect(agent.run('plan the work'))

  const todoEvents = events.filter((event) => event.type === 'todo')
  assert.equal(todoEvents.length, 2, 'invalid updates must not publish a plan event')
  assert.deepEqual(todoEvents[0]?.type === 'todo' ? todoEvents[0].todos : null, first)
  assert.deepEqual(todoEvents[1]?.type === 'todo' ? todoEvents[1].todos : null, second)
  assert.deepEqual(agent.plan(), second, 'the full list replaces the previous plan')

  const results = events.filter((event) => event.type === 'tool-result' && event.name === 'todo_write')
  assert.equal(results.length, 3)
  assert.match(results[0]?.type === 'tool-result' ? results[0].content : '', /Current plan \(1\/3 done\):/)
  assert.match(results[0]?.type === 'tool-result' ? results[0].content : '', /\[~\] impl: 改实现/)
  assert.equal(results[2]?.type === 'tool-result' ? results[2].isError : false, true)
  assert.match(results[2]?.type === 'tool-result' ? results[2].content : '', /todos must be an array/)

  const stored = agent.history().filter((message) => message.role === 'tool' && message.toolName === 'todo_write')
  assert.equal(stored.length, 3)
})

test('todo_write stays serial between read-only batches', async () => {
  const dir = tempDir()
  const order: string[] = []
  let active = 0
  let peak = 0
  const slow = (name: string): ToolDefinition => ({
    name,
    description: `${name} waits before answering`,
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'read',
    async execute() {
      order.push(`start:${name}`)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      order.push(`end:${name}`)
      return { content: `${name} done` }
    },
  })
  const tools = new ToolRegistry([slow('read_a'), todoTool, slow('read_b')])
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('done')
    return [
      call('a', 'read_a', {}),
      call('t', 'todo_write', { todos: [{ content: '中间计划', status: 'in_progress' }] }),
      call('b', 'read_b', {}),
      done('tool_calls'),
    ]
  })
  const agent = new Agent({ provider, cwd: dir, approval: autoApproval(), tools })
  const events = await collect(agent.run('go'))

  assert.equal(peak, 1, 'todo_write must not overlap the reads around it')
  assert.deepEqual(order, ['start:read_a', 'end:read_a', 'start:read_b', 'end:read_b'])
  const results = events.flatMap((event) => (event.type === 'tool-result' ? [event.id] : []))
  assert.deepEqual(results, ['a', 't', 'b'])
  assert.deepEqual(agent.plan(), [{ id: 't1', content: '中间计划', status: 'in_progress' }])
})

test('deny policy blocks writes and leaves the disk untouched', async () => {
  const dir = tempDir()
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('ok')
    return [
      {
        type: 'tool-call',
        call: { id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'nope' }) },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({ provider, cwd: dir, approval: denyApproval(), tools: noTaskNoShell() })
  const events = await collect(agent.run('write'))
  assert.equal(existsSync(join(dir, 'x.txt')), false)
  const result = events.find((event) => event.type === 'tool-result')
  assert.equal(result?.type === 'tool-result' ? result.isError : false, true)
  assert.match(result?.type === 'tool-result' ? result.content : '', /denied by policy/)
})

test('ask mode emits approval events and honours the decision', async () => {
  const dir = tempDir()
  const seen: string[] = []
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('ok')
    return [
      {
        type: 'tool-call',
        call: { id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: 'y.txt', content: 'yes' }) },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({
    provider,
    cwd: dir,
    tools: noTaskNoShell(),
    approval: promptApproval(async (request) => {
      seen.push(request.summary)
      return 'allow'
    }),
  })
  const events = await collect(agent.run('write'))
  assert.deepEqual(seen, ['write_file: y.txt'])
  assert.equal(readFileSync(join(dir, 'y.txt'), 'utf8'), 'yes')
  const request = events.find((event) => event.type === 'approval-request')
  const decision = events.find((event) => event.type === 'approval-decision')
  assert.equal(request?.type === 'approval-request' ? request.tool : '', 'write_file')
  assert.equal(decision?.type === 'approval-decision' ? decision.allowed : false, true)
})

test('always-allow remembers the rule and skips the next matching approval', async () => {
  const dir = tempDir()
  let prompts = 0
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('ok')
    return [
      { type: 'tool-call', call: { id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'a' }) } },
      { type: 'tool-call', call: { id: 'call-2', name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'b' }) } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({
    provider,
    cwd: dir,
    tools: noTaskNoShell(),
    approval: ruleApproval(async () => {
      prompts += 1
      return 'always'
    }),
  })
  const events = await collect(agent.run('write both'))
  assert.equal(prompts, 1, 'the second call must not prompt again')
  assert.equal(events.filter((event) => event.type === 'approval-request').length, 1)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'a')
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'b')
  const decision = events.find((event) => event.type === 'approval-decision')
  assert.equal(decision?.type === 'approval-decision' ? decision.remembered : false, true)
})

test('approval detail previews writes and edits as a diff', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'note.txt'), 'one\ntwo\nthree\n', 'utf8')

  const created = await describeToolChange('write_file', { path: 'new.txt', content: 'hello\n' }, dir)
  assert.match(created ?? '', /--- \/dev\/null/)
  assert.match(created ?? '', /\+hello/)

  const edited = await describeToolChange(
    'edit_file',
    { path: 'note.txt', old_string: 'two', new_string: 'TWO' },
    dir,
  )
  assert.match(edited ?? '', /--- a\/note\.txt/)
  assert.match(edited ?? '', /-two/)
  assert.match(edited ?? '', /\+TWO/)
})

test('approval diff previews whitespace-tolerant edits accurately', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'fmt.ts'), 'function f() {\n    return 1\n}\n')

  const preview = await describeToolChange(
    'edit_file',
    { path: 'fmt.ts', old_string: 'function f() {\n  return 1\n}', new_string: 'function f() {\n  return 2\n}' },
    dir,
  )
  assert.match(preview ?? '', /-    return 1/, 'the preview shows the real file line')
  assert.match(preview ?? '', /\+    return 2/, 'new_string is shifted to the file indentation')
  assert.match(preview ?? '', /whitespace-tolerant match/)
})

test('a context-length error forces one compaction and retries the step', async () => {
  const dir = tempDir()
  let turnCalls = 0
  const provider: ChatProvider = {
    id: 'overflow',
    model: 'overflow-1',
    async *stream(request) {
      if (textOf(request.messages[0]?.content ?? '').includes('compress an agent conversation')) {
        yield { type: 'text-delta', text: 'summary of earlier work' }
        yield { type: 'done', finishReason: 'stop' }
        return
      }
      turnCalls += 1
      if (turnCalls === 1) {
        throw new ProviderError('overflow: HTTP 400', {
          status: 400,
          body: '{"error":{"message":"maximum context length is 4096 tokens"}}',
        })
      }
      yield { type: 'text-delta', text: 'worked' }
      yield { type: 'done', finishReason: 'stop' }
    },
  }
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: noTaskNoShell(),
    context: new ContextManager({ window: 200_000 }),
  })
  agent.setHistory([
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'four' },
    { role: 'assistant', content: 'a4' },
  ])

  const events = await collect(agent.run('go on'))
  assert.equal(turnCalls, 2, 'the step must be retried once after compaction')
  assert.ok(events.some((event) => event.type === 'compaction'))
  const end = events.at(-1)
  assert.equal(end?.type, 'turn-end')
  assert.equal(end?.type === 'turn-end' ? end.text : '', 'worked')
})

test('stops after the step budget', async () => {
  const dir = tempDir()
  const provider = scripted(() => [
    { type: 'tool-call', call: { id: 'call-x', name: 'list_files', arguments: '{}' } },
    { type: 'done', finishReason: 'tool_calls' },
  ])
  const agent = new Agent({ provider, cwd: dir, approval: autoApproval(), tools: noTaskNoShell(), maxSteps: 2 })
  const events = await collect(agent.run('loop'))
  const last = events.at(-1)
  assert.equal(last?.type, 'error')
  assert.match(last?.type === 'error' ? last.message : '', /stopped after 2 steps/)
})

test('a token budget ends the turn gracefully with status budget', async () => {
  const dir = tempDir()
  const provider = scripted(() => [
    { type: 'text-delta', text: 'working' },
    call('c', 'list_files', {}),
    { type: 'usage', usage: { promptTokens: 60, completionTokens: 40, totalTokens: 100 } },
    done('tool_calls'),
  ])
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: noTaskNoShell(),
    maxTurnTokens: 150,
  })
  const events = await collect(agent.run('loop'))
  const end = events.at(-1)
  assert.equal(end?.type, 'turn-end')
  assert.equal(end?.type === 'turn-end' ? end.status : '', 'budget')
  assert.equal(end?.type === 'turn-end' ? end.steps : 0, 2, 'two requests run before the 150-token budget is spent')
  assert.equal(end?.type === 'turn-end' ? end.usage.totalTokens : 0, 200)
  assert.equal(end?.type === 'turn-end' ? end.text : '', 'working', 'the last assistant text is kept')
  assert.ok(!events.some((event) => event.type === 'error'), 'a budget stop is not an error')
})

test('a time budget ends the turn after the current step finishes', async () => {
  const dir = tempDir()
  const slow: ToolDefinition = {
    name: 'slow',
    description: 'takes longer than the turn budget',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { content: 'done' }
    },
  }
  const provider = scripted(() => [call('c', 'slow', {}), done('tool_calls')])
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: new ToolRegistry([slow]),
    maxTurnMs: 10,
  })
  const events = await collect(agent.run('loop'))
  const end = events.at(-1)
  assert.equal(end?.type, 'turn-end')
  assert.equal(end?.type === 'turn-end' ? end.status : '', 'budget')
  assert.equal(end?.type === 'turn-end' ? end.steps : 0, 1, 'the first step completes before the clock is checked')
  assert.ok(!events.some((event) => event.type === 'error'))
})

test('delegates to a subagent and returns its report', async () => {
  const dir = tempDir()
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    if (system.includes('subagent')) return text('child report')
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('parent finished')
    return [
      {
        type: 'tool-call',
        call: {
          id: 'call-task',
          name: 'task',
          arguments: JSON.stringify({ description: 'look around', prompt: 'find the answer' }),
        },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })

  const events: AgentEvent[] = []
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: ToolRegistry.default({ allowShell: false }),
    maxDepth: 1,
    onEvent: (event) => events.push(event),
  })

  for await (const _event of agent.run('delegate')) {
    // driven by onEvent
  }
  const taskResult = events.find((event) => event.type === 'tool-result' && event.name === 'task')
  assert.equal(taskResult?.type === 'tool-result' ? taskResult.content : '', 'child report')

  const start = events.find((event) => event.type === 'subagent-start')
  const finish = events.find((event) => event.type === 'subagent-end')
  assert.equal(start?.type === 'subagent-start' ? start.description : '', 'look around')
  assert.equal(finish?.type === 'subagent-end' ? finish.ok : false, true)

  const end = events.find((event) => event.type === 'turn-end')
  assert.equal(end?.type === 'turn-end' ? end.text : '', 'parent finished')
})

test('a hung tool is timed out and the turn continues', async () => {
  const slow: ToolDefinition = {
    name: 'slow',
    description: 'waits far longer than the agent allows',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
    async execute() {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000)
        timer.unref()
      })
      return { content: 'too late' }
    },
  }

  const provider = scripted((request) => {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) return [call('c1', 'slow', {}), done('tool_calls')]
    return text('gave up waiting')
  })

  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: new ToolRegistry([slow]),
    maxToolTimeoutMs: 50,
  })
  const events = await collect(agent.run('go'))
  const result = events.find((event) => event.type === 'tool-result')
  assert.equal(result?.type === 'tool-result' ? result.isError : false, true)
  assert.match(result?.type === 'tool-result' ? result.content : '', /timed out/)
  assert.equal(events.at(-1)?.type, 'turn-end')
})

test('oversized tool output is truncated before it enters the conversation', async () => {
  const big: ToolDefinition = {
    name: 'big',
    description: 'returns a lot of text',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: 'x'.repeat(100_000) }
    },
  }

  const provider = scripted((request) => {
    const results = request.messages.filter((message) => message.role === 'tool').length
    if (results === 0) return [call('c1', 'big', {}), done('tool_calls')]
    return text('ok')
  })

  const agent = new Agent({ provider, cwd: tempDir(), approval: autoApproval(), tools: new ToolRegistry([big]) })
  const events = await collect(agent.run('go'))
  const result = events.find((event) => event.type === 'tool-result')
  assert.ok((result?.type === 'tool-result' ? result.content.length : 0) < 40_000)
  assert.match(result?.type === 'tool-result' ? result.content : '', /tool output truncated/)

  const stored = agent.history().find((message) => message.role === 'tool')
  assert.ok((stored?.content.length ?? 0) < 40_000, 'the stored tool message must be truncated too')
})

test('records per-request usage, timing and model on the event stream', async () => {
  const provider = scripted(() => [
    { type: 'text-delta', text: 'hello' },
    {
      type: 'usage',
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15, cachedTokens: 5, reasoningTokens: 1 },
    },
    { type: 'done', finishReason: 'stop' },
  ])
  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: noTaskNoShell(),
    context: new ContextManager({ window: 200_000 }),
  })
  const events = await collect(agent.run('hi'))

  const usage = events.find((event) => event.type === 'usage')
  assert.equal(usage?.type === 'usage' ? usage.usage.totalTokens : 0, 15)
  assert.equal(usage?.type === 'usage' ? usage.usage.cachedTokens : 0, 5)
  assert.equal(usage?.type === 'usage' ? usage.purpose : '', 'turn')
  assert.equal(usage?.type === 'usage' ? usage.step : 0, 1)
  assert.equal(usage?.type === 'usage' ? usage.model : '', 'mock-1')
  assert.equal(usage?.type === 'usage' ? usage.depth : 99, 0)
  assert.ok((usage?.type === 'usage' ? usage.durationMs ?? -1 : -1) >= 0)
  assert.equal(usage?.type === 'usage' ? usage.attempts : 0, 1)

  const assistant = events.find((event) => event.type === 'assistant')
  assert.equal(assistant?.type === 'assistant' ? assistant.usage?.totalTokens : 0, 15)
  assert.ok((assistant?.type === 'assistant' ? assistant.ttftMs ?? -1 : -1) >= 0)
  const end = events.at(-1)
  assert.equal(end?.type === 'turn-end' ? end.usage.totalTokens : 0, 15)
  assert.equal(end?.type === 'turn-end' ? end.status : '', 'ok')
})

test('estimates usage when the provider reports none', async () => {
  const provider = scripted(() => text('done'))
  const agent = new Agent({ provider, cwd: tempDir(), approval: autoApproval(), tools: noTaskNoShell() })
  const events = await collect(agent.run('hi'))

  const usage = events.find((event) => event.type === 'usage')
  assert.ok(usage?.type === 'usage' && usage.usage.estimated === true, 'usage should be flagged as estimated')
  assert.ok((usage?.type === 'usage' ? usage.usage.promptTokens ?? 0 : 0) > 0, 'prompt tokens should be estimated')
  assert.ok((usage?.type === 'usage' ? usage.usage.completionTokens ?? 0 : 0) > 0, 'output tokens should be estimated')
  const end = events.at(-1)
  assert.equal(end?.type === 'turn-end' ? end.usage.estimated : false, true)
})

test('subagent usage is bubbled up and folded into the parent turn total', async () => {
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    if (system.includes('subagent')) {
      return [
        { type: 'text-delta', text: 'child report' },
        { type: 'usage', usage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 } },
        { type: 'done', finishReason: 'stop' },
      ]
    }
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') {
      return [
        { type: 'text-delta', text: 'parent finished' },
        { type: 'usage', usage: { promptTokens: 21, completionTokens: 6, totalTokens: 27 } },
        { type: 'done', finishReason: 'stop' },
      ]
    }
    return [
      { type: 'tool-call', call: { id: 'task-1', name: 'task', arguments: JSON.stringify({ description: 'look', prompt: 'find' }) } },
      { type: 'usage', usage: { promptTokens: 9, completionTokens: 2, totalTokens: 11 } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })

  const seen: AgentEvent[] = []
  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: ToolRegistry.default({ allowShell: false }),
    maxDepth: 1,
    onEvent: (event) => seen.push(event),
  })
  for await (const _event of agent.run('delegate')) {
    // events arrive through onEvent
  }

  const usageEvents = seen.filter((event) => event.type === 'usage')
  assert.deepEqual(
    usageEvents.map((event) => (event.type === 'usage' ? event.depth : -1)),
    [0, 1, 0],
  )
  assert.equal(
    usageEvents.reduce((sum, event) => sum + (event.type === 'usage' ? event.usage.totalTokens ?? 0 : 0), 0),
    53,
  )

  const childAssistant = seen.find(
    (event) => event.type === 'assistant' && event.depth === 1,
  )
  assert.equal(childAssistant?.type === 'assistant' ? childAssistant.usage?.totalTokens : 0, 15)

  const end = seen.find((event) => event.type === 'turn-end')
  assert.equal(end?.type === 'turn-end' ? end.usage.totalTokens : 0, 53, 'turn total must include the child usage')
})

test('the explore preset gives the child a read-only tool allowlist', async () => {
  const childRequests: { tools: string[]; system: string }[] = []
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    if (system.includes('subagent')) {
      childRequests.push({ tools: (request.tools ?? []).map((spec) => spec.name), system })
      return text('child done')
    }
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('parent finished')
    return [
      { type: 'tool-call', call: { id: 't1', name: 'task', arguments: JSON.stringify({ description: 'scan', prompt: 'find x', agent: 'explore' }) } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })

  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: ToolRegistry.default(),
    maxDepth: 1,
  })
  for await (const _event of agent.run('go')) {
    // driven by the provider
  }

  assert.equal(childRequests.length, 1)
  const child = childRequests[0]!
  assert.deepEqual(child.tools.slice().sort(), ['glob_files', 'grep_files', 'list_files', 'read_file'])
  assert.ok(child.system.includes('read-only subagent'), 'explore persona must be applied')
})

test('a child can never gain a tool its parent lacks', async () => {
  const childTools: string[][] = []
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    if (system.includes('subagent')) {
      childTools.push((request.tools ?? []).map((spec) => spec.name))
      return text('child done')
    }
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('parent finished')
    return [
      { type: 'tool-call', call: { id: 't1', name: 'task', arguments: JSON.stringify({ description: 'x', prompt: 'y', tools: ['bash', 'read_file'] }) } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })

  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: ToolRegistry.default({ allowShell: false }),
    maxDepth: 1,
  })
  for await (const _event of agent.run('go')) {
    // driven by the provider
  }

  assert.equal(childTools.length, 1)
  assert.ok(!childTools[0]!.includes('bash'), 'bash must not leak into a shell-less parent')
  assert.ok(childTools[0]!.includes('read_file'))
})

test('a model override reaches the child request and its event labels', async () => {
  const childModels: (string | undefined)[] = []
  const seen: AgentEvent[] = []
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    if (system.includes('subagent')) {
      childModels.push(request.model)
      return text('child done')
    }
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('parent finished')
    return [
      { type: 'tool-call', call: { id: 't1', name: 'task', arguments: JSON.stringify({ description: 'x', prompt: 'y', model: 'tiny-cheap' }) } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })

  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: ToolRegistry.default(),
    maxDepth: 1,
    onEvent: (event) => seen.push(event),
  })
  for await (const _event of agent.run('go')) {
    // events arrive through onEvent
  }

  assert.deepEqual(childModels, ['tiny-cheap'])
  const childAssistant = seen.find((event) => event.type === 'assistant' && event.depth === 1)
  assert.equal(childAssistant?.type === 'assistant' ? childAssistant.model : undefined, 'tiny-cheap')
  const parentAssistant = seen.find((event) => event.type === 'assistant' && event.depth === 0)
  assert.equal(parentAssistant?.type === 'assistant' ? parentAssistant.model : undefined, 'mock-1')
})

test('an unknown agent preset surfaces as a task tool error', async () => {
  const seen: AgentEvent[] = []
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('handled')
    return [
      { type: 'tool-call', call: { id: 't1', name: 'task', arguments: JSON.stringify({ description: 'x', prompt: 'y', agent: 'nope' }) } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })

  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: ToolRegistry.default(),
    maxDepth: 1,
    onEvent: (event) => seen.push(event),
  })
  for await (const _event of agent.run('go')) {
    // events arrive through onEvent
  }

  const taskResult = seen.find((event) => event.type === 'tool-result' && event.name === 'task')
  assert.equal(taskResult?.type === 'tool-result' ? taskResult.isError : false, true)
  assert.match(taskResult?.type === 'tool-result' ? taskResult.content : '', /unknown agent preset: nope/)
})

test('several delegations in one step run at once and report in call order', async () => {
  const dir = tempDir()
  const timeline: string[] = []
  let active = 0
  let peak = 0
  const delayed = (name: string, delay: number): ToolDefinition => ({
    name,
    description: `${name} waits before answering`,
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'read',
    async execute() {
      timeline.push(`start:${name}`)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, delay))
      active -= 1
      timeline.push(`end:${name}`)
      return { content: `${name} done` }
    },
  })
  const tools = new ToolRegistry([delayed('slow_a', 60), delayed('fast_b', 5), taskTool])
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    const usedTool = request.messages[request.messages.length - 1]?.role === 'tool'
    if (system.includes('Task: first')) return usedTool ? text('report first') : [call('a1', 'slow_a', {}), done('tool_calls')]
    if (system.includes('Task: second')) return usedTool ? text('report second') : [call('b1', 'fast_b', {}), done('tool_calls')]
    if (usedTool) return text('parent finished')
    return [
      call('t1', 'task', { description: 'first', prompt: 'read a' }),
      call('t2', 'task', { description: 'second', prompt: 'read b' }),
      done('tool_calls'),
    ]
  })

  const live: AgentEvent[] = []
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools,
    maxDepth: 1,
    onEvent: (event) => live.push(event),
  })
  const events = await collect(agent.run('delegate twice'))

  assert.equal(peak, 2, 'both delegations should be in flight together')
  assert.ok(
    timeline.indexOf('start:fast_b') < timeline.indexOf('end:slow_a'),
    'the fast child starts working while the slow one is still running',
  )

  // The renderer channel gets one contiguous block per delegation, in call order:
  // the quick child's activity waits for the slow one it ran beside.
  const nested = live
    .filter((event) => (event.depth ?? 0) > 0)
    .flatMap((event) => (event.type === 'tool-call' || event.type === 'tool-result' ? [`${event.type}:${event.id}`] : []))
  assert.deepEqual(nested, ['tool-call:a1', 'tool-result:a1', 'tool-call:b1', 'tool-result:b1'])

  const starts = live.flatMap((event) => (event.type === 'subagent-start' ? [event.id] : []))
  const ends = live.flatMap((event) => (event.type === 'subagent-end' ? [event.id] : []))
  assert.deepEqual(starts, ['t1', 't2'], 'delegation blocks open in call order')
  assert.deepEqual(ends, ['t1', 't2'])

  const opens = live.flatMap((event) => (event.type === 'tool-call' && event.name === 'task' ? [event.id] : []))
  assert.deepEqual(opens, ['t1', 't2'], 'both rows appear before either delegation reports')

  const results = events.flatMap((event) => (event.type === 'tool-result' && event.name === 'task' ? [event.content] : []))
  assert.deepEqual(results, ['report first', 'report second'])
  const toolMessages = agent
    .history()
    .filter((message) => message.role === 'tool')
    .map((message) => message.toolCallId)
  assert.deepEqual(toolMessages, ['t1', 't2'], 'the transcript keeps call order, not completion order')
})

test('a fan-out larger than the cap queues the extra delegations', async () => {
  let active = 0
  let peak = 0
  const wait: ToolDefinition = {
    name: 'wait',
    description: 'waits a moment before answering',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'read',
    async execute() {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
      return { content: 'waited' }
    },
  }
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    const usedTool = request.messages[request.messages.length - 1]?.role === 'tool'
    if (system.includes('subagent')) return usedTool ? text('child report') : [call('w1', 'wait', {}), done('tool_calls')]
    if (usedTool) return text('done')
    return [
      call('d1', 'task', { description: 'a', prompt: 'p' }),
      call('d2', 'task', { description: 'b', prompt: 'p' }),
      call('d3', 'task', { description: 'c', prompt: 'p' }),
      call('d4', 'task', { description: 'd', prompt: 'p' }),
      call('d5', 'task', { description: 'e', prompt: 'p' }),
      done('tool_calls'),
    ]
  })
  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: new ToolRegistry([wait, taskTool]),
    maxDepth: 1,
    maxConcurrentSubagents: 2,
  })
  await collect(agent.run('fan out five ways'))

  assert.equal(peak, 2, 'only two delegations may be in flight at once')
  assert.equal(agent.history().filter((message) => message.role === 'tool').length, 5, 'every delegation still reports')
})

test('concurrent delegations ask for permission one at a time', async () => {
  const dir = tempDir()
  let active = 0
  let peak = 0
  const gate = promptApproval(async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 15))
    active -= 1
    return 'allow'
  })
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    const usedTool = request.messages[request.messages.length - 1]?.role === 'tool'
    if (system.includes('Task: first'))
      return usedTool ? text('report first') : [call('w1', 'write_file', { path: 'first.txt', content: '1' }), done('tool_calls')]
    if (system.includes('Task: second'))
      return usedTool ? text('report second') : [call('w2', 'write_file', { path: 'second.txt', content: '2' }), done('tool_calls')]
    if (usedTool) return text('parent finished')
    return [
      call('t1', 'task', { description: 'first', prompt: 'write a file' }),
      call('t2', 'task', { description: 'second', prompt: 'write a file' }),
      done('tool_calls'),
    ]
  })
  const live: AgentEvent[] = []
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: gate,
    tools: ToolRegistry.default({ allowShell: false }),
    maxDepth: 1,
    onEvent: (event) => live.push(event),
  })
  await collect(agent.run('delegate two writes'))

  assert.equal(peak, 1, 'two children must not raise two prompts at once')
  assert.equal(readFileSync(join(dir, 'first.txt'), 'utf8'), '1')
  assert.equal(readFileSync(join(dir, 'second.txt'), 'utf8'), '2')

  const asked = live.findIndex((event) => event.type === 'approval-request')
  const reported = live.findIndex((event) => (event.depth ?? 0) > 0 && event.type === 'tool-result')
  assert.ok(asked >= 0 && asked < reported, 'a prompt reaches the user live, even when the rest of the block waits')
})

test('a lone delegation keeps streaming while it runs', async () => {
  let release!: () => void
  const hold: ToolDefinition = {
    name: 'hold',
    description: 'waits until the test lets it finish',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'read',
    async execute() {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { content: 'held' }
    },
  }
  const provider = scripted((request) => {
    const system = textOf(request.messages[0]?.content ?? '')
    const usedTool = request.messages[request.messages.length - 1]?.role === 'tool'
    if (system.includes('subagent')) return usedTool ? text('child report') : [call('h1', 'hold', {}), done('tool_calls')]
    if (usedTool) return text('parent finished')
    return [call('t1', 'task', { description: 'solo', prompt: 'hold on' }), done('tool_calls')]
  })
  const live: AgentEvent[] = []
  let closed: { at: number; ok: boolean } | undefined
  const record = (event: AgentEvent): void => {
    if (event.type === 'subagent-end') closed = { at: live.length, ok: event.ok }
    live.push(event)
  }
  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: new ToolRegistry([hold, taskTool]),
    maxDepth: 1,
    onEvent: record,
  })
  const running = collect(agent.run('delegate once'))

  // Nothing has finished yet, but the child's own call is already on the channel.
  await new Promise((resolve) => setTimeout(resolve, 30))
  const childCall = live.findIndex((event) => (event.depth ?? 0) > 0 && event.type === 'tool-call')
  assert.ok(childCall >= 0, 'a single delegation is not held back')
  assert.equal(closed === undefined, true, 'the delegation is still open')
  release()
  await running
  assert.equal(closed?.ok, true, 'the lone delegation closes as usual')
})

test('ask_user publishes the question and feeds the answer back to the model', async () => {
  const dir = tempDir()
  const seen: AgentEvent[] = []
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('understood')
    return [
      {
        type: 'tool-call',
        call: {
          id: 'call-ask',
          name: 'ask_user',
          arguments: JSON.stringify({
            question: 'Which approach?',
            options: [
              { label: 'Fast', description: 'quick and dirty' },
              { label: 'Safe', description: 'slower but robust', recommended: true },
            ],
            multiSelect: false,
            allowOther: true,
          }),
        },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: noTaskNoShell(),
    ask: promptAsk(async (request) => {
      assert.equal(request.question, 'Which approach?')
      assert.equal(request.options.length, 2)
      assert.equal(request.options[1]?.recommended, true)
      return { status: 'answered', selected: ['Safe'] }
    }),
    onEvent: (event) => seen.push(event),
  })

  const events = await collect(agent.run('ask'))
  const request = seen.find((event) => event.type === 'ask-request')
  assert.equal(request?.type === 'ask-request' ? request.callId : '', 'call-ask')
  assert.equal(request?.type === 'ask-request' ? request.question : '', 'Which approach?')
  assert.equal(request?.type === 'ask-request' ? request.allowOther : false, true)
  const answer = seen.find((event) => event.type === 'ask-answer')
  assert.deepEqual(answer?.type === 'ask-answer' ? answer.answer : null, { status: 'answered', selected: ['Safe'] })
  const result = events.find((event) => event.type === 'tool-result' && event.name === 'ask_user')
  assert.equal(result?.type === 'tool-result' ? result.isError : false, false)
  assert.match(result?.type === 'tool-result' ? result.content : '', /Selected: Safe/)
  const stored = agent.history().find((message) => message.role === 'tool' && message.toolName === 'ask_user')
  assert.match(textOf(stored?.content ?? ''), /Selected: Safe/)
})

test('ask_user without a gate fails cleanly and the turn continues', async () => {
  const dir = tempDir()
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('recovered')
    return [
      {
        type: 'tool-call',
        call: {
          id: 'call-ask',
          name: 'ask_user',
          arguments: JSON.stringify({ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }),
        },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({ provider, cwd: dir, approval: autoApproval(), tools: noTaskNoShell() })
  const events = await collect(agent.run('ask'))
  const result = events.find((event) => event.type === 'tool-result' && event.name === 'ask_user')
  assert.equal(result?.type === 'tool-result' ? result.isError : false, true)
  assert.match(result?.type === 'tool-result' ? result.content : '', /not available/)
  assert.equal(events.at(-1)?.type, 'turn-end')
})

test('ask_user answers feed the answer into the tool result on skip', async () => {
  const dir = tempDir()
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('ok')
    return [
      {
        type: 'tool-call',
        call: {
          id: 'call-ask',
          name: 'ask_user',
          arguments: JSON.stringify({ question: 'Color?', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: true, allowOther: true }),
        },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: noTaskNoShell(),
    ask: promptAsk(async () => ({ status: 'answered', selected: ['Red', 'Blue'], other: 'neon' })),
  })
  const events = await collect(agent.run('ask'))
  const result = events.find((event) => event.type === 'tool-result' && event.name === 'ask_user')
  const content = result?.type === 'tool-result' ? result.content : ''
  assert.match(content, /Selected: Red; Blue/)
  assert.match(content, /Other: neon/)
})

test('ask_user validation rejects bad options before the gate is consulted', async () => {
  const dir = tempDir()
  let consulted = false
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('ok')
    return [
      {
        type: 'tool-call',
        call: {
          id: 'call-ask',
          name: 'ask_user',
          arguments: JSON.stringify({ question: 'Pick one?', options: [{ label: 'A' }] }),
        },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: noTaskNoShell(),
    ask: promptAsk(async () => {
      consulted = true
      return { status: 'answered', selected: [] }
    }),
  })
  const events = await collect(agent.run('ask'))
  assert.equal(consulted, false)
  const result = events.find((event) => event.type === 'tool-result' && event.name === 'ask_user')
  assert.equal(result?.type === 'tool-result' ? result.isError : false, true)
  assert.match(result?.type === 'tool-result' ? result.content : '', /2.*4/)
})
