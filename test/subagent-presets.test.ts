import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Agent } from '../src/core/agent.ts'
import { autoApproval } from '../src/core/approval.ts'
import { ContextManager } from '../src/core/context.ts'
import type { ProviderRequest } from '../src/providers/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { BUILTIN_PRESETS, fileSubagentPresets, parseSubagentFile, subagentPresets } from '../src/core/subagents.ts'
import { collect, scripted, tempDir, text } from './helpers.ts'

function agentsDir(cwd: string): string {
  const dir = join(cwd, '.agent', 'agents')
  mkdirSync(dir, { recursive: true })
  return dir
}

function writePreset(cwd: string, fileName: string, textContent: string): string {
  const file = join(agentsDir(cwd), fileName)
  writeFileSync(file, textContent, 'utf8')
  return file
}

test('a preset file turns frontmatter and body into a route', () => {
  const preset = parseSubagentFile(
    ['---', 'name: Summarizer', 'description: 压缩长文', 'tools: read_file, grep_files', 'model: cheap-model', '---', '', 'You summarise documents.', 'Never invent quotes.'].join('\n'),
    'fallback-name',
  )
  assert.ok(preset !== undefined)
  assert.equal(preset.name, 'summarizer', 'names are lowercased so routing is case-insensitive')
  assert.equal(preset.description, '压缩长文')
  assert.deepEqual(preset.tools, ['read_file', 'grep_files'])
  assert.equal(preset.model, 'cheap-model')
  assert.match(preset.systemPrompt, /Never invent quotes/)
  assert.equal(preset.source, '.agent/agents/summarizer.md')
})

test('a preset file falls back to its name and body when fields are missing', () => {
  const preset = parseSubagentFile('---\nallowed-tools: [read_file]\n---\n\n# Reviewer\nReview diffs closely.\n', 'reviewer')
  assert.ok(preset !== undefined)
  assert.equal(preset.name, 'reviewer', 'the file name is the fallback name')
  assert.equal(preset.description, 'Reviewer', 'the first body line describes it when frontmatter says nothing')
  assert.deepEqual(preset.tools, ['read_file'], 'allowed-tools is an alias for tools')
  assert.equal(preset.model, undefined)
})

test('a bodyless file still works, and junk never enters the catalog', () => {
  const toolsOnly = parseSubagentFile('---\nname: reader\ntools: read_file\n---\n', 'reader')
  assert.ok(toolsOnly !== undefined)
  assert.equal(toolsOnly.systemPrompt, BUILTIN_PRESETS[0]?.systemPrompt, 'no persona means the generic subagent persona')

  assert.equal(parseSubagentFile('---\nname: ../../escape\n---\nbody\n', 'escape'), undefined, 'a traversal name is refused')
  assert.equal(parseSubagentFile('---\nname: "quoted"\n---\nbody\n', 'x'), undefined, 'a non-slug name is refused')
  assert.equal(parseSubagentFile('x'.repeat(40_000), 'huge'), undefined, 'oversized files are skipped')

  const dir = tempDir()
  assert.deepEqual(fileSubagentPresets(dir), [], 'no .agent/agents directory means no file presets')
  mkdirSync(join(dir, '.agent', 'agents'), { recursive: true })
  writeFileSync(join(dir, '.agent', 'agents', 'README.md'), '# notes for humans\n', 'utf8')
  writeFileSync(join(dir, '.agent', 'agents', 'broken.md'), '---\nname: Bad Name\n---\nbody\n', 'utf8')
  writeFileSync(join(dir, '.agent', 'agents', 'good.md'), '---\ndescription: works\n---\npersona\n', 'utf8')
  assert.deepEqual(
    fileSubagentPresets(dir).map((preset) => preset.name),
    ['good'],
    'malformed files are skipped, the rest still load',
  )
})

test('file presets extend the built-ins and may replace one', () => {
  const dir = tempDir()
  writePreset(dir, 'summarizer.md', '---\ndescription: compress\n---\npersona\n')
  writePreset(dir, 'explore.md', '---\ndescription: my own explorer\n---\nmy persona\n')

  const names = subagentPresets(dir).map((preset) => preset.name)
  assert.deepEqual(names, ['general', 'explore', 'summarizer'], 'built-ins keep their place, file presets sort after')
  const explore = subagentPresets(dir).find((preset) => preset.name === 'explore')
  assert.equal(explore?.description, 'my own explorer', 'a file with a built-in name replaces it')
  assert.equal(explore?.tools, undefined, 'the replacement defines its own tools')
})

