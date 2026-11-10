import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ToolCall } from '../providers/types.ts'
import { imagesOf, textOf } from '../providers/content.ts'
import type { AgentEvent } from '../core/events.ts'
import { addUsage } from '../core/usage.ts'
import type { PriceCurrency, TokenCost } from '../core/pricing.ts'

export interface SessionMeta {
  id: string
  createdAt: string
  cwd: string
  provider: string
  model: string
  title?: string
}

export type SessionRecord =
  | { type: 'meta'; meta: SessionMeta }
  | { type: 'message'; message: ChatMessage }
  | { type: 'compaction'; summary: string }

export interface TraceRecord {
  at: number
  event: AgentEvent
}

/** Token totals derived from a trace: every recorded provider request counts. */
export interface TraceUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  reasoningTokens: number
  /** Number of provider requests in the trace (turns, compactions, subagents). */
  requests: number
  /** True when at least one request carried a runtime estimate instead of provider numbers. */
  estimated: boolean
  /** Billed cost per currency, only when at least one request had a configured price. */
  costs?: TokenCost[]
}

/** Structural events only: streamed text is already in the transcript. */
const TRACE_TYPES = new Set<AgentEvent['type']>([
  'turn-start',
  'step-start',
  'assistant',
  'tool-call',
  'tool-result',
  'approval-request',
  'approval-decision',
  'ask-request',
  'ask-answer',
  'todo',
  'retry',
  'compaction',
  'error',
  'turn-end',
  'usage',
  'subagent-start',
  'subagent-end',
])

const TRACE_CONTENT_LIMIT = 2_000
const TRACE_ARGS_LIMIT = 1_000

function redactEvent(event: AgentEvent): AgentEvent {
  if (event.type === 'assistant' && event.text.length > 4000) {
    return {
      ...event,
      text: `${event.text.slice(0, 4000)}\n… [${event.text.length - 4000} chars omitted from trace]`,
    }
  }
  if (event.type === 'tool-result' && event.content.length > TRACE_CONTENT_LIMIT) {
    return {
      ...event,
      content: `${event.content.slice(0, TRACE_CONTENT_LIMIT)}\n… [${event.content.length - TRACE_CONTENT_LIMIT} chars omitted from trace]`,
    }
  }
  if (event.type === 'tool-call' && event.arguments.length > TRACE_ARGS_LIMIT) {
    return { ...event, arguments: `${event.arguments.slice(0, TRACE_ARGS_LIMIT)}…` }
  }
  if (event.type === 'approval-request' && event.detail !== undefined && event.detail.length > TRACE_CONTENT_LIMIT) {
    return {
      ...event,
      detail: `${event.detail.slice(0, TRACE_CONTENT_LIMIT)}\n… [${event.detail.length - TRACE_CONTENT_LIMIT} chars omitted from trace]`,
    }
  }
  return event
}

export interface SessionSummary {
  id: string
  createdAt: string
  updatedAt: string
  title: string
  cwd: string
  provider: string
  model: string
  messages: number
  turns: number
  usage: TraceUsage
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function parseRecords(text: string): SessionRecord[] {
  const records: SessionRecord[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      records.push(JSON.parse(line) as SessionRecord)
    } catch {
      // A torn final line is expected after a crash; ignore it.
    }
  }
  return records
}

function parseTraceRecords(text: string): TraceRecord[] {
  const records: TraceRecord[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      records.push(JSON.parse(line) as TraceRecord)
    } catch {
      // ignore a torn final line
    }
  }
  return records
}

function readTraceFile(file: string): TraceRecord[] {
  try {
    return parseTraceRecords(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

interface TraceSummaryCacheEntry {
  mtimeMs: number
  size: number
  usage: TraceUsage
  turns: number
}

/**
 * Session listings read every trace, so unchanged files are memoized by
 * (mtime, size): a session that is idle costs one stat, not a full parse.
 */
const traceSummaryCache = new Map<string, TraceSummaryCacheEntry>()

function summarizeTraceFile(file: string): { usage: TraceUsage; turns: number } {
  let stats
  try {
    stats = statSync(file)
  } catch {
    return { usage: summarizeTrace([]), turns: 0 }
  }
  const cached = traceSummaryCache.get(file)
  if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return { usage: cached.usage, turns: cached.turns }
  }
  const records = readTraceFile(file)
  const turns = records.filter((record) => record.event.type === 'turn-start').length
  const usage = summarizeTrace(records)
  traceSummaryCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, usage, turns })
  return { usage, turns }
}

/**
 * Sum usage over the trace. Each provider request emits one `usage` record,
 * including compaction and subagent requests; older traces only have the
 * per-turn `turn-end` aggregate, which is used as a fallback.
 */
