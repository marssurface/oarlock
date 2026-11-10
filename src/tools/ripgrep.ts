import { execFile, spawn } from 'node:child_process'

/**
 * ripgrep acceleration for grep_files. The JS walker in fs.ts stays the
 * fallback: rg is an optimization, never a hard dependency, and the tool
 * contract keeps JavaScript regex semantics (rg-incompatible patterns fall
 * back automatically).
 */

const PROBE_TIMEOUT_MS = 3000
const SEARCH_TIMEOUT_MS = 20_000
/** Raw stdout cap; beyond this we fall back instead of guessing from partial output. */
const MAX_CAPTURE = 4_000_000
/** Match the JS walker's per-file size limit. */
const MAX_FILESIZE = '2M'

let probe: Promise<boolean> | undefined

/**
 * Locate a ripgrep binary. `AGENT_RG_PATH` overrides the lookup,
 * `AGENT_NO_RG=1` disables it entirely (both read on every call so tests and
 * ops can switch backends without a restart). The PATH probe runs once per
 * process and is cached.
 */
export function findRg(): Promise<string | undefined> {
  if (process.env['AGENT_NO_RG'] === '1') return Promise.resolve(undefined)
  const override = process.env['AGENT_RG_PATH']
  if (override !== undefined && override !== '') return Promise.resolve(override)
  probe ??= new Promise<boolean>((resolve) => {
    execFile('rg', ['--version'], { timeout: PROBE_TIMEOUT_MS }, (error) => {
      resolve(error === null)
    })
  })
  return probe.then((ok) => (ok ? 'rg' : undefined))
}

export interface RgSearchOptions {
  /** Absolute directory to search; becomes rg's cwd so output paths are relative. */
  target: string
  /** Prefix relative to the tool cwd ('' when target is the cwd itself). */
  root: string
  pattern: string
  include: string
  ignoreCase: boolean
  maxResults: number
  /** Directory names the JS walker skips; mirrored as exclusion globs. */
  ignoredDirs: Iterable<string>
  signal?: AbortSignal
}

/**
 * Run one ripgrep search. Returns formatted `rel:line: text` rows (capped at
 * maxResults), or undefined when rg is unavailable, fails, times out, or
 * rejects the pattern — the caller then falls back to the JS walker.
 */
export async function grepWithRg(options: RgSearchOptions): Promise<string[] | undefined> {
  const rgPath = await findRg()
  if (rgPath === undefined) return undefined
  if (options.signal?.aborted === true) return undefined

  const args = [
    '--no-config',
    '--no-messages',
    // Mirror the JS walker: hidden files included, .gitignore not honored,
    // known build/vendor dirs excluded by name at any depth.
    '--hidden',
    '--no-ignore',
    '--color=never',
    '--with-filename',
    '--line-number',
    '--no-heading',
    // Deterministic file order, same as the sorted JS walk.
    '--sort=path',
    `--max-filesize=${MAX_FILESIZE}`,
    // Per-file cap: can never remove any of the first maxResults global hits.
    `--max-count=${options.maxResults}`,
    ...(options.ignoreCase ? ['--ignore-case'] : []),
    ...(options.include !== '' ? ['--glob', options.include] : []),
    ...[...options.ignoredDirs].flatMap((dir) => ['--glob', `!${dir}`]),
    '-e',
    options.pattern,
  ]

  interface Outcome {
    code: number | null
    stdout: string
    overflow: boolean
    failed: boolean
  }

  const outcome = await new Promise<Outcome>((resolve) => {
    const child = spawn(rgPath, args, {
      cwd: options.target,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let overflow = false
    let failed = false
    let settled = false

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, overflow, failed })
    }
    const kill = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      failed = true
      kill()
    }, SEARCH_TIMEOUT_MS)
    timer.unref()
    const onAbort = (): void => {
      failed = true
      kill()
    }
    if (options.signal?.aborted === true) {
      failed = true
      kill()
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (stdout.length + text.length > MAX_CAPTURE) {
        overflow = true
        kill()
        return
      }
      stdout += text
    })
    // stderr is noise (permission warnings are already silenced); drain it so
    // a full pipe buffer cannot deadlock the child.
    child.stderr.resume()
    child.on('error', () => {
      failed = true
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })

  // Exit 2 means rg rejected the pattern (e.g. JS-only lookahead) or hit a
  // real error; the JS walker gets a chance to handle it. Timeouts, aborts,
  // spawn failures and capture overflow also fall back.
  if (outcome.failed || outcome.overflow) return undefined
  if (outcome.code !== 0 && outcome.code !== 1) return undefined

  const results: string[] = []
  for (const line of outcome.stdout.split('\n')) {
    if (line === '') continue
    const match = /^(.*?):(\d+):(.*)$/.exec(line)
    if (match === null) continue
    const [, file, lineNumber, text] = match
    if (file === undefined || lineNumber === undefined || text === undefined) continue
    const rel = options.root === '' ? file : `${options.root}/${file}`
    results.push(`${rel}:${lineNumber}: ${text.trim().slice(0, 300)}`)
    if (results.length >= options.maxResults) break
  }
  return results
}