test('task routes to a file preset: persona, allowlist and model all apply', async () => {
  const dir = tempDir()
  writePreset(dir, 'summarizer.md', ['---', 'description: compress a document', 'tools: read_file grep_files', 'model: cheap-model', '---', 'You compress documents into bullet points.'].join('\n'))

  const requests: ProviderRequest[] = []
  const provider = scripted((request) => {
    requests.push(request)
    const system = String(request.messages[0]?.content ?? '')
    if (system.includes('compress documents into bullet points')) return text('child report')
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'user') {
      return [
        {
          type: 'tool-call',
          call: { id: 't1', name: 'task', arguments: JSON.stringify({ description: 'shrink', prompt: 'summarize notes.md', agent: 'summarizer' }) },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ]
    }
    if (last?.role === 'tool') {
      assert.match(String(last.content), /child report/, 'the child report comes back to the parent')
      return text('done')
    }
    return text('ok')
  })

  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: ToolRegistry.default({ allowShell: false }),
    context: new ContextManager({ window: 200_000 }),
    subagentPresets: () => subagentPresets(dir),
  })
  await collect(agent.run('delegate'))

  const child = requests.find((request) => String(request.messages[0]?.content ?? '').includes('compress documents into bullet points'))
  assert.notEqual(child, undefined, 'the file preset persona must reach the child')
  assert.deepEqual(
    (child?.tools ?? []).map((spec) => spec.name).sort(),
    ['grep_files', 'read_file'],
    'the file preset allowlist caps the child tools',
  )
  assert.equal(child?.model, 'cheap-model', 'a file preset may name its own model')
})

test('an unknown preset names what is available, and a dead allowlist says so', async () => {
  const dir = tempDir()
  writePreset(dir, 'summarizer.md', '---\ndescription: compress\n---\npersona\n')

  const calls: Record<string, unknown>[] = []
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') {
      calls.push({ content: String(last.content) })
      return text('handled')
    }
    return [
      {
        type: 'tool-call',
        call: { id: 't1', name: 'task', arguments: JSON.stringify({ description: 'x', prompt: 'y', agent: 'nope' }) },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })

  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: ToolRegistry.default({ allowShell: false }),
    subagentPresets: () => subagentPresets(dir),
  })
  const events = await collect(agent.run('go'))
  const taskResult = events.find((event) => event.type === 'tool-result' && event.name === 'task')
  assert.equal(taskResult?.type === 'tool-result' ? taskResult.isError : false, true)
  const message = taskResult?.type === 'tool-result' ? taskResult.content : ''
  assert.match(message, /unknown agent preset: nope/)
  assert.match(message, /summarizer/, 'the error must list the workspace presets')

  // A typo in tools: would otherwise send a child out with nothing to do.
  writePreset(dir, 'broken.md', '---\ndescription: typo\n---\npersona\n')
  writeFileSync(join(dir, '.agent', 'agents', 'broken.md'), '---\ndescription: typo\ntools: read_filez\n---\npersona\n', 'utf8')
  const provider2 = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('handled')
    return [
      {
        type: 'tool-call',
        call: { id: 't1', name: 'task', arguments: JSON.stringify({ description: 'x', prompt: 'y', agent: 'broken' }) },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent2 = new Agent({
    provider: provider2,
    cwd: dir,
    approval: autoApproval(),
    tools: ToolRegistry.default({ allowShell: false }),
    subagentPresets: () => subagentPresets(dir),
  })
  const events2 = await collect(agent2.run('go'))
  const result2 = events2.find((event) => event.type === 'tool-result' && event.name === 'task')
  assert.match(result2?.type === 'tool-result' ? result2.content : '', /allows only read_filez/)
})

test('a preset file added mid-session is in next turn’s prompt', async () => {
  const dir = tempDir()
  const provider = scripted((request) => {
    const system = String(request.messages[0]?.content ?? '')
    if (system.includes('`auditor`')) return text('has-auditor')
    return text('no-auditor')
  })
  const agent = new Agent({
    provider,
    cwd: dir,
    approval: autoApproval(),
    tools: ToolRegistry.default({ allowShell: false }),
    context: new ContextManager({ window: 200_000 }),
    subagentPresets: () => subagentPresets(dir),
  })

  const first = await collect(agent.run('one'))
  assert.equal(first.filter((e) => e.type === 'text-delta').map((e) => (e.type === 'text-delta' ? e.text : '')).join(''), 'no-auditor')

  writePreset(dir, 'auditor.md', '---\ndescription: audit the workspace\n---\npersona\n')
  const second = await collect(agent.run('two'))
  assert.equal(
    second.filter((e) => e.type === 'text-delta').map((e) => (e.type === 'text-delta' ? e.text : '')).join(''),
    'has-auditor',
    'the turn-start refresh must pick up a newly written preset',
  )
  assert.match(String(agent.messages[0]?.content ?? ''), /standing personas/, 'file presets get their own guidance line')
})

test('a broken preset source falls back to the built-ins instead of failing the turn', async () => {
  const provider = scripted((request) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') return text('handled')
    return [
      { type: 'tool-call', call: { id: 't1', name: 'task', arguments: JSON.stringify({ description: 'x', prompt: 'y' }) } },
      { type: 'done', finishReason: 'tool_calls' },
    ]
  })
  const agent = new Agent({
    provider,
    cwd: tempDir(),
    approval: autoApproval(),
    tools: ToolRegistry.default({ allowShell: false }),
    subagentPresets: () => {
      throw new Error('disk on fire')
    },
  })
  const events = await collect(agent.run('go'))
  assert.ok(events.some((event) => event.type === 'turn-end'), 'the turn still finishes')
  const taskResult = events.find((event) => event.type === 'tool-result' && event.name === 'task')
  assert.equal(taskResult?.type === 'tool-result' ? taskResult.isError : true, false, 'general still routes')
})