export function summarizeTrace(records: TraceRecord[]): TraceUsage {
  const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
  const costs = new Map<PriceCurrency, number>()
  const turnEnds: AgentEvent[] = []
  let requests = 0
  let steps = 0
  for (const record of records) {
    const event = record.event
    if (event.type === 'usage') {
      addUsage(totals, event.usage)
      if (event.cost !== undefined) {
        costs.set(event.cost.currency, (costs.get(event.cost.currency) ?? 0) + event.cost.amount)
      }
      requests += 1
    } else if (event.type === 'step-start') {
      steps += 1
    } else if (event.type === 'turn-end') {
      turnEnds.push(event)
    }
  }
  let estimated = false
  for (const record of records) {
    if (record.event.type === 'usage' && record.event.usage.estimated === true) estimated = true
  }
  if (requests === 0) {
    // Legacy trace without per-request usage: fall back to the turn aggregate.
    for (const event of turnEnds) {
      if (event.type === 'turn-end') {
        addUsage(totals, event.usage)
        if (event.usage.estimated === true) estimated = true
      }
    }
    requests = steps
  }
  return {
    ...totals,
    requests,
    estimated,
    ...(costs.size > 0
      ? { costs: [...costs.entries()].map(([currency, amount]) => ({ currency, amount })) }
      : {}),
  }
}

function summaryMessage(summary: string): ChatMessage {
  return { role: 'system', content: `[Earlier conversation summary]\n${summary}` }
}

const INTERRUPTED_TOOL_RESULT =
  '[oarlock] This tool call was interrupted before it returned a result (the process stopped or the turn was aborted). Treat the action as not completed.'

/**
 * Close a torn turn: an assistant message can survive a crash while its tool
 * results never reached disk, which makes the transcript unusable for the next
 * provider request. Fill those gaps with a synthetic error result and drop
 * orphan tool messages that no assistant call owns.
 */
function repairConversation(messages: ChatMessage[]): { messages: ChatMessage[]; changed: boolean } {
  const repaired: ChatMessage[] = []
  let pending: ToolCall[] = []
  let changed = false

  const flush = (): void => {
    for (const call of pending) {
      repaired.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: INTERRUPTED_TOOL_RESULT,
      })
      changed = true
    }
    pending = []
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      const index = pending.findIndex((call) => call.id === message.toolCallId)
      if (index >= 0) {
        pending.splice(index, 1)
        repaired.push(message)
      } else {
        // The assistant record that owned this result never reached disk.
        changed = true
      }
      continue
    }
    flush()
    repaired.push(message)
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      pending = [...message.toolCalls]
    }
  }
  flush()
  return { messages: repaired, changed }
}

function previewTitle(messages: ChatMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const title = textOf(message.content).replace(/\s+/g, ' ').trim().slice(0, 48)
    if (title.length > 0) return title
    const images = imagesOf(message.content).length
    if (images > 0) return `[${images} 张图片]`
  }
  return undefined
}

/** One append-only JSONL transcript; compaction rewrites it into a fresh baseline. */
export class Session {
  readonly id: string
  readonly file: string
  meta: SessionMeta
  messages: ChatMessage[]

  constructor(file: string, meta: SessionMeta, messages: ChatMessage[]) {
    this.file = file
    this.meta = meta
    this.id = meta.id
    this.messages = messages
  }

  append(message: ChatMessage): void {
    this.messages.push(message)
    appendFileSync(this.file, `${JSON.stringify({ type: 'message', message } satisfies SessionRecord)}\n`, 'utf8')
  }

  /** Path of the append-only trace (one JSON record per structural event). */
  get traceFile(): string {
    return this.file.replace(/\.jsonl$/, '.events.jsonl')
  }

  /** Append one structural event to the trace file; stream deltas are skipped. */
  recordTrace(event: AgentEvent): void {
    if (!TRACE_TYPES.has(event.type)) return
    const record: TraceRecord = { at: Date.now(), event: redactEvent(event) }
    appendFileSync(this.traceFile, `${JSON.stringify(record)}\n`, 'utf8')
  }

  /** Read the trace; a missing file means the session predates tracing. */
  readTrace(): TraceRecord[] {
    return readTraceFile(this.traceFile)
  }

  /** Token totals for this session's trace (live and historical records). */
  traceUsage(): TraceUsage {
    return summarizeTrace(this.readTrace())
  }

  /** Atomically replace the transcript with a fresh baseline. */
  private rewrite(records: SessionRecord[]): void {
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
    renameSync(temporary, this.file)
  }

  /** Persist a repaired conversation (crash/abort recovery) as the new baseline. */
  repair(messages: ChatMessage[]): void {
    this.messages = messages
    this.rewrite([
      { type: 'meta', meta: this.meta },
      ...messages.map((message) => ({ type: 'message', message }) satisfies SessionRecord),
    ])
  }

  /**
   * Change the display title. Renaming rewrites the transcript baseline, but
   * keeps the file's mtime so the sidebar order does not jump.
   */
  rename(title: string | undefined): void {
    const stats = statSync(this.file)
    const meta = { ...this.meta }
    if (title === undefined || title === '') delete meta.title
    else meta.title = title
    this.meta = meta
    this.rewrite([
      { type: 'meta', meta },
      ...this.messages.map((message) => ({ type: 'message', message }) satisfies SessionRecord),
    ])
    utimesSync(this.file, stats.atime, stats.mtime)
  }

