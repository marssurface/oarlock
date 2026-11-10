import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { bashTool } from '../src/tools/bash.ts'
import { fileTools } from '../src/tools/fs.ts'
import { taskTool } from '../src/tools/task.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolContext, ToolDefinition } from '../src/tools/types.ts'
import { SUBAGENT_PRESETS, findPreset, presetCatalog } from '../src/core/subagents.ts'
import { tempDir } from './helpers.ts'

const ctx = (cwd: string): ToolContext => ({ cwd })

function tool(name: string): ToolDefinition {
  const found = [...fileTools, bashTool].find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`missing tool ${name}`)
  return found
}

test('subagent presets expose an allowlist and a routing catalog', () => {
  const explore = findPreset('explore')
  assert.ok(explore !== undefined)
  assert.deepEqual(explore.tools, ['read_file', 'list_files', 'glob_files', 'grep_files'])
  assert.equal(explore.model, undefined, 'the cheap tier comes from the allowlist, not a hardcoded model')

  const general = findPreset('general')
  assert.ok(general !== undefined)
  assert.equal(general.tools, undefined, 'general inherits the parent tools')
  assert.ok(general.systemPrompt.includes('subagent'))

  assert.equal(findPreset('nope'), undefined)
  for (const preset of SUBAGENT_PRESETS) assert.ok(presetCatalog().includes(preset.name))
})

test('the task tool advertises routing and stays minimal in required args', () => {
  const properties = taskTool.parameters.properties as Record<string, unknown>
  assert.ok('agent' in properties && 'model' in properties && 'tools' in properties)
  assert.deepEqual(taskTool.parameters.required, ['description', 'prompt'])
})

test('write → read → edit round trip keeps numbering and content', async () => {
  const dir = tempDir()
  await tool('write_file').execute({ path: 'src/a.ts', content: 'const a = 1\n' }, ctx(dir))
  const read = await tool('read_file').execute({ path: 'src/a.ts' }, ctx(dir))
  assert.match(read.content, /1\|const a = 1/)

  const edit = await tool('edit_file').execute({ path: 'src/a.ts', old_string: '1', new_string: '2' }, ctx(dir))
  assert.equal(edit.isError, undefined)
  assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'const a = 2\n')
})

test('edit falls back to a controlled whitespace-tolerant match', async () => {
  const dir = tempDir()
  await tool('write_file').execute(
    { path: 'fmt.ts', content: 'function foo() {\n    if (x) {\n        return true\n    }\n}\n' },
    ctx(dir),
  )

  // The model under-indents the whole snippet: exact matching fails, the
  // whole-line fallback succeeds and each replaced line keeps the file's own
  // indentation, so only true → false changes.
  const fuzzy = await tool('edit_file').execute(
    { path: 'fmt.ts', old_string: 'if (x) {\n  return true\n}', new_string: 'if (x) {\n  return false\n}' },
    ctx(dir),
  )
  assert.equal(fuzzy.isError, undefined)
  assert.match(fuzzy.content, /whitespace-tolerant match/)
  assert.equal(
    readFileSync(join(dir, 'fmt.ts'), 'utf8'),
    'function foo() {\n    if (x) {\n        return false\n    }\n}\n',
  )

  // Ambiguous after normalization: refuse instead of guessing.
  await tool('write_file').execute({ path: 'dup.ts', content: 'if (a) {\n  b\n}\nif (a) {\n    b\n}\n' }, ctx(dir))
  const fuzzyAmbiguous = await tool('edit_file').execute(
    { path: 'dup.ts', old_string: 'if (a) {\n b\n}', new_string: 'x' },
    ctx(dir),
  )
  assert.equal(fuzzyAmbiguous.isError, true)
  assert.match(fuzzyAmbiguous.content, /appears 2 times after whitespace normalization/)
})

test('edit refuses ambiguous or missing matches', async () => {
  const dir = tempDir()
  await tool('write_file').execute({ path: 'a.txt', content: 'aaa' }, ctx(dir))
  const ambiguous = await tool('edit_file').execute({ path: 'a.txt', old_string: 'a', new_string: 'b' }, ctx(dir))
  assert.equal(ambiguous.isError, true)
  assert.match(ambiguous.content, /appears 3 times/)

  const missing = await tool('edit_file').execute({ path: 'a.txt', old_string: 'zzz', new_string: 'b' }, ctx(dir))
  assert.equal(missing.isError, true)
})

test('paths cannot escape the working directory', async () => {
  const dir = tempDir()
  await assert.rejects(
    () => tool('read_file').execute({ path: '../../etc/passwd' }, ctx(dir)),
    /escapes the working directory/,
  )
  await assert.rejects(
    () => tool('read_file').execute({ path: '/etc/hostname' }, ctx(dir)),
    /escapes the working directory/,
  )
})

test('glob, grep and list_files find the right entries', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'one.ts'), 'export const one = 1\n')
  writeFileSync(join(dir, 'src', 'two.ts'), 'export const two = 2\n')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  writeFileSync(join(dir, 'binary.bin'), Buffer.from([0, 1, 2, 3]))

  const glob = await tool('glob_files').execute({ pattern: '**/*.ts' }, ctx(dir))
  assert.match(glob.content, /src\/one\.ts/)
  assert.match(glob.content, /src\/two\.ts/)
  assert.doesNotMatch(glob.content, /README/)

  const grep = await tool('grep_files').execute({ pattern: 'two = 2', include: '*.ts' }, ctx(dir))
  assert.match(grep.content, /src\/two\.ts:1:/)

  const list = await tool('list_files').execute({ path: 'src', depth: 1 }, ctx(dir))
  assert.match(list.content, /src\/one\.ts/)
})

