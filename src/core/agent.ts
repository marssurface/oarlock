import { dirname, relative, resolve } from 'node:path'
import type { ChatMessage, ChatProvider, ImagePart, ToolCall, Usage } from '../providers/types.ts'
import { ProviderError } from '../providers/types.ts'
import { messageContent } from '../providers/content.ts'
import type { ToolContext, ToolDefinition, ToolResult } from '../tools/types.ts'
import type { ApprovalGate, AskAnswer, AskGate } from '../tools/types.ts'
import type { AgentEvent } from './events.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { ASK_TOOL_NAME, formatAskAnswer, parseAskArgs } from '../tools/ask.ts'
import { TASK_TOOL_NAME } from '../tools/task.ts'
import { TODO_TOOL_NAME, formatTodoList, parseTodoArgs } from '../tools/todo.ts'
import type { TodoItem } from '../tools/todo.ts'
import { ContextManager, estimateTokens } from './context.ts'
import { describeToolChange } from './diff.ts'
import { Semaphore } from './semaphore.ts'
import { costOf } from './pricing.ts'
import type { ModelPricing } from './pricing.ts'
import { addUsage, estimatedUsage, hasUsage, normalizeUsage, totalTokens } from './usage.ts'
import { buildSystemPrompt } from './prompt.ts'
import { findPreset } from './subagents.ts'
import { emptyHooks, runHooks } from './hooks.ts'
import type { HookOutcome, HooksConfig } from './hooks.ts'

const DEFAULT_MAX_STEPS = 24
const DEFAULT_TOOL_TIMEOUT = 120_000
const DEFAULT_TOOL_OUTPUT = 30_000
/** How many `task` delegations one turn may keep in flight at once. */
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 3

export interface AgentPersistence {
  onMessage(message: ChatMessage): void
  onCompaction?(summary: string, keptMessages: ChatMessage[]): void
}

/** Workspace snapshot taken before each main-agent turn (see core/checkpoint.ts). */
export interface CheckpointHook {
  begin(label?: string): Promise<string | undefined>
}

export interface AgentOptions {
  provider: ChatProvider
  /** Working directory the tools are sandboxed to. */
  cwd: string
  approval: ApprovalGate
  /** Where answers to `ask_user` questions come from; absent means questions fail. */
  ask?: AskGate
  /** PreToolUse / PostToolUse shell hooks; absent means none. */
  hooks?: HooksConfig
  tools?: ToolRegistry
  context?: ContextManager
  contextWindow?: number
  maxSteps?: number
  /** Optional per-turn token budget (input + output, incl. subagents); absent means unlimited. */
  maxTurnTokens?: number
  /** Optional per-turn wall-clock budget in milliseconds; absent means unlimited. */
  maxTurnMs?: number
  temperature?: number
  maxTokens?: number
  /** Send this model name to the provider instead of its default (subagent tiering on the same gateway). */
  modelOverride?: string
  /** Resolve a model's token prices; absent means costs are not recorded. */
  pricing?: (model: string) => ModelPricing | undefined
  maxToolOutputChars?: number
  maxToolTimeoutMs?: number
  /** Retries for transient provider failures before any output arrives (default 2). */
  maxRetries?: number
  /** First retry delay; doubles per attempt (default 500ms). */
  retryDelayMs?: number
  /** How many `task` delegations may run at once when the model asks for several (default 3). */
  maxConcurrentSubagents?: number
  /**
   * One-slot lock that keeps interactive approval prompts serial. Subagents
   * inherit the parent's, so a fan-out can never raise two prompts at once on a
   * UI that shows one card (or a terminal with one readline).
   */
  approvalLock?: Semaphore
  depth?: number
  maxDepth?: number
  systemPrompt?: string
  extraInstructions?: string
  persistence?: AgentPersistence
  /** Snapshot the workspace before each turn; main agent only, never subagents. */
  checkpoint?: CheckpointHook
  /** Observability hook; fires for this agent and every nested subagent. */
  onEvent?: (event: AgentEvent) => void
}

function isAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || (error as Error & { code?: string }).code === 'ABORT_ERR'
}

/** Re-read the signal: control-flow narrowing does not see async aborts. */
function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Transient failures are worth retrying before any output was produced. */
function isTransient(error: unknown): boolean {
  if (error instanceof ProviderError) {
    if (error.status === undefined) return true
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  const code = (error as { code?: string } | null)?.code
  if (typeof code === 'string') {
    return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
  }
  const message = error instanceof Error ? error.message : ''
  return /fetch failed|network|socket hang up|timed? ?out/i.test(message)
}

/** A 400/413 that means the prompt exceeded the model window, not bad input. */
function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false
  if (error.status !== 400 && error.status !== 413) return false
  const text = `${error.message}\n${error.body ?? ''}`
  return /context (length|window)|maximum context|too many tokens|prompt is too long|token limit|reduce the length/i.test(text)
}

