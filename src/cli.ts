#!/usr/bin/env node
import { resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { describeConfig, loadDotEnv, resolveConfig } from './config.ts'
import type { ProviderKind } from './config.ts'
import { autoApproval, denyApproval, ruleApproval } from './core/approval.ts'
import { promptAsk, skipAsks } from './core/ask.ts'
import { checkpointForUserMessage, checkpointManager } from './core/checkpoint.ts'
import type { Agent } from './core/agent.ts'
import type { AgentEvent } from './core/events.ts'
import { formatCost } from './core/pricing.ts'
import type { TokenCost } from './core/pricing.ts'
import { MEMORY_RELATIVE_DIR, memoryStore } from './core/memory.ts'
import { SUBAGENT_RELATIVE_DIR, subagentPresets } from './core/subagents.ts'
import { permissionRules } from './core/rules.ts'
import { createRuntime } from './core/setup.ts'
import type { Runtime } from './core/setup.ts'
import { loadMcpServers } from './mcp/index.ts'
import type { Usage } from './providers/types.ts'
import { SessionStore, summarizeTrace } from './session/store.ts'
import type { Session } from './session/store.ts'
import { summarizeTodos } from './tools/todo.ts'

interface CliArgs {
  provider?: ProviderKind
  model?: string
  baseUrl?: string
  approval?: 'ask' | 'auto' | 'deny'
  resume?: string
  trace?: string
  cwd?: string
  once?: string
  help?: boolean
}

const color = (code: number, text: string): string =>
  process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined ? `\u001b[${code}m${text}\u001b[0m` : text

function compact(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function shortTokens(value: number | undefined): string {
  const tokens = value ?? 0
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function shortDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1_000)}s`
}

/** `↑1.2k ↓340 · 缓存 800`; empty when the request reported nothing. */
function usageText(usage: Usage | undefined): string {
  if (usage === undefined) return ''
  const parts: string[] = []
  const prefix = usage.estimated === true ? '~' : ''
  if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
    parts.push(`${prefix}↑${shortTokens(usage.promptTokens)} ↓${shortTokens(usage.completionTokens)}`)
  } else if (usage.totalTokens !== undefined) {
    parts.push(`${prefix}${shortTokens(usage.totalTokens)} tokens`)
  }
  if (usage.cachedTokens !== undefined && usage.cachedTokens > 0) parts.push(`缓存 ${shortTokens(usage.cachedTokens)}`)
  return parts.join(' · ')
}

function costText(costs: TokenCost[] | undefined): string {
  if (costs === undefined || costs.length === 0) return ''
  return costs.map(formatCost).join(' + ')
}

function requestText(usage: Usage | undefined, durationMs: number | undefined, ttftMs: number | undefined): string {
  const parts = [usageText(usage)]
  if (durationMs !== undefined) parts.push(shortDuration(durationMs))
  if (ttftMs !== undefined) parts.push(`首字 ${shortDuration(ttftMs)}`)
  return parts.filter((part) => part.length > 0).join(' · ')
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
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
      case '--base-url':
        args.baseUrl = value()
        break
      case '--resume':
        args.resume = value()
        break
      case '--trace':
        args.trace = value()
        break
      case '--cwd':
        args.cwd = value()
        break
      case '--once':
        args.once = value()
        break
      case '--auto':
        args.approval = 'auto'
        break
      case '--deny':
        args.approval = 'deny'
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
  output.write(
    [
      'oarlock — a general-purpose agent runtime you can read end to end',
      '',
      'Usage: oarlock [options]           # dev: node src/cli.ts [options]',
      '',
      '  --provider <deepseek|openai|ollama|mock>  model backend (env AGENT_PROVIDER)',
      '  --model <name>                            model name',
      '  --base-url <url>                          override the provider endpoint',
      '  --resume <session-id>                     continue an existing session',
      '  --trace <session-id>                      print a session trace and exit',
      '  --cwd <dir>                               working directory (default: cwd)',
      '  --once "<prompt>"                         run one turn, print it, exit',
      '  --auto                                    allow writes/execs without asking',
      '  --deny                                    refuse writes/execs',
      '  --help                                    show this text',
      '',
      'Inside the REPL: /help /new /sessions /resume <id> /rename <title> /fork [keep] [--restore] /delete <id> /memory [name] /forget <name> /agents /exit',
      '',
    ].join('\n'),
  )
}

function printCommands(): void {
  output.write(
    [
      color(90, '  /new            开一个新会话'),
      color(90, '  /sessions       列出最近会话'),
      color(90, '  /resume <id>    继续指定会话'),
      color(90, '  /rename <title> 重命名当前会话（留空恢复自动标题）'),
      color(90, '  /fork [keep]    从当前会话分支（保留前 keep 条，默认全部）'),
      color(90, '                  加 --restore 同时把文件回滚到该条消息之前（需 keep）'),
      color(90, '  /delete <id>    删除指定会话（不能删除当前会话）'),
      color(90, '  /trace          打印当前会话的轨迹'),
      color(90, '  /memory [name]  列出跨会话记忆（给 name 看正文）'),
      color(90, '  /forget <name>  删除一条记忆'),
      color(90, '  /agents         列出可委派的子 agent 预设（内置 + .agent/agents/*.md）'),
      color(90, '  /exit           退出'),
      '',
    ].join('\n'),
  )
}

function printSessions(store: SessionStore): void {
  const sessions = store.list().slice(0, 10)
  if (sessions.length === 0) {
    output.write(color(90, '  还没有会话\n'))
    return
  }
  for (const session of sessions) {
    const usage = usageText(session.usage)
    const cost = costText(session.usage.costs)
    output.write(
      `  ${color(36, session.id)}  ${session.title}  ${color(90, `${session.model} · ${session.messages} 条 · ${session.turns} 轮${usage.length > 0 ? ` · ${usage}` : ''}${cost.length > 0 ? ` · ${cost}` : ''} · ${session.updatedAt}`)}\n`,
    )
  }
}

/** Cross-session notes: `/memory` lists them, `/memory <name>` prints one. */
function printMemory(cwd: string, name: string): void {
  const store = memoryStore(cwd)
  if (name.length === 0) {
    const entries = store.list()
    if (entries.length === 0) {
      output.write(color(90, `  还没有记忆，让 agent「记住…」即可写入 ${MEMORY_RELATIVE_DIR}/\n`))
      return
    }
    for (const entry of entries) {
      output.write(
        `  ${color(36, entry.name)}  ${color(90, entry.kind)}  ${entry.description}\n`,
      )
    }
    output.write(color(90, `  共 ${entries.length} 条 · /memory <name> 看正文\n`))
    return
  }
  const entry = store.read(name)
  if (entry === undefined) {
    output.write(color(33, `  没有名为 ${name} 的记忆\n`))
    return
  }
  output.write(color(90, `  ${entry.kind} · ${entry.updatedAt}\n`))
  output.write(`${entry.body}\n`)
}

/** Routable subagent presets: built-in plus `.agent/agents/*.md` in this workspace. */
function printAgents(cwd: string): void {
  const presets = subagentPresets(cwd)
  const fromFiles = presets.filter((preset) => preset.source !== 'builtin')
  if (fromFiles.length === 0) {
    output.write(color(90, `  只有内置预设；在 ${SUBAGENT_RELATIVE_DIR}/ 放一个 .md 就能加自己的（frontmatter: name/description/tools/model，正文是角色说明）\n`))
  }
  for (const preset of presets) {
    const details = [
      preset.tools !== undefined ? `tools: ${preset.tools.join(' ')}` : 'tools: 继承父级',
      preset.model !== undefined ? `model: ${preset.model}` : undefined,
      preset.source !== 'builtin' ? preset.source : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' · ')
    output.write(`  ${color(36, preset.name)}  ${preset.description}\n`)
    output.write(color(90, `      ${details}\n`))
  }
  output.write(color(90, `  共 ${presets.length} 个 · task 工具用 agent 参数选一个\n`))
}

/** Render streamed events for a terminal; approval prompts are handled by the gate. */
function createRenderer(): { render: (event: AgentEvent) => void; endLine: () => void } {
  let lineOpen = false
  const write = (text: string): void => {
    if (text.length === 0) return
    output.write(text)
    lineOpen = !text.endsWith('\n')
  }
  const endLine = (): void => {
    if (!lineOpen) return
    output.write('\n')
    lineOpen = false
  }

  const render = (event: AgentEvent): void => {
    switch (event.type) {
      case 'text-delta':
        write(event.text)
        break
      case 'reasoning-delta':
        write(color(90, event.text))
        break
      case 'tool-call':
        endLine()
        write(`${color(36, '→')} ${event.name} ${color(90, compact(event.arguments, 140))}\n`)
        break
      case 'tool-result': {
        endLine()
        const preview = compact(event.content, 180)
        write(`${event.isError === true ? color(31, '✗') : color(32, '✓')} ${color(90, preview)}\n`)
        break
      }
      case 'compaction': {
        endLine()
        const usage = usageText(event.usage)
        write(color(90, `… 上下文压缩 ${event.before} → ${event.after} tokens${usage.length > 0 ? ` · ${usage}` : ''}\n`))
        break
      }
      case 'approval-decision':
        if (!event.allowed) {
          endLine()
          write(color(33, '已拒绝执行\n'))
        } else if (event.remembered === true) {
          endLine()
          write(color(90, '已记住，本会话不再询问\n'))
        }
        break
      case 'ask-answer':
        if (event.answer.status === 'answered') {
          endLine()
          const parts = [...event.answer.selected]
          if (event.answer.other !== undefined && event.answer.other.trim() !== '') parts.push(event.answer.other.trim())
          write(color(36, `→ 回答: ${parts.join('; ')}\n`))
        } else {
          endLine()
          write(color(90, '→ 问题已跳过\n'))
        }
        break
      case 'retry':
        endLine()
        write(color(33, `… 重试 ${event.attempt}（${event.delayMs}ms${event.retryAfterMs !== undefined ? '，含服务端 Retry-After' : ''}）：${event.message}\n`))
        break
      case 'subagent-start':
        endLine()
        write(color(35, `┌ 子 agent：${event.description}\n`))
        break
      case 'subagent-end':
        endLine()
        write(color(35, `└ 子 agent ${event.ok ? '完成' : '失败'}\n`))
        break
      case 'error':
        endLine()
        write(`${color(31, '✗')} ${event.message}\n`)
        break
      case 'turn-end': {
        endLine()
        if (event.status === 'budget') write(`${color(33, '⚠')} 已达本轮预算上限，停止继续执行。\n`)
        const usage = usageText(event.usage)
        const duration = shortDuration(event.durationMs)
        write(
          color(
            90,
            `… ${event.steps} 步${usage.length > 0 ? ` · ${usage}` : ''}${duration.length > 0 ? ` · ${duration}` : ''}${event.status === 'budget' ? ' · 预算收尾' : ''}\n`,
          ),
        )
        break
      }
      default:
        break
    }
  }

  return { render, endLine }
}

function printTrace(session: Session): void {
  const records = session.readTrace()
  if (records.length === 0) {
    output.write(color(90, '这个会话还没有轨迹\n'))
    return
  }

  const totals = summarizeTrace(records)
  const cost = costText(totals.costs)
  output.write(
    color(1, `session ${session.id}`) +
      color(90, ` · ${records.length} 条记录 · ${totals.requests} 请求 · ${usageText(totals)}${cost.length > 0 ? ` · ${cost}` : ''}\n`),
  )
  let turn = 0
  let request = 0
  let depth = 0

  for (const record of records) {
    const event = record.event
    const level = event.depth ?? depth
    const indent = '  '.repeat(Math.max(0, level))
    switch (event.type) {
      case 'turn-start':
        turn += 1
        output.write(
          `\n${color(1, `第 ${turn} 轮`)} ${color(90, new Date(record.at).toLocaleTimeString())}` +
            `  ${color(36, '用户')} ${color(90, compact(event.input, 120))}\n`,
        )
        break
      case 'step-start':
        request += 1
        output.write(color(90, `  ${indent}请求 #${request}（step ${event.step}）\n`))
        break
      case 'assistant': {
        const who = level > 0 ? '子助手' : '助手'
        const label = color(level > 0 ? 35 : 32, who)
        const metrics = requestText(event.usage, event.durationMs, event.ttftMs)
        if (event.text.trim().length > 0) {
          output.write(`  ${indent}${label} ${color(90, compact(event.text, 160))}${metrics.length > 0 ? color(90, `  · ${metrics}`) : ''}\n`)
        } else if (event.toolCalls > 0) {
          output.write(`  ${indent}${label}（仅工具调用）${metrics.length > 0 ? color(90, `  · ${metrics}`) : ''}\n`)
        }
        break
      }
      case 'turn-end': {
        const metrics = requestText(event.usage, event.durationMs, undefined)
        output.write(color(90, `  ${indent}─ ${event.steps} 步${metrics.length > 0 ? ` · ${metrics}` : ''}${event.status === 'budget' ? ' · 预算' : ''}\n`))
        break
      }
      case 'tool-call':
        output.write(`  ${indent}${color(36, '→')} ${event.name} ${color(90, compact(event.arguments, 110))}\n`)
        break
      case 'tool-result':
        output.write(
          `  ${indent}${event.isError ? color(31, '✗') : color(32, '✓')} ${color(90, compact(event.content, 140))}\n`,
        )
        break
      case 'subagent-start':
        output.write(`  ${indent}${color(35, '┌')} 子 agent：${event.description}\n`)
        depth += 1
        break
      case 'subagent-end':
        output.write(`  ${indent}${color(35, '└')} 子 agent ${event.ok ? '完成' : '失败'}\n`)
        depth = Math.max(0, depth - 1)
        break
      case 'retry':
        output.write(`  ${indent}${color(33, '↻')} 重试 #${event.attempt}（${event.delayMs}ms${event.retryAfterMs !== undefined ? '，含服务端 Retry-After' : ''}）\n`)
        break
      case 'compaction': {
        const usage = usageText(event.usage)
        const duration = shortDuration(event.durationMs)
        output.write(
          `  ${indent}${color(90, '⇣')} 压缩 ${event.before} → ${event.after} tokens` +
            `${usage.length > 0 ? ` · ${usage}` : ''}${duration.length > 0 ? ` · ${duration}` : ''}\n`,
        )
        break
      }
      case 'approval-request':
        output.write(`  ${indent}${color(33, '?')} ${event.summary}\n`)
        break
      case 'approval-decision':
        output.write(`  ${indent}${event.allowed ? color(32, '✓ 允许') : color(31, '✗ 拒绝')}\n`)
        break
      case 'ask-request':
        output.write(`  ${indent}${color(36, '?')} ${compact(event.question, 110)}\n`)
        break
      case 'ask-answer':
        if (event.answer.status === 'answered') {
          const parts = [...event.answer.selected]
          if (event.answer.other !== undefined && event.answer.other.trim() !== '') parts.push(event.answer.other.trim())
          output.write(`  ${indent}${color(32, '✓ 回答')} ${compact(parts.join('; '), 90)}\n`)
        } else {
          output.write(`  ${indent}${color(90, '— 跳过')}\n`)
        }
        break
      case 'todo':
        output.write(`  ${indent}${color(36, '☰')} 计划 ${summarizeTodos(event.todos)}\n`)
        break
      case 'error':
        output.write(`  ${indent}${color(31, '✗')} ${event.message}\n`)
        break
      default:
        break
    }
  }
  output.write(color(90, `  ── 会话累计 ${usageText(totals)} · ${totals.requests} 请求${totals.estimated ? ' · 含估算' : ''}\n\n`))
}

async function runTurn(agent: Agent, prompt: string, signal?: AbortSignal): Promise<void> {
  for await (const _event of agent.run(prompt, signal)) {
    // Rendering happens through the onEvent hook; iteration drives the loop.
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    printHelp()
    return
  }

  const cwd = resolve(args.cwd ?? process.cwd())
  loadDotEnv(cwd)
  const config = resolveConfig({
    cwd,
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
    ...(args.approval !== undefined ? { approval: args.approval } : {}),
  })

  if (args.trace !== undefined) {
    const traceStore = new SessionStore(config.sessionsDir)
    try {
      printTrace(traceStore.open(args.trace))
    } catch (error) {
      output.write(`${color(31, '✗')} ${(error as Error).message}\n`)
      process.exitCode = 1
    }
    return
  }

  const store = new SessionStore(config.sessionsDir)
  const mcp = await loadMcpServers(config.cwd)
  if (mcp.servers.length > 0) output.write(`${color(90, `MCP: ${mcp.servers.join(', ')}`)}\n`)
  for (const error of mcp.errors) output.write(`${color(33, '⚠')} MCP ${error}\n`)
  process.once('exit', () => {
    void mcp.close()
  })
  let session: Session
  try {
    session =
      args.resume !== undefined
        ? store.open(args.resume)
        : store.create({ cwd: config.cwd, provider: config.provider, model: config.model })
  } catch (error) {
    output.write(`${color(31, '✗')} 无法打开会话: ${(error as Error).message}\n`)
    process.exitCode = 1
    return
  }

  const rl = createInterface({ input, output })
  const renderer = createRenderer()

  const gate =
    config.approval === 'auto'
      ? autoApproval()
      : config.approval === 'deny'
        ? denyApproval()
        : ruleApproval(
            async (request) => {
              renderer.endLine()
              output.write(`\n${color(33, '⚠')} ${request.summary}\n`)
              if (request.detail !== undefined) output.write(color(90, `  ${compact(request.detail, 400)}\n`))
              const answer = (await rl.question('  允许执行? [y/N] ')).trim().toLowerCase()
              return answer === 'y' || answer === 'yes' ? 'allow' : 'deny'
            },
            // Rules approved with "always" in the web UI apply here too.
            permissionRules(config.cwd),
          )

  const askGate =
    process.stdin.isTTY === true
      ? promptAsk(async (request) => {
          renderer.endLine()
          output.write(`\n${color(33, '?')} ${request.question}\n`)
          request.options.forEach((option, index) => {
            const recommended = option.recommended === true ? ` ${color(90, '(推荐)')}` : ''
            output.write(`  ${index + 1}) ${option.label}${recommended}\n`)
            if (option.description !== undefined) output.write(color(90, `     ${option.description}\n`))
          })
          output.write(color(90, `  ${request.multiSelect ? '可多选' : '单选'}；多个用逗号分隔，回车跳过\n`))
          const answer = (await rl.question('  回答: ')).trim()
          if (answer === '') return { status: 'skipped' }
          const indices = answer.split(/[,，\s]+/).map((part) => Number.parseInt(part, 10) - 1)
          const selected = [...new Set(
            indices
              .filter((index) => Number.isInteger(index) && index >= 0 && index < request.options.length)
              .map((index) => request.options[index]?.label ?? ''),
          )]
          if (selected.length === 0) return { status: 'skipped' }
          return { status: 'answered', selected }
        })
      : skipAsks()

  let runtime: Runtime = createRuntime(config, session, { approval: gate, ask: askGate, onEvent: renderer.render, extraTools: mcp.tools })

  output.write(`${color(1, 'oarlock')} ${color(90, describeConfig(config))}\n`)
  output.write(color(90, `cwd ${config.cwd} · session ${session.id} · /help 查看命令\n\n`))

  if (args.once !== undefined) {
    await runTurn(runtime.agent, args.once)
    renderer.endLine()
    rl.close()
    return
  }

  let currentAbort: AbortController | undefined
  process.on('SIGINT', () => {
    if (currentAbort !== undefined) {
      currentAbort.abort()
      currentAbort = undefined
      return
    }
    rl.close()
  })

  for (;;) {
    let line: string
    try {
      line = await rl.question(color(36, '› '))
    } catch {
      break
    }
    const text = line.trim()
    if (text.length === 0) continue

    if (text === '/exit' || text === '/quit') break
    if (text === '/help') {
      printCommands()
      continue
    }
    if (text === '/sessions') {
      printSessions(store)
      continue
    }
    if (text === '/trace') {
      printTrace(session)
      continue
    }
    if (text === '/agents') {
      printAgents(config.cwd)
      continue
    }
    if (text === '/memory' || text.startsWith('/memory ')) {
      printMemory(config.cwd, text.slice('/memory'.length).trim())
      continue
    }
    if (text.startsWith('/forget')) {
      const name = text.slice('/forget'.length).trim()
      if (name.length === 0) {
        output.write(color(90, '用法: /forget <name>，name 见 /memory\n'))
        continue
      }
      const removed = memoryStore(config.cwd).remove(name)
      output.write(
        removed.removed
          ? color(90, `已删除记忆 ${name}\n`)
          : color(33, `${removed.error ?? '删除失败'}\n`),
      )
      continue
    }
    if (text === '/new') {
      session = store.create({ cwd: config.cwd, provider: config.provider, model: config.model })
      runtime = createRuntime(config, session, { approval: gate, ask: askGate, onEvent: renderer.render, extraTools: mcp.tools })
      output.write(color(90, `新会话 ${session.id}\n`))
      continue
    }
    if (text.startsWith('/resume')) {
      const id = text.slice('/resume'.length).trim()
      if (id.length === 0) {
        output.write(color(90, '用法: /resume <session-id>\n'))
        continue
      }
      try {
        session = store.open(id)
        runtime = createRuntime(config, session, { approval: gate, ask: askGate, onEvent: renderer.render, extraTools: mcp.tools })
        output.write(color(90, `继续会话 ${session.id}（${session.messages.length} 条历史）\n`))
      } catch (error) {
        output.write(`${color(31, '✗')} ${(error as Error).message}\n`)
      }
      continue
    }
    if (text.startsWith('/rename')) {
      const title = text.slice('/rename'.length).trim()
      session.rename(title === '' ? undefined : title)
      output.write(color(90, `已重命名会话 ${session.id}：${session.meta.title ?? '（自动标题）'}\n`))
      continue
    }
    if (text.startsWith('/fork')) {
      const tokens = text
        .slice('/fork'.length)
        .trim()
        .split(/\s+/)
        .filter((token) => token !== '')
      const restoreFiles = tokens.includes('--restore')
      const positional = tokens.filter((token) => token !== '--restore')
      let keep: number | undefined
      if (positional.length > 0) {
        const value = Number(positional[0])
        if (positional.length > 1 || !Number.isInteger(value) || value < 0) {
          output.write(color(90, '用法: /fork [keep] [--restore]，keep 为非负整数\n'))
          continue
        }
        keep = value
      }
      if (restoreFiles) {
        if (keep === undefined) {
          output.write(color(90, '/fork --restore 需要 keep：指定要回滚到的消息序号\n'))
          continue
        }
        const checkpoint = checkpointForUserMessage(session.readTrace(), session.messages, keep)
        if (checkpoint === undefined) {
          output.write(color(33, '没有该消息对应的文件快照（旧会话或已压缩），仅分支对话\n'))
        } else {
          const restored = await checkpointManager(config.cwd).restore(checkpoint)
          output.write(
            restored.ok
              ? color(90, `已回滚工作区（${restored.filesChanged ?? 0} 个文件；可用 safety=${restored.safety ?? '?'} 撤销）\n`)
              : color(33, `文件回滚失败：${restored.message ?? '未知原因'}，仅分支对话\n`),
          )
        }
      }
      try {
        session = store.fork(session.id, keep)
        runtime = createRuntime(config, session, { approval: gate, ask: askGate, onEvent: renderer.render, extraTools: mcp.tools })
        output.write(color(90, `分支会话 ${session.id}（${session.messages.length} 条历史）\n`))
      } catch (error) {
        output.write(`${color(31, '✗')} ${(error as Error).message}\n`)
      }
      continue
    }
    if (text.startsWith('/delete')) {
      const id = text.slice('/delete'.length).trim()
      if (id.length === 0) {
        output.write(color(90, '用法: /delete <session-id>\n'))
        continue
      }
      if (id === session.id) {
        output.write(color(90, '不能删除当前会话，请先 /new 再删除\n'))
        continue
      }
      try {
        store.remove(id)
        output.write(color(90, `已删除会话 ${id}\n`))
      } catch (error) {
        output.write(`${color(31, '✗')} ${(error as Error).message}\n`)
      }
      continue
    }
    if (text.startsWith('/')) {
      output.write(color(90, '未知命令，/help 查看\n'))
      continue
    }

    currentAbort = new AbortController()
    try {
      await runTurn(runtime.agent, text, currentAbort.signal)
    } catch (error) {
      output.write(`${color(31, '✗')} ${(error as Error).message}\n`)
    } finally {
      currentAbort = undefined
    }
    renderer.endLine()
    output.write('\n')
  }

  rl.close()
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${(error as Error).message}\n`)
  process.exit(1)
})
