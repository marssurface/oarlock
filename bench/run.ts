import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.ts'
import type { ProviderKind } from '../src/config.ts'
import { Agent } from '../src/core/agent.ts'
import { autoApproval, denyApproval, promptApproval } from '../src/core/approval.ts'
import { ContextManager } from '../src/core/context.ts'
import type { AgentEvent } from '../src/core/events.ts'
import { createProvider } from '../src/providers/index.ts'
import { MockProvider } from '../src/providers/mock.ts'
import type { ChatProvider } from '../src/providers/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { tasks } from './tasks/index.ts'
import { lastAnswer } from './tasks/shared.ts'
import { RecordingProvider, ReplayProvider, loadTranscript } from './transcripts.ts'
import type { BenchResult, BenchTask } from './types.ts'

interface Args {
  provider?: ProviderKind
  model?: string
  only: string[]
  json: boolean
  verbose: boolean
  keep: boolean
  timeoutMs: number
  record: boolean
  replay: boolean
  help: boolean
}

const TRANSCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'transcripts')

function transcriptFile(taskId: string): string {
  return join(TRANSCRIPT_DIR, `${taskId}.json`)
}

const color = (code: number, text: string): string =>
  process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined ? `\u001b[${code}m${text}\u001b[0m` : text

function parseArgs(argv: string[]): Args {
  const args: Args = { only: [], json: false, verbose: false, keep: false, timeoutMs: 120_000, record: false, replay: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      index += 1
      return next
    }
    switch (arg) {
      case '--provider':
        args.provider = value() as ProviderKind
        break
      case '--model':
        args.model = value()
        break
      case '--only':
        args.only = value().split(',').map((item) => item.trim()).filter(Boolean)
        break
      case '--timeout':
        args.timeoutMs = Number.parseInt(value(), 10)
        break
      case '--json':
        args.json = true
        break
      case '--verbose':
        args.verbose = true
        break
      case '--keep':
        args.keep = true
        break
      case '--record':
        args.record = true
        break
      case '--replay':
        args.replay = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function printHelp(): void {
  process.stdout.write(
    [
      'oarlock bench — run the task suite and score it',
      '',
      'Usage: node bench/run.ts [options]',
      '',
      '  --provider <deepseek|openai|ollama|mock>  run against a live model',
      '  --model <name>                            override the model name',
      '  --only fix-bug,compaction                 run selected tasks only',
      '  --record                                  save provider streams to bench/transcripts/',
      '  --replay                                  run recorded streams, no network or key',
      '  --verbose                                 print tool activity per task',
      '  --keep                                    keep fixture directories',
      '  --json                                    machine-readable output',
      '  --timeout <ms>                            per-task timeout (default 120000)',
      '',
      'Without --provider every task uses its scripted stand-in model, which',
      'checks the runtime (loop, tools, approvals, compaction) rather than model quality.',
      '--record needs --provider; --replay needs the transcripts it produced.',
      '',
    ].join('\n'),
  )
}

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'tool-call':
      process.stdout.write(color(36, `        → ${event.name} ${event.arguments.replace(/\s+/g, ' ').slice(0, 130)}\n`))
      break
    case 'tool-result':
      process.stdout.write(
        color(
          event.isError === true ? 31 : 32,
          `        ${event.isError === true ? '✗' : '✓'} ${event.content.replace(/\s+/g, ' ').slice(0, 150)}\n`,
        ),
      )
      break
    case 'compaction':
      process.stdout.write(color(90, `        … compacted ${event.before} → ${event.after} tokens\n`))
      break
    case 'error':
      process.stdout.write(color(31, `        ✗ ${event.message}\n`))
      break
    default:
      break
  }
}

async function runTask(task: BenchTask, live: ChatProvider | undefined, args: Args): Promise<BenchResult> {
  const dir = mkdtempSync(join(tmpdir(), `dock-bench-${task.id}-`))
  const startedAt = Date.now()
  try {
    await task.setup?.(dir)

    let provider: ChatProvider | undefined
    let recorder: RecordingProvider | undefined
    if (live !== undefined) {
      if (args.record) {
        recorder = new RecordingProvider(live, { cwd: dir })
        provider = recorder
      } else {
        provider = live
      }
    } else if (args.replay) {
      provider = new ReplayProvider(loadTranscript(transcriptFile(task.id)), { cwd: dir })
    } else if (task.script !== undefined) {
      provider = new MockProvider({ script: task.script })
    }
    if (provider === undefined) throw new Error('this task has no scripted model; run with --provider')

    const events: AgentEvent[] = []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), args.timeoutMs)
    const mode = task.approval ?? 'auto'
    const gate =
      mode === 'auto'
        ? autoApproval()
        : mode === 'deny'
          ? denyApproval()
          : promptApproval(async () => 'deny')

    const agent = new Agent({
      provider,
      cwd: dir,
      approval: gate,
      tools: task.tools ?? ToolRegistry.default(),
      context: new ContextManager({ window: task.contextWindow ?? 200_000, ...(task.contextOptions ?? {}) }),
      maxSteps: task.maxSteps ?? 20,
      retryDelayMs: 1,
      onEvent: (event) => {
        events.push(event)
        if (args.verbose) renderEvent(event)
        if (
          task.abortAfterFirstDelta === true &&
          (event.type === 'text-delta' || event.type === 'reasoning-delta')
        ) {
          controller.abort()
        }
      },
    })
    if (task.history !== undefined) agent.setHistory(task.history)

    try {
      const inputs = task.turns ?? [task.prompt]
      for (const input of inputs) {
        for await (const _event of agent.run(input, controller.signal)) {
          // Events are collected through onEvent.
        }
      }
    } finally {
      clearTimeout(timer)
    }

    const failure = events.find((event) => event.type === 'error')
    if (failure !== undefined && task.expectError !== true) {
      throw new Error(failure.type === 'error' ? failure.message : 'agent failed')
    }

    await task.verify({ dir, events, answer: lastAnswer(events), messages: agent.history() })

    let note: string | undefined
    if (recorder !== undefined && live !== undefined) {
      mkdirSync(TRANSCRIPT_DIR, { recursive: true })
      const transcript = recorder.toTranscript({ task: task.id, provider: live.id, model: live.model })
      const target = transcriptFile(task.id)
      writeFileSync(target, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8')
      note = `recorded ${transcript.streams.length} stream(s) → ${relative(process.cwd(), target)}`
    }

    return { id: task.id, title: task.title, ok: true, durationMs: Date.now() - startedAt, ...(note !== undefined ? { note } : {}) }
  } catch (error) {
    return {
      id: task.id,
      title: task.title,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: (error as Error).message,
    }
  } finally {
    if (!args.keep) rmSync(dir, { recursive: true, force: true })
    else process.stdout.write(color(90, `        kept fixture at ${dir}\n`))
  }
}