/** Upper bound for one retry wait, so a bogus Retry-After cannot stall a turn. */
export const MAX_RETRY_DELAY_MS = 60_000

/** Exponential backoff, raised to the server's Retry-After when that is larger. */
export function computeRetryDelayMs(attempt: number, baseDelayMs: number, retryAfterMs?: number): number {
  const backoffMs = baseDelayMs * 2 ** (attempt - 1)
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(backoffMs, retryAfterMs ?? 0))
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function truncateOutput(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = text.slice(0, Math.max(0, limit - 6000))
  const tail = text.slice(-5000)
  return `${head}\n\n… [tool output truncated: ${text.length - limit} chars omitted] …\n\n${tail}`
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => reject(new Error(`tool timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function summarizeCall(tool: ToolDefinition, args: Record<string, unknown>): string {
  const command = typeof args['command'] === 'string' ? args['command'] : undefined
  const path = typeof args['path'] === 'string' ? args['path'] : undefined
  if (tool.name === 'bash' && command !== undefined) return `bash: ${command.split('\n')[0]?.slice(0, 140) ?? ''}`
  if (path !== undefined) return `${tool.name}: ${path}`
  const keys = Object.keys(args)
  return keys.length > 0 ? `${tool.name}(${keys.join(', ')})` : tool.name
}

/**
 * Calls that cannot disturb each other's state may share a batch: reads are
 * side-effect-free and every `task` delegation gets its own context, so a
 * delegation is batch-eligible whatever its declared risk. `ask_user` and
 * `todo_write` own interactive or plan state, so they stay serial.
 */
function canRunConcurrently(tool: ToolDefinition | undefined): boolean {
  if (tool === undefined) return false
  if (tool.name === ASK_TOOL_NAME || tool.name === TODO_TOOL_NAME) return false
  return tool.name === TASK_TOOL_NAME || tool.risk === 'read'
}

/**
 * Nested events of one batched call, held back until the ordered replay reaches
 * it. Without this, concurrent delegations would interleave their children's
 * activity on the renderer channel and no trace would read as one task.
 */
interface EventRoute {
  pending: AgentEvent[]
}

/** A prompt must reach the user the moment it is raised, or its child waits on a card that never appears. */
function isInteractive(event: AgentEvent): boolean {
  return event.type === 'approval-request' || event.type === 'approval-decision'
}

/** A subagent's activity bubbled to the parent's renderers; its turn plumbing stays local. */
const BUBBLED_SUBAGENT_EVENTS: string[] = [
  'tool-call',
  'tool-result',
  'assistant',
  'usage',
  'compaction',
  'subagent-start',
  'subagent-end',
  'retry',
]

/** Stable identity for `always`: exact bash command, or one directory per write tool. */
function approvalRuleKey(tool: ToolDefinition, args: Record<string, unknown>, cwd: string): string | undefined {
  if (tool.name === 'bash') {
    const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
    return command.length > 0 ? `bash:${command}` : undefined
  }
  if (tool.risk !== 'write') return undefined
  const path = typeof args['path'] === 'string' ? args['path'].trim() : ''
  if (path.length === 0) return `${tool.name}:*`
  const directory = relative(cwd, dirname(resolve(cwd, path)))
  return `${tool.name}:${directory === '' ? '.' : directory}`
}

/**
 * The agent loop: model → tool calls → tool results → model, until a final
 * answer, an abort, or the step budget runs out. All state lives in
 * `messages`, so a turn is reconstructable and a session is resumable.
 */
export class Agent {
  readonly provider: ChatProvider
  readonly tools: ToolRegistry
  readonly context: ContextManager
  readonly approval: ApprovalGate
  readonly cwd: string
  readonly depth: number
  readonly maxDepth: number
  messages: ChatMessage[]

  private readonly askGate: AskGate | undefined
  private readonly systemMessage: ChatMessage
  private readonly maxSteps: number
  private readonly maxTurnTokens: number | undefined
  private readonly maxTurnMs: number | undefined
  private readonly temperature: number | undefined
  private readonly maxTokens: number | undefined
  private readonly modelOverride: string | undefined
  private readonly maxToolOutputChars: number
  private readonly maxToolTimeoutMs: number
  private readonly maxRetries: number
  private readonly retryDelayMs: number
  private readonly persistence: AgentPersistence | undefined
  private readonly onEvent: ((event: AgentEvent) => void) | undefined
  /** AGENTS.md / caller rules; forwarded to subagents so children obey the same project rules. */
  private readonly projectInstructions: string | undefined
  /** Tool-lifecycle shell hooks, inherited by subagents. */
  private readonly hooks: HooksConfig
  private readonly pricing: ((model: string) => ModelPricing | undefined) | undefined
  private approvalCounter = 0
  private askCounter = 0
  /** Caps how many delegations this agent runs at once (a fan-out batch). */
  private readonly subagentSlots: Semaphore
  /** Serialises interactive approval prompts across this agent and its subagents. */
  private readonly approvalLock: Semaphore
  /** The last plan sent through `todo_write`; lives for this Agent instance. */
  private currentTodos: TodoItem[] = []
  /** Usage of descendant agents in the current turn; folded into `turn-end`. */
  private turnNestedUsage: Usage = {}
  /** Workspace snapshots, main agent only (see CheckpointHook). */
  private readonly checkpointHook: CheckpointHook | undefined

  constructor(options: AgentOptions) {
    this.provider = options.provider
    this.tools = options.tools ?? ToolRegistry.default()
    this.context = options.context ?? new ContextManager({ window: options.contextWindow ?? 65536 })
    this.approval = options.approval
    this.askGate = options.ask
    this.cwd = options.cwd
    this.depth = options.depth ?? 0
    this.maxDepth = options.maxDepth ?? 1
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    this.maxTurnTokens = options.maxTurnTokens
    this.maxTurnMs = options.maxTurnMs
    this.temperature = options.temperature
    this.maxTokens = options.maxTokens
    this.modelOverride = options.modelOverride
    this.pricing = options.pricing
    this.maxToolOutputChars = options.maxToolOutputChars ?? DEFAULT_TOOL_OUTPUT
    this.maxToolTimeoutMs = options.maxToolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT
    this.maxRetries = options.maxRetries ?? 2
    this.retryDelayMs = options.retryDelayMs ?? 500
    this.subagentSlots = new Semaphore(options.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS)
    this.approvalLock = options.approvalLock ?? new Semaphore(1)
    this.persistence = options.persistence
    this.onEvent = options.onEvent
    this.checkpointHook = options.checkpoint
    this.projectInstructions = options.extraInstructions
    this.hooks = options.hooks ?? emptyHooks()
    this.systemMessage = {
      role: 'system',
      content:
        options.systemPrompt ??
        buildSystemPrompt({ cwd: options.cwd, tools: this.tools.names(), extra: options.extraInstructions }),
    }
    this.messages = [this.systemMessage]
  }

  /** Replace the conversation (session resume); the system prompt is preserved. */
  setHistory(conversation: ChatMessage[]): void {
    this.messages = [this.systemMessage, ...conversation]
  }

  history(): ChatMessage[] {
    return this.messages.slice(1)
  }

  /** Current plan for renderers that want to show it beside the turn. */
  plan(): TodoItem[] {
    return this.currentTodos
  }

  /** Model name reported for this agent's requests: the override or the provider default. */
  private effectiveModel(): string {
    return this.modelOverride ?? this.provider.model
  }

  async *run(input: string, signal?: AbortSignal, images: ImagePart[] = []): AsyncGenerator<AgentEvent, void, void> {
    // Snapshot before the turn's first message: files are untouched at this
    // point, and subagents inherit the parent's snapshot instead of adding one.
    const checkpoint =
      this.depth === 0 && this.checkpointHook !== undefined
        ? await this.checkpointHook.begin(`turn: ${input.replace(/\s+/g, ' ').slice(0, 60)}`)
        : undefined
    this.appendMessage({ role: 'user', content: messageContent(input, images) })
    yield* this.publish({
      type: 'turn-start',
      input,
      ...(images.length > 0 ? { attachments: images.length } : {}),
      ...(checkpoint !== undefined ? { checkpoint } : {}),
    })

    const startedAt = Date.now()
    const usage: Usage = {}
    this.turnNestedUsage = {}
    let steps = 0
    let lastText = ''
    let overflowAttempts = 0

    for (let step = 1; step <= this.maxSteps; step += 1) {
      if (signal?.aborted === true) {
        yield* this.publish({ type: 'error', message: 'aborted' })
        return
      }
      // Budgets are checked between steps so the current step always finishes
      // cleanly (no dangling tool calls); `steps` is the completed count.
      if (this.budgetExceeded(usage, startedAt)) {
        yield* this.endTurn(usage, steps, lastText, startedAt, 'budget')
        return
      }
      steps = step

      const specs = this.tools.specs()
      if (this.context.needsCompaction(this.messages, specs)) {
        try {
          yield* this.compactContext(signal, usage, step, false)
        } catch (error) {
          if (isAbort(error)) {
            yield* this.publish({ type: 'error', message: 'aborted' })
            return
          }
          // Compaction is an optimisation: keep the full history and carry on.
        }
      }

      yield* this.publish({ type: 'step-start', step })

      const stepStartedAt = Date.now()
      // Used only when the provider reports no usage at all.
      const promptEstimate = this.context.estimate(this.messages, specs)
      let firstTokenAt: number | undefined
      let requestUsage: Usage | undefined
      let attempts = 0
      let text = ''
      let reasoning = ''
      const calls: ToolCall[] = []

      for (let attempt = 1; ; attempt += 1) {
        attempts = attempt
        let produced = false
        try {
          for await (const event of this.provider.stream({
            messages: this.messages,
            tools: specs,
            ...(signal !== undefined ? { signal } : {}),
            ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
            ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
            ...(this.modelOverride !== undefined ? { model: this.modelOverride } : {}),
          })) {
            switch (event.type) {
              case 'text-delta':
                produced = true
                if (firstTokenAt === undefined) firstTokenAt = Date.now()
                text += event.text
                yield* this.publish(event)
                break
              case 'reasoning-delta':
                produced = true
                if (firstTokenAt === undefined) firstTokenAt = Date.now()
                reasoning += event.text
                yield* this.publish(event)
                break
              case 'tool-call':
                produced = true
                if (firstTokenAt === undefined) firstTokenAt = Date.now()
                calls.push(event.call)
                break
              case 'usage':
                requestUsage = normalizeUsage(event.usage)
                break
              case 'done':
                break
            }
          }
          break
        } catch (error) {
          if (isAbort(error)) {
            yield* this.publish({ type: 'error', message: 'aborted' })
            return
          }
          // The heuristic estimate undershot the real window: force one
          // compaction, then retry this step with the shortened history.
          if (isContextOverflow(error) && !produced && overflowAttempts < 1) {
            overflowAttempts += 1
            let compacted = false
            try {
              compacted = yield* this.compactContext(signal, usage, step, true)
            } catch (compactionError) {
              if (isAbort(compactionError)) {
                yield* this.publish({ type: 'error', message: 'aborted' })
                return
              }
            }
            if (compacted) {
              text = ''
              reasoning = ''
              calls.length = 0
              requestUsage = undefined
              firstTokenAt = undefined
              continue
            }
          }
          // Retrying after output started would duplicate text, so only a
          // failure before the first delta is retried.
          const canRetry = !produced && attempt <= this.maxRetries && isTransient(error)
          if (!canRetry) {
            yield* this.publish({ type: 'error', message: `${this.provider.id}: ${(error as Error).message}` })
            return
          }
          const retryAfterMs = error instanceof ProviderError ? error.retryAfterMs : undefined
          const delayMs = computeRetryDelayMs(attempt, this.retryDelayMs, retryAfterMs)
          yield* this.publish({
            type: 'retry',
            attempt,
            delayMs,
            message: (error as Error).message,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          })
          try {
            await delay(delayMs, signal)
          } catch {
            yield* this.publish({ type: 'error', message: 'aborted' })
            return
          }
          text = ''
          reasoning = ''
          calls.length = 0
          requestUsage = undefined
          firstTokenAt = undefined
        }
      }

      const finishedAt = Date.now()
      const durationMs = finishedAt - stepStartedAt
      const ttftMs = firstTokenAt === undefined ? undefined : firstTokenAt - stepStartedAt
      // Every request must leave a token record, even if the gateway omits usage.
      if (!hasUsage(requestUsage)) {
        requestUsage = estimatedUsage(promptEstimate, estimateTokens(text) + estimateTokens(reasoning))
      }
      addUsage(usage, requestUsage)
      const cost = costOf(requestUsage, this.pricing?.(this.effectiveModel()))
      yield* this.publish({
        type: 'usage',
        usage: requestUsage,
        step,
        purpose: 'turn',
        model: this.effectiveModel(),
        durationMs,
        ...(ttftMs !== undefined ? { ttftMs } : {}),
        attempts,
        ...(cost !== undefined ? { cost } : {}),
      })

      const assistant: ChatMessage = {
        role: 'assistant',
        content: text,
        ...(reasoning.length > 0 ? { reasoning } : {}),
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      }
      this.appendMessage(assistant)
      yield* this.publish({
        type: 'assistant',
        step,
        text,
        toolCalls: calls.length,
        usage: requestUsage,
        model: this.effectiveModel(),
        durationMs,
        ...(ttftMs !== undefined ? { ttftMs } : {}),
      })
      if (text.trim().length > 0) lastText = text

      if (calls.length === 0) {
        yield* this.endTurn(usage, steps, text, startedAt, 'ok')
        return
      }

      let index = 0
      while (index < calls.length) {
        const call = calls[index]
        if (call === undefined) break
        if (isSignalAborted(signal)) {
          // Keep the transcript valid: every requested call needs a result,
          // even when the turn is stopped before the remaining ones run.
          const content = `${call.name}: aborted before execution`
          yield* this.publish({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
          this.appendMessage({ role: 'tool', toolCallId: call.id, toolName: call.name, content })
          yield* this.publish({ type: 'tool-result', id: call.id, name: call.name, content, isError: true })
          index += 1
          continue
        }
        if (canRunConcurrently(this.tools.get(call.name))) {
          // A run of consecutive independent calls executes together; results are
          // still appended and published in call order so the transcript stays stable.
          const batch: ToolCall[] = []
          while (index < calls.length && canRunConcurrently(this.tools.get(calls[index]!.name))) {
            batch.push(calls[index]!)
            index += 1
          }
          for (const item of batch) {
            yield* this.publish({ type: 'tool-call', id: item.id, name: item.name, arguments: item.arguments })
          }
          // Several delegations in one batch is a fan-out: hold each call's nested
          // activity and flush in call order, so every one reads as one block.
          const fanout = batch.filter((item) => item.name === TASK_TOOL_NAME).length > 1
          const routes = batch.map<EventRoute | undefined>(() => (fanout ? { pending: [] } : undefined))
          try {
            const settled = await Promise.all(
              batch.map((item, position) => {
                const route = routes[position]
                if (item.name !== TASK_TOOL_NAME) return this.collectTool(item, signal, route)
                // A queued delegation waits for a slot before its own timeout starts.
                return this.subagentSlots.run(() => this.collectTool(item, signal, route))
              }),
            )
            for (let offset = 0; offset < batch.length; offset += 1) {
              const item = batch[offset]!
              const entry = settled[offset]!
              this.flushRoute(routes[offset])
              yield* entry.events
              this.appendMessage({
                role: 'tool',
                toolCallId: item.id,
                toolName: item.name,
                content: entry.result.content,
              })
              yield* this.publish({
                type: 'tool-result',
                id: item.id,
                name: item.name,
                content: entry.result.content,
                isError: entry.result.isError === true,
              })
            }
          } finally {
            // An abort or a throwing call must not strand a delegation's activity.
            for (const route of routes) this.flushRoute(route)
          }
          continue
        }
        yield* this.publish({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
        const result = yield* this.executeTool(call, signal)
        this.appendMessage({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
        })
        yield* this.publish({
          type: 'tool-result',
          id: call.id,
          name: call.name,
          content: result.content,
          isError: result.isError === true,
        })
        index += 1
      }
    }

    yield* this.publish({
      type: 'error',
      message: `stopped after ${this.maxSteps} steps without a final answer`,
    })
  }

  /** Fold nested usage into the turn total and close it with a final status. */
  private *endTurn(
    usage: Usage,
    steps: number,
    text: string,
    startedAt: number,
    status: 'ok' | 'budget',
  ): Generator<AgentEvent, void, void> {
    addUsage(usage, this.turnNestedUsage)
    yield* this.publish({
      type: 'turn-end',
      steps,
      usage,
      text,
      durationMs: Date.now() - startedAt,
      status,
    })
  }

  /** Whether a per-turn budget is spent; token totals include subagent usage. */
  private budgetExceeded(usage: Usage, startedAt: number): boolean {
    if (this.maxTurnMs !== undefined && Date.now() - startedAt >= this.maxTurnMs) return true
    if (
      this.maxTurnTokens !== undefined &&
      totalTokens(usage) + totalTokens(this.turnNestedUsage) >= this.maxTurnTokens
    ) {
      return true
    }
    return false
  }

  /** Compact, persist and account for the summary request. Returns whether it ran. */
  private async *compactContext(
    signal: AbortSignal | undefined,
    usage: Usage,
    step: number,
    force: boolean,
  ): AsyncGenerator<AgentEvent, boolean, void> {
    const startedAt = Date.now()
    const compacted = await this.context.compact(this.messages.slice(1), this.provider, signal, {
      force,
      ...(this.modelOverride !== undefined ? { model: this.modelOverride } : {}),
    })
    if (compacted === undefined) return false
    this.messages = [this.systemMessage, ...compacted.messages]
    this.persistence?.onCompaction?.(compacted.summary, compacted.messages.slice(1))
    if (compacted.usage !== undefined) {
      addUsage(usage, compacted.usage)
      const cost = costOf(compacted.usage, this.pricing?.(this.effectiveModel()))
      yield* this.publish({
        type: 'usage',
        usage: compacted.usage,
        step,
        purpose: 'compaction',
        model: this.effectiveModel(),
        durationMs: compacted.durationMs,
        ...(cost !== undefined ? { cost } : {}),
      })
    }
    yield* this.publish({
      type: 'compaction',
      before: compacted.beforeTokens,
      after: compacted.afterTokens,
      summary: compacted.summary,
      durationMs: Date.now() - startedAt,
      ...(compacted.usage !== undefined ? { usage: compacted.usage } : {}),
    })
    return true
  }

  private async *executeTool(
    call: ToolCall,
    signal?: AbortSignal,
    route?: EventRoute,
  ): AsyncGenerator<AgentEvent, ToolResult, void> {
    const tool = this.tools.get(call.name)
    if (tool === undefined) return { content: `unknown tool: ${call.name}`, isError: true }

    let args: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(call.arguments.trim().length > 0 ? call.arguments : '{}')
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('arguments must be a JSON object')
      }
      args = parsed as Record<string, unknown>
    } catch (error) {
      return { content: `invalid arguments for ${call.name}: ${(error as Error).message}`, isError: true }
    }

    if (call.name === TODO_TOOL_NAME) {
      const parsedTodos = parseTodoArgs(args)
      if ('error' in parsedTodos) return { content: parsedTodos.error, isError: true }
      this.currentTodos = parsedTodos.todos
      yield* this.publish({ type: 'todo', todos: this.currentTodos })
      return { content: formatTodoList(this.currentTodos) }
    }

    if (call.name === ASK_TOOL_NAME) {
      const parsedAsk = parseAskArgs(args)
      if ('error' in parsedAsk) return { content: parsedAsk.error, isError: true }
      if (this.askGate === undefined) {
        return { content: 'ask_user is not available in this context', isError: true }
      }
      const request = parsedAsk.request
      const askId = `q${this.askCounter++}-${Date.now().toString(36)}`
      yield* this.publish({
        type: 'ask-request',
        id: askId,
        callId: call.id,
        question: request.question,
        ...(request.header !== undefined ? { header: request.header } : {}),
        options: request.options,
        multiSelect: request.multiSelect,
        allowOther: request.allowOther,
      })
      let answer: AskAnswer
      try {
        answer = await this.askGate.request({ id: askId, ...request })
      } catch {
        // A broken gate must not stall the loop: treat it as skipped.
        answer = { status: 'skipped' }
      }
      yield* this.publish({ type: 'ask-answer', id: askId, answer })
      return { content: formatAskAnswer(request, answer) }
    }

    const preHook = await runHooks(
      'PreToolUse',
      this.hooks.PreToolUse,
      { tool_name: tool.name, tool_input: args },
      this.cwd,
      signal,
    )
    if (preHook.decision === 'block') {
      return { content: `blocked by PreToolUse hook: ${preHook.reason ?? 'no reason given'}`, isError: true }
    }
    // A PreToolUse "allow" skips the interactive prompt; a hard deny policy still wins.
    const hookApproved = preHook.decision === 'allow' && this.approval.mode !== 'deny'

    if (tool.risk !== 'read' && this.approval.mode !== 'auto' && !hookApproved) {
      if (this.approval.mode === 'deny') {
        return { content: `denied by policy: ${call.name} needs ${tool.risk} permission`, isError: true }
      }
      const approvalId = `a${this.approvalCounter++}-${Date.now().toString(36)}`
      const summary = summarizeCall(tool, args)
      const ruleKey = approvalRuleKey(tool, args, this.cwd)
      const base = {
        id: approvalId,
        tool: tool.name,
        risk: tool.risk,
        summary,
        ...(ruleKey !== undefined ? { ruleKey } : {}),
      }
      // A remembered rule runs silently: no request event, no waiting.
      if (this.approval.precheck?.(base) !== 'allow') {
        let detail = call.arguments.length > 2 ? call.arguments : undefined
        if (tool.risk === 'write') detail = (await describeToolChange(tool.name, args, this.cwd)) ?? detail
        let allowed = false
        let remembered = false
        // One prompt at a time for the whole tree: the web UI has a single
        // approval card and the terminal a single readline, so two open prompts
        // would apply one answer to the wrong request.
        await this.approvalLock.acquire()
        try {
          yield* this.publish(
            {
              type: 'approval-request',
              id: approvalId,
              tool: tool.name,
              summary,
              ...(detail !== undefined ? { detail } : {}),
            },
            route,
          )
          try {
            const decision = await this.approval.request({
              ...base,
              ...(detail !== undefined ? { detail } : {}),
            })
            allowed = decision === 'allow' || decision === 'always'
            remembered = decision === 'always'
          } catch {
            allowed = false
          }
          yield* this.publish(
            {
              type: 'approval-decision',
              id: approvalId,
              allowed,
              ...(remembered ? { remembered: true } : {}),
            },
            route,
          )
        } finally {
          this.approvalLock.release()
        }
        if (!allowed) return { content: `denied by user: ${call.name}`, isError: true }
      }
    }

    const toolContext: ToolContext = {
      cwd: this.cwd,
      ...(signal !== undefined ? { signal } : {}),
      ...(this.depth < this.maxDepth
        ? { spawnSubagent: (input) => this.spawnSubagent(input, route) }
        : {}),
    }

    const timeoutMs = Math.min(tool.timeoutMs ?? this.maxToolTimeoutMs, this.maxToolTimeoutMs)
    const isSubagent = tool.name === TASK_TOOL_NAME
    if (isSubagent) {
      const description = typeof args['description'] === 'string' ? args['description'] : 'subagent'
      yield* this.publish({ type: 'subagent-start', id: call.id, description }, route)
    }
    try {
      const result = await withTimeout(tool.execute(args, toolContext), timeoutMs, signal)
      if (isSubagent) yield* this.publish({ type: 'subagent-end', id: call.id, ok: result.isError !== true }, route)
      const baseContent = truncateOutput(result.content, this.maxToolOutputChars)
      let postHook: HookOutcome = { decision: 'neutral' }
      try {
        postHook = await runHooks(
          'PostToolUse',
          this.hooks.PostToolUse,
          { tool_name: tool.name, tool_input: args, tool_output: baseContent, is_error: result.isError === true },
          this.cwd,
          signal,
        )
      } catch {
        // A broken post hook must not corrupt a successful tool result.
        postHook = { decision: 'neutral' }
      }
      const notes = [preHook.context, postHook.context].filter(
        (note): note is string => note !== undefined && note.trim().length > 0,
      )
      let content = notes.length > 0 ? `${baseContent}\n\n${notes.map((note) => `[hook] ${note}`).join('\n')}` : baseContent
      let isError = result.isError === true
      if (postHook.decision === 'block') {
        isError = true
        content = `${content}\n\nPostToolUse hook flagged a problem: ${postHook.reason ?? 'no reason given'}`
      }
      return { content, isError }
    } catch (error) {
      if (isSubagent) yield* this.publish({ type: 'subagent-end', id: call.id, ok: false }, route)
      const message = isAbort(error) ? 'aborted' : (error as Error).message
      return { content: `${call.name} failed: ${message}`, isError: true }
    }
  }

  /** Run a batched call and keep its events so they can be replayed in call order. */
  private async collectTool(
    call: ToolCall,
    signal?: AbortSignal,
    route?: EventRoute,
  ): Promise<{ events: AgentEvent[]; result: ToolResult }> {
    const iterator = this.executeTool(call, signal, route)
    const events: AgentEvent[] = []
    let next = await iterator.next()
    while (next.done !== true) {
      events.push(next.value)
      next = await iterator.next()
    }
    return { events, result: next.value }
  }

  /**
   * Start one delegation. `route`, when given, belongs to the batched call that
   * owns this child: its bubbled activity waits there until the ordered replay
   * reaches that call, so concurrent delegations report one block each.
   */
  private async spawnSubagent(
    input: {
      description: string
      prompt: string
      agent?: string
      model?: string
      tools?: string[]
      signal?: AbortSignal
    },
    route?: EventRoute,
  ): Promise<string> {
    if (this.depth >= this.maxDepth) throw new Error('maximum subagent depth reached')

    const preset = findPreset(input.agent ?? 'general')
    if (preset === undefined) throw new Error(`unknown agent preset: ${input.agent}`)

    // Least privilege: start from what the parent can actually do (minus the
    // stateful tools the parent owns) and keep only the requested allowlist, so
    // a child can never gain a tool its parent lacks.
    const parentTools = this.tools.without(TASK_TOOL_NAME).without(ASK_TOOL_NAME).without(TODO_TOOL_NAME)
    const allowlist = input.tools ?? preset.tools
    const childTools =
      allowlist === undefined
        ? parentTools
        : new ToolRegistry(parentTools.list().filter((tool) => allowlist.includes(tool.name)))

    // Model tiering on the same gateway: explicit arg, then the preset hint,
    // then inherit the parent's override; undefined keeps the provider default.
    const childModel = input.model ?? preset.model ?? this.modelOverride

    const child = new Agent({
      provider: this.provider,
      cwd: this.cwd,
      approval: this.approval,
      // Same single-prompt lock as the parent and its siblings, so a fan-out of
      // children that all want to write still asks the user one thing at a time.
      approvalLock: this.approvalLock,
      hooks: this.hooks,
      tools: childTools,
      context: new ContextManager(this.context.options),
      maxSteps: this.maxSteps,
      maxDepth: this.maxDepth,
      depth: this.depth + 1,
      // Children inherit the parent's per-turn budgets so a runaway subagent
      // cannot outrun the turn that spawned it.
      ...(this.maxTurnTokens !== undefined ? { maxTurnTokens: this.maxTurnTokens } : {}),
      ...(this.maxTurnMs !== undefined ? { maxTurnMs: this.maxTurnMs } : {}),
      ...(childModel !== undefined ? { modelOverride: childModel } : {}),
      ...(this.pricing !== undefined ? { pricing: this.pricing } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      maxToolOutputChars: this.maxToolOutputChars,
      maxToolTimeoutMs: this.maxToolTimeoutMs,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs,
      systemPrompt: [`${preset.systemPrompt}\n\nTask: ${input.description}`, this.projectInstructions]
        .filter((part) => part !== undefined && part.trim().length > 0)
        .join('\n\n'),
      // The child's usage must reach the parent's turn total even when the
      // parent has no external renderer; its activity is also bubbled up for
      // the trace, while its lifecycle stays owned by the parent's `task` row.
      onEvent: (event: AgentEvent) => {
        if (event.type === 'usage') addUsage(this.turnNestedUsage, event.usage)
        if (this.onEvent === undefined) return
        // A prompt goes out the moment it is raised: the child is already
        // waiting on it, so holding it in a batch would deadlock the fan-out.
        if (isInteractive(event)) {
          this.deliver(event)
          return
        }
        if (!BUBBLED_SUBAGENT_EVENTS.includes(event.type)) return
        if (route === undefined) this.deliver(event)
        else route.pending.push(event)
      },
    })

    let finalText = ''
    for await (const event of child.run(input.prompt, input.signal)) {
      if (event.type === 'turn-end') finalText = event.text
      if (event.type === 'error') throw new Error(`subagent error: ${event.message}`)
    }
    return finalText.length > 0 ? finalText : '(subagent produced no text)'
  }

  private appendMessage(message: ChatMessage): void {
    this.messages.push(message)
    this.persistence?.onMessage(message)
  }

  private *publish(event: AgentEvent, route?: EventRoute): Generator<AgentEvent, void, void> {
    // Stamp the nesting level once, so forwarded child events keep their own.
    const stamped: AgentEvent = event.depth === undefined ? ({ ...event, depth: this.depth } as AgentEvent) : event
    this.deliver(stamped, route)
    yield stamped
  }

  /**
   * Reach the renderers now, unless this call belongs to a fan-out batch and its
   * events are held for the ordered flush. Prompts are never held: a child that
   * cannot ask cannot finish, and the batch would wait on a hidden card.
   */
  private deliver(event: AgentEvent, route?: EventRoute): void {
    if (route !== undefined && !isInteractive(event)) {
      route.pending.push(event)
      return
    }
    try {
      this.onEvent?.(event)
    } catch {
      // A renderer must never break the loop.
    }
  }

  /** Send everything one batched call held back; safe to call twice. */
  private flushRoute(route: EventRoute | undefined): void {
    if (route === undefined) return
    // Splice before delivering: an event handed to a renderer is never replayed.
    for (const event of route.pending.splice(0)) this.deliver(event)
  }
}
