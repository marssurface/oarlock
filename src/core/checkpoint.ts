import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { textOf } from '../providers/content.ts'
import type { ChatMessage } from '../providers/types.ts'
import type { AgentEvent } from './events.ts'

/**
 * Workspace checkpoints backed by a shadow git repo (`.agent/checkpoints`).
 * The user's own `.git` is never touched; every main-agent turn commits the
 * workspace first, so a fork can optionally rewind files to a branch point.
 * git is optional: when it is missing, init fails or any command times out,
 * the manager degrades to a no-op instead of failing the turn.
 */

const GIT_TIMEOUT_MS = 30_000
const INIT_TIMEOUT_MS = 10_000

/** Heavy directories that never belong in a checkpoint (mirrors the tool walker). */
const EXCLUDED_DIRS = [
  '.agent',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.cache',
]

interface GitOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runGit(gitPath: string, args: string[], timeoutMs: number = GIT_TIMEOUT_MS): Promise<GitOutcome | undefined> {
  return new Promise<GitOutcome | undefined>((resolvePromise) => {
    let child
    try {
      child = spawn(gitPath, args, {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolvePromise(undefined)
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, timeoutMs)
    timer.unref()
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 1_000_000) stderr += chunk.toString('utf8')
    })
    child.on('error', () => {
      // Spawn failure (ENOENT etc.) behaves like a failed command.
      resolvePromise(undefined)
    })
    child.on('close', (code) => finish(code))
  })
}

export interface RestoreResult {
  ok: boolean
  checkpoint: string
  /** Files changed by the restore, when git could report it. */
  filesChanged?: number
  /** Snapshot of the pre-restore state, so a mistaken restore can be undone. */
  safety?: string
  message?: string
}

/** `AGENT_CHECKPOINT=0` turns the whole feature off. */
export function checkpointDisabled(): boolean {
  const value = process.env['AGENT_CHECKPOINT']
  return value === '0' || value === 'false'
}

export class CheckpointManager {
  readonly cwd: string
  readonly gitDir: string
  private readonly gitPath: string
  private initPromise: Promise<boolean> | undefined
  /** Serialize git work: several web sessions share one shadow repo. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(cwd: string, options: { gitPath?: string; gitDir?: string } = {}) {
    this.cwd = resolve(cwd)
    this.gitPath = options.gitPath ?? process.env['AGENT_GIT_PATH'] ?? 'git'
    this.gitDir = options.gitDir ?? join(this.cwd, '.agent', 'checkpoints')
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Every git invocation gets the shadow dirs and a fixed, signing-free identity. */
  private base(args: string[]): string[] {
    return [
      '--git-dir',
      this.gitDir,
      '--work-tree',
      this.cwd,
      '-c',
      'user.name=oarlock',
      '-c',
      'user.email=oarlock@localhost',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.quotepath=false',
      '-c',
      'gc.auto=0',
      ...args,
    ]
  }

  private async ensure(): Promise<boolean> {
    this.initPromise ??= (async () => {
      try {
        const init = await runGit(this.gitPath, ['init', '--bare', '--quiet', this.gitDir], INIT_TIMEOUT_MS)
        if (init === undefined || init.code !== 0) return false
        await runGit(this.gitPath, this.base(['config', 'core.bare', 'false']), INIT_TIMEOUT_MS)
        // Exclude heavy dirs, and reuse the workspace's root .gitignore so huge
        // generated trees stay out of the shadow repo.
        let workspaceIgnore = ''
        try {
          workspaceIgnore = (await readFile(join(this.cwd, '.gitignore'), 'utf8')).trim()
        } catch {
          // no .gitignore: fine
        }
        const patterns = [...EXCLUDED_DIRS.map((dir) => `${dir}/`), '*.log', '.DS_Store']
        if (workspaceIgnore !== '') patterns.push(workspaceIgnore)
        await mkdir(join(this.gitDir, 'info'), { recursive: true })
        await writeFile(join(this.gitDir, 'info', 'exclude'), `${patterns.join('\n')}\n`, 'utf8')
        return true
      } catch {
        return false
      }
    })()
    return this.initPromise
  }