function printResult(result: BenchResult): void {
  const mark = result.ok ? color(32, '✓') : color(31, '✗')
  const time = `${(result.durationMs / 1000).toFixed(1)}s`
  process.stdout.write(`  ${mark} ${result.id.padEnd(16)} ${result.title.padEnd(24)} ${color(90, time)}\n`)
  if (!result.ok && result.error !== undefined) {
    process.stdout.write(color(31, `      ${result.error.split('\n')[0]}\n`))
  }
  if (result.note !== undefined) process.stdout.write(color(90, `      ${result.note}\n`))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args.record && args.provider === undefined) {
    process.stderr.write('--record needs --provider: it saves the streams a live model produces\n')
    process.exit(1)
  }
  if (args.replay && args.provider !== undefined) {
    process.stderr.write('--replay runs recorded streams and needs no --provider\n')
    process.exit(1)
  }

  const selected = args.only.length > 0 ? tasks.filter((task) => args.only.includes(task.id)) : tasks
  if (selected.length === 0) {
    process.stderr.write(`no task matches --only ${args.only.join(',')}\n`)
    process.exit(1)
  }

  let live: ChatProvider | undefined
  let modelLabel = 'scripted'
  if (args.provider !== undefined) {
    const config = resolveConfig({
      provider: args.provider,
      cwd: process.cwd(),
      ...(args.model !== undefined ? { model: args.model } : {}),
    })
    if (config.provider !== 'ollama' && config.provider !== 'mock' && config.apiKey === undefined) {
      process.stderr.write(`missing API key for ${config.provider}: set it in .env or the environment\n`)
      process.exit(1)
    }
    live = createProvider(config)
    modelLabel = `${config.provider}/${config.model}`
  }

  const skipped =
    live !== undefined
      ? selected.filter((task) => task.scriptOnly === true)
      : args.replay
        ? selected.filter((task) => !existsSync(transcriptFile(task.id)))
        : []
  const runnable = selected.filter((task) => skipped.indexOf(task) < 0)
  if (runnable.length === 0) {
    process.stderr.write(
      args.replay
        ? 'no transcript for the selected tasks; record one with --provider <kind> --record first\n'
        : 'every selected task is script-only; run without --provider\n',
    )
    process.exit(1)
  }

  const modeLabel = args.replay
    ? 'replay (recorded, no network)'
    : live === undefined
      ? 'scripted (runtime baseline)'
      : `live ${modelLabel}`

  if (!args.json) {
    process.stdout.write(`\noarlock bench · ${modeLabel}\n`)
    if (live === undefined && !args.replay) {
      process.stdout.write(color(90, '  脚本模型只验证运行时；接真模型请加 --provider deepseek\n'))
    }
    if (args.record) {
      process.stdout.write(color(90, '  录制模式：每个任务通过后会把模型事件写入 bench/transcripts/\n'))
    }
    if (skipped.length > 0) {
      process.stdout.write(
        color(90, `  跳过${args.replay ? '没有录制的' : ' script-only '}任务：${skipped.map((task) => task.id).join(', ')}\n`),
      )
    }
    process.stdout.write('\n')
  }

  const startedAt = Date.now()
  const results: BenchResult[] = []
  for (const task of runnable) {
    const result = await runTask(task, live, args)
    results.push(result)
    if (!args.json) printResult(result)
  }

  const passed = results.filter((result) => result.ok).length
  const durationMs = Date.now() - startedAt

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ mode: args.replay ? 'replay' : live === undefined ? 'scripted' : 'live', model: modelLabel, passed, total: results.length, durationMs, skipped: skipped.map((task) => task.id), results }, null, 2)}\n`,
    )
  } else {
    process.stdout.write(
      `\n  ${passed}/${results.length} passed · ${(durationMs / 1000).toFixed(1)}s\n` +
        (passed === results.length ? color(32, '  all tasks passed\n') : color(31, `  failed: ${results.filter((r) => !r.ok).map((r) => r.id).join(', ')}\n`)),
    )
  }

  process.exitCode = passed === results.length ? 0 : 1
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${(error as Error).message}\n`)
  process.exit(1)
})
