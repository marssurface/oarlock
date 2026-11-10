import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileTools } from '../src/tools/fs.ts'
import { findRg } from '../src/tools/ripgrep.ts'
import type { ToolContext, ToolDefinition } from '../src/tools/types.ts'
import { tempDir } from './helpers.ts'

const ctx = (cwd: string): ToolContext => ({ cwd })

function grepTool(): ToolDefinition {
  const found = fileTools.find((entry) => entry.name === 'grep_files')
  if (found === undefined) throw new Error('missing grep_files')
  return found
}

const ENV_KEYS = ['AGENT_NO_RG', 'AGENT_RG_PATH'] as const

/** Set backend env vars for one test and restore whatever was there before. */
async function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, run: () => Promise<void>): Promise<void> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** A fake rg that records its argv (NUL-separated) and emits canned matches. */
function fakeRg(dir: string, options: { exitCode?: number; output?: string } = {}): string {
  const script = join(dir, 'fake-rg.sh')
  const body = [
    '#!/bin/bash',
    `printf '%s\\0' "$@" > "${join(dir, 'args.txt')}"`,
    ...(options.output !== undefined ? [`printf '%s\\n' "${options.output.replace(/"/g, '\\"')}"`] : []),
    `exit ${options.exitCode ?? 0}`,
    '',
  ].join('\n')
  writeFileSync(script, body)
  chmodSync(script, 0o755)
  return script
}

function fixtureDir(): string {
  const dir = tempDir()
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'src', 'one.ts'), 'export const one = 1\nneedle here\n')
  writeFileSync(join(dir, 'src', 'two.js'), 'var needle = 2\n')
  writeFileSync(join(dir, '.hidden.txt'), 'needle in a dotfile\n')
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'needle in vendor\n')
  return dir
}

test('findRg honours the disable switch and the path override', async () => {
  await withEnv({ AGENT_NO_RG: '1' }, async () => {
    assert.equal(await findRg(), undefined)
  })
  await withEnv({ AGENT_RG_PATH: '/custom/rg' }, async () => {
    assert.equal(await findRg(), '/custom/rg')
  })
})

test('grep_files maps arguments onto rg and formats its output', async () => {
  const dir = tempDir()
  const script = fakeRg(dir, { output: 'a.ts:3:  matched line  \nb.ts:7:another' })
  const work = fixtureDir()
  await withEnv({ AGENT_RG_PATH: script }, async () => {
    const result = await grepTool().execute(
      { pattern: 'needle', path: 'src', include: '*.ts', ignore_case: true, max_results: 50 },
      ctx(work),
    )
    assert.equal(result.isError, undefined)
    // Paths are re-rooted to the tool cwd, text trimmed like the JS walker.
    assert.equal(result.content, 'src/a.ts:3: matched line\nsrc/b.ts:7: another')
  })
  const args = readFileSync(join(dir, 'args.txt'), 'utf8').split('\0').filter((arg) => arg !== '')
  assert.ok(args.includes('-e'))
  assert.ok(args.includes('needle'))
  assert.ok(args.includes('--ignore-case'))
  const globPairs = args.flatMap((arg, index) => (arg === '--glob' ? [args[index + 1]] : []))
  assert.ok(globPairs.includes('*.ts'))
  assert.ok(globPairs.includes('!node_modules'))
  assert.ok(globPairs.includes('!.git'))
  assert.ok(args.includes('--sort=path'))
  assert.ok(args.includes('--max-count=50'))
})

test('grep_files caps rg output at max_results', async () => {
  const dir = tempDir()
  const output = Array.from({ length: 10 }, (_, index) => `f.ts:${index + 1}: hit`).join('\n')
  const script = fakeRg(dir, { output })
  await withEnv({ AGENT_RG_PATH: script }, async () => {
    const result = await grepTool().execute({ pattern: 'hit', max_results: 3 }, ctx(fixtureDir()))
    assert.equal(result.content, 'f.ts:1: hit\nf.ts:2: hit\nf.ts:3: hit\n… (stopped at 3 matches)')
  })
})

test('rg exit 2 (pattern rejected) falls back to the JS walker', async () => {
  const dir = tempDir()
  const script = fakeRg(dir, { exitCode: 2 })
  const work = fixtureDir()
  await withEnv({ AGENT_RG_PATH: script }, async () => {
    // Lookahead is valid JavaScript but not valid Rust regex: the fallback
    // must still answer instead of erroring out.
    const result = await grepTool().execute({ pattern: '(?=.*needle)needle', include: '*.ts' }, ctx(work))
    assert.match(result.content, /src\/one\.ts:2:/)
    assert.doesNotMatch(result.content, /two\.js/)
  })
})

test('a broken rg path falls back to the JS walker', async () => {
  const work = fixtureDir()
  await withEnv({ AGENT_RG_PATH: join(tempDir(), 'does-not-exist') }, async () => {
    const result = await grepTool().execute({ pattern: 'needle', include: '*.ts' }, ctx(work))
    assert.match(result.content, /src\/one\.ts:2:/)
  })
})

test('AGENT_NO_RG forces the JS walker', async () => {
  const work = fixtureDir()
  await withEnv({ AGENT_NO_RG: '1' }, async () => {
    const result = await grepTool().execute({ pattern: 'needle' }, ctx(work))
    assert.match(result.content, /src\/one\.ts:2:/)
    assert.match(result.content, /\.hidden\.txt:1:/)
    assert.doesNotMatch(result.content, /node_modules/)
  })
})

test('real ripgrep matches the JS walker semantics', async (t) => {
  let rgPath: string | undefined
  await withEnv({}, async () => {
    rgPath = await findRg()
  })
  if (rgPath === undefined) {
    t.skip('ripgrep is not installed')
    return
  }
  const work = fixtureDir()
  await withEnv({}, async () => {
    const viaRg = await grepTool().execute({ pattern: 'needle' }, ctx(work))
    assert.match(viaRg.content, /src\/one\.ts:2:/)
    assert.match(viaRg.content, /\.hidden\.txt:1:/)
    assert.doesNotMatch(viaRg.content, /node_modules/)

    const filtered = await grepTool().execute({ pattern: 'NEEDLE', include: '*.ts', ignore_case: true }, ctx(work))
    assert.match(filtered.content, /src\/one\.ts:2:/)
    assert.doesNotMatch(filtered.content, /two\.js/)

    const none = await grepTool().execute({ pattern: 'no-such-token-xyz' }, ctx(work))
    assert.match(none.content, /no matches/)
  })
  // Same query through both backends must produce identical rows.
  let jsContent = ''
  await withEnv({ AGENT_NO_RG: '1' }, async () => {
    jsContent = (await grepTool().execute({ pattern: 'needle' }, ctx(work))).content
  })
  await withEnv({}, async () => {
    const rgContent = (await grepTool().execute({ pattern: 'needle' }, ctx(work))).content
    assert.equal(rgContent, jsContent)
  })
})