  /** Commit the worktree; returns the commit hash or undefined on any failure. */
  private async snapshot(label: string): Promise<string | undefined> {
    const add = await runGit(this.gitPath, this.base(['add', '-A', '--', '.']))
    if (add === undefined || add.code !== 0) return undefined
    const status = await runGit(this.gitPath, this.base(['status', '--porcelain']))
    if (status !== undefined && status.code === 0 && status.stdout.trim() === '') {
      // Nothing changed: the current HEAD already describes the worktree. An
      // empty workspace (first turn, nothing written yet) has no HEAD at all,
      // so it still needs an empty commit to anchor the restore point.
      const head = await runGit(this.gitPath, this.base(['rev-parse', '--verify', 'HEAD']))
      const hash = head?.stdout.trim() ?? ''
      if (head !== undefined && head.code === 0 && hash !== '') return hash
    }
    const commit = await runGit(
      this.gitPath,
      this.base(['commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', label]),
    )
    if (commit === undefined || commit.code !== 0) return undefined
    const rev = await runGit(this.gitPath, this.base(['rev-parse', 'HEAD']))
    if (rev === undefined || rev.code !== 0) return undefined
    const hash = rev.stdout.trim()
    if (hash === '') return undefined
    // Keep a branch pointer at the newest snapshot (restores move HEAD).
    await runGit(this.gitPath, this.base(['update-ref', 'refs/heads/main', hash]))
    return hash
  }

  /** Snapshot before a turn. Never throws; undefined means "not checkpointed". */
  async begin(label?: string): Promise<string | undefined> {
    if (checkpointDisabled()) return undefined
    return this.enqueue(async () => {
      if (!(await this.ensure())) return undefined
      return this.snapshot(`snapshot ${new Date().toISOString()}${label !== undefined ? ` · ${label}` : ''}`)
    })
  }

  /**
   * Restore the worktree to a snapshot. Takes a safety snapshot first, so the
   * restore itself is undoable by restoring to `result.safety`.
   */
  async restore(checkpoint: string): Promise<RestoreResult> {
    if (checkpointDisabled()) return { ok: false, checkpoint, message: 'checkpointing is disabled' }
    return this.enqueue(async () => {
      if (!(await this.ensure())) return { ok: false, checkpoint, message: 'git is unavailable' }
      const exists = await runGit(this.gitPath, this.base(['cat-file', '-e', `${checkpoint}^{commit}`]))
      if (exists === undefined || exists.code !== 0) {
        return { ok: false, checkpoint, message: `unknown checkpoint ${checkpoint}` }
      }
      const safety = await this.snapshot('snapshot before-restore')
      if (safety === undefined) {
        return { ok: false, checkpoint, message: 'could not snapshot the current workspace' }
      }
      const changed = await runGit(this.gitPath, this.base(['diff', '--name-only', safety, checkpoint]))
      const filesChanged =
        changed !== undefined && changed.code === 0
          ? changed.stdout.split('\n').filter((line) => line.trim() !== '').length
          : undefined
      const checkout = await runGit(this.gitPath, this.base(['checkout', '--quiet', '--force', checkpoint]))
      if (checkout === undefined || checkout.code !== 0) {
        return {
          ok: false,
          checkpoint,
          ...(safety !== undefined ? { safety } : {}),
          ...(filesChanged !== undefined ? { filesChanged } : {}),
          message: checkout === undefined ? 'git checkout failed' : checkout.stderr.trim().slice(0, 500),
        }
      }
      await runGit(this.gitPath, this.base(['update-ref', 'refs/heads/main', checkpoint]))
      // Keep the pre-restore state reachable so "undo the rewind" stays possible.
      if (safety !== checkpoint) {
        await runGit(this.gitPath, this.base(['update-ref', 'refs/heads/pre-restore', safety]))
      }
      return {
        ok: true,
        checkpoint,
        ...(filesChanged !== undefined ? { filesChanged } : {}),
        safety,
      }
    })
  }
}

const managers = new Map<string, CheckpointManager>()

/** One manager per working directory, shared by CLI and web in this process. */
export function checkpointManager(cwd: string): CheckpointManager {
  const key = resolve(cwd)
  let manager = managers.get(key)
  if (manager === undefined) {
    manager = new CheckpointManager(key)
    managers.set(key, manager)
  }
  return manager
}

/**
 * Resolve the snapshot taken before the turn that starts at `messages[keep]`.
 * Turn-start events are matched to the transcript as a suffix: compaction only
 * drops old turns, and every turn emits exactly one depth-0 turn-start. The
 * input text is verified so a mismatched (compacted or stale) trace fails safe.
 */
export function checkpointForUserMessage(
  records: ReadonlyArray<{ event: AgentEvent }>,
  messages: ReadonlyArray<ChatMessage>,
  keep: number,
): string | undefined {
  const target = messages[keep]
  if (target === undefined || target.role !== 'user') return undefined
  const text = textOf(target.content)
  const userMessages = messages.filter((message) => message.role === 'user')
  const order = messages.slice(0, keep).filter((message) => message.role === 'user').length
  if (order >= userMessages.length) return undefined
  const starts = records.filter((record) => record.event.type === 'turn-start' && (record.event.depth ?? 0) === 0)
  const aligned = starts.slice(-userMessages.length)
  const candidate = aligned[order]
  if (candidate === undefined || candidate.event.type !== 'turn-start') return undefined
  if (candidate.event.input !== text) return undefined
  return candidate.event.checkpoint
}