  /** Drop the older prefix: rewrite the transcript so resume matches this state. */
  compact(summary: string, kept: ChatMessage[]): void {
    this.messages = [summaryMessage(summary), ...kept]
    this.rewrite([
      { type: 'meta', meta: this.meta },
      { type: 'compaction', summary },
      ...kept.map((message) => ({ type: 'message', message }) satisfies SessionRecord),
    ])
  }
}

export class SessionStore {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  private writeSession(meta: SessionMeta, messages: ChatMessage[]): Session {
    const file = join(this.dir, `${meta.id}.jsonl`)
    const records: SessionRecord[] = [
      { type: 'meta', meta },
      ...messages.map((message) => ({ type: 'message', message }) satisfies SessionRecord),
    ]
    writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
    return new Session(file, meta, messages)
  }

  create(meta: Omit<SessionMeta, 'id' | 'createdAt'>): Session {
    const id = randomId()
    const createdAt = new Date().toISOString()
    return this.writeSession({ ...meta, id, createdAt }, [])
  }

  has(id: string): boolean {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return false
    return existsSync(join(this.dir, `${id}.jsonl`))
  }

  /** Rename a session without moving it in the listing (mtime is preserved). */
  rename(id: string, title: string | undefined): SessionMeta {
    const session = this.open(id)
    session.rename(title)
    return session.meta
  }

  /** Delete the transcript and its trace; unknown ids surface as ENOENT. */
  remove(id: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid session id: ${id}`)
    const file = join(this.dir, `${id}.jsonl`)
    rmSync(file, { force: false })
    rmSync(file.replace(/\.jsonl$/, '.events.jsonl'), { force: true })
    traceSummaryCache.delete(file.replace(/\.jsonl$/, '.events.jsonl'))
  }

  /**
   * Branch a session: copy its first `keep` messages into a fresh transcript.
   * The trace is not copied, so the branch starts with zero usage. An omitted
   * `keep` copies the whole conversation; `keep: 0` starts an empty branch.
   */
  fork(id: string, keep?: number): Session {
    const source = this.open(id)
    const total = source.messages.length
    if (keep !== undefined && (!Number.isInteger(keep) || keep < 0 || keep > total)) {
      throw new RangeError(`keep must be an integer between 0 and ${total}`)
    }
    const prefix = source.messages.slice(0, keep ?? total)
    const fixed = repairConversation(prefix).messages
    const newId = randomId()
    const createdAt = new Date().toISOString()
    const base = source.meta.title ?? previewTitle(source.messages) ?? 'untitled'
    return this.writeSession(
      { ...source.meta, id: newId, createdAt, title: `${base} · 分支` },
      fixed,
    )
  }

  open(id: string): Session {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid session id: ${id}`)
    const file = join(this.dir, `${id}.jsonl`)
    const records = parseRecords(readFileSync(file, 'utf8'))
    const metaRecord = records.find((record) => record.type === 'meta')
    if (metaRecord === undefined || metaRecord.type !== 'meta') throw new Error(`session ${id} has no meta record`)

    const rebuilt: ChatMessage[] = []
    for (const record of records) {
      if (record.type === 'compaction') {
        rebuilt.length = 0
        rebuilt.push(summaryMessage(record.summary))
      } else if (record.type === 'message') {
        rebuilt.push(record.message)
      }
    }
    const session = new Session(file, metaRecord.meta, rebuilt)
    const fixed = repairConversation(rebuilt)
    if (fixed.changed) session.repair(fixed.messages)
    return session
  }

  list(): SessionSummary[] {
    const files = readdirSync(this.dir).filter((name) => name.endsWith('.jsonl'))
    const summaries: SessionSummary[] = []
    for (const name of files) {
      const file = join(this.dir, name)
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const records = parseRecords(text)
      const metaRecord = records.find((record) => record.type === 'meta')
      if (metaRecord === undefined || metaRecord.type !== 'meta') continue
      const messageCount = records.filter((record) => record.type === 'message').length
      let updatedAt = metaRecord.meta.createdAt
      try {
        updatedAt = new Date(statSync(file).mtimeMs).toISOString()
      } catch {
        // keep createdAt
      }
      const firstUser = records.find(
        (record): record is Extract<SessionRecord, { type: 'message' }> =>
          record.type === 'message' && record.message.role === 'user',
      )
      const { usage, turns } = summarizeTraceFile(file.replace(/\.jsonl$/, '.events.jsonl'))
      summaries.push({
        id: metaRecord.meta.id,
        createdAt: metaRecord.meta.createdAt,
        updatedAt,
        title: metaRecord.meta.title ?? (firstUser !== undefined ? previewTitle([firstUser.message]) ?? 'untitled' : 'untitled'),
        cwd: metaRecord.meta.cwd,
        provider: metaRecord.meta.provider,
        model: metaRecord.meta.model,
        messages: messageCount,
        turns,
        usage,
      })
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }
}