test('read_file honours offset and limit', async () => {
  const dir = tempDir()
  await tool('write_file').execute({ path: 'lines.txt', content: 'a\nb\nc\nd\n' }, ctx(dir))
  const read = await tool('read_file').execute({ path: 'lines.txt', offset: 2, limit: 2 }, ctx(dir))
  assert.match(read.content, /2\|b/)
  assert.match(read.content, /3\|c/)
  assert.doesNotMatch(read.content, /1\|a/)
})

test('bash runs in the working directory and reports exit codes', async () => {
  const dir = tempDir()
  const ok = await tool('bash').execute({ command: 'pwd && echo hi' }, ctx(dir))
  assert.match(ok.content, /hi/)
  assert.match(ok.content, /exit=0/)

  const bad = await tool('bash').execute({ command: 'exit 3' }, ctx(dir))
  assert.equal(bad.isError, true)
  assert.match(bad.content, /exit=3/)
})

test('bash reports a timed-out command as an error', async () => {
  const dir = tempDir()
  const result = await tool('bash').execute({ command: 'sleep 5', timeout_ms: 1_000 }, ctx(dir))
  assert.equal(result.isError, true)
  assert.match(result.content, /timed out/)
})

test('bash refuses catastrophic commands before spawning', async () => {
  const dir = tempDir()
  const refused = await tool('bash').execute({ command: 'rm -rf /' }, ctx(dir))
  assert.equal(refused.isError, true)
  assert.match(refused.content, /refusing to delete the filesystem root/)
})

test('ask_user is registered by default and validates its arguments', async () => {
  const registry = ToolRegistry.default({ allowShell: false, includeTask: false })
  assert.ok(registry.has('ask_user'), 'ask_user should be part of the default tool set')
  const tool = registry.get('ask_user')
  assert.equal(tool?.risk, 'read')
  assert.equal(tool?.name, 'ask_user')
})

test('todo_write is registered and validates plan updates', async () => {
  const registry = ToolRegistry.default({ allowShell: false, includeTask: false })
  assert.ok(registry.has('todo_write'), 'todo_write should be part of the default tool set')
  assert.equal(registry.get('todo_write')?.risk, 'read')

  const { parseTodoArgs, formatTodoList } = await import('../src/tools/todo.ts')
  const good = parseTodoArgs({
    todos: [
      { id: 'scan', content: ' 读代码 ', status: 'completed' },
      { content: '改实现', status: 'in_progress' },
      { content: '跑测试', status: 'pending' },
    ],
  })
  assert.ok('todos' in good)
  if ('todos' in good) {
    assert.deepEqual(good.todos, [
      { id: 'scan', content: '读代码', status: 'completed' },
      { id: 't2', content: '改实现', status: 'in_progress' },
      { id: 't3', content: '跑测试', status: 'pending' },
    ])
    assert.match(formatTodoList(good.todos), /1\/3 done/)
    assert.match(formatTodoList(good.todos), /\[~\] t2: 改实现/)
  }

  assert.ok('error' in parseTodoArgs({ todos: 'nope' }))
  assert.ok('error' in parseTodoArgs({ todos: [{ content: '', status: 'pending' }] }))
  assert.ok('error' in parseTodoArgs({ todos: [{ content: 'x', status: 'doing' }] }))
  assert.ok(
    'error' in
      parseTodoArgs({
        todos: [
          { content: 'a', status: 'in_progress' },
          { content: 'b', status: 'in_progress' },
        ],
      }),
  )
  assert.ok(
    'error' in
      parseTodoArgs({
        todos: [
          { id: 'x', content: 'a', status: 'pending' },
          { id: 'x', content: 'b', status: 'pending' },
        ],
      }),
  )
})

test('parseAskArgs accepts a full question and rejects malformed ones', async () => {
  const { askTool, parseAskArgs, formatAskAnswer } = await import('../src/tools/ask.ts')
  assert.ok(askTool !== undefined)

  const good = parseAskArgs({
    question: '  怎么部署？  ',
    header: ' 部署 ',
    options: [
      { label: 'Docker', description: ' 容器 ' },
      { label: '裸机', recommended: true },
    ],
    multiSelect: true,
    allowOther: true,
  })
  assert.ok('request' in good)
  if ('request' in good) {
    assert.equal(good.request.question, '怎么部署？')
    assert.equal(good.request.header, '部署')
    assert.equal(good.request.options.length, 2)
    assert.equal(good.request.options[1]?.recommended, true)
    assert.equal(good.request.multiSelect, true)
    assert.equal(good.request.allowOther, true)
  }

  const noQuestion = parseAskArgs({ options: [{ label: 'A' }, { label: 'B' }] })
  assert.ok('error' in noQuestion)
  const tooFew = parseAskArgs({ question: 'q', options: [{ label: 'A' }] })
  assert.ok('error' in tooFew)
  const tooMany = parseAskArgs({
    question: 'q',
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }],
  })
  assert.ok('error' in tooMany)
  const dupes = parseAskArgs({ question: 'q', options: [{ label: 'A' }, { label: 'A' }] })
  assert.ok('error' in dupes)
  const badOption = parseAskArgs({ question: 'q', options: [{ nope: 1 }, { label: 'B' }] })
  assert.ok('error' in badOption)

  assert.match(
    formatAskAnswer(
      { question: 'q', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowOther: false },
      { status: 'answered', selected: ['B'], other: 'custom' },
    ),
    /Selected: B/,
  )
  assert.match(
    formatAskAnswer(
      { question: 'q', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowOther: false },
      { status: 'skipped' },
    ),
    /skipped/i,
  )
})
