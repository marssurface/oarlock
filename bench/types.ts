import type { AgentEvent } from '../src/core/events.ts'
import type { MockScript } from '../src/providers/mock.ts'
import type { ChatMessage } from '../src/providers/types.ts'
import type { ToolRegistry } from '../src/tools/registry.ts'

export interface BenchContext {
  /** Fresh temporary workspace the task ran in. */
  dir: string
  /** Every event of the turn, including nested subagent tool activity. */
  events: AgentEvent[]
  /** Text of the final `turn-end`, empty when the turn failed. */
  answer: string
  /** Conversation without the system prompt. */
  messages: ChatMessage[]
}

export interface BenchTask {
  id: string
  title: string
  /** User message handed to the agent. */
  prompt: string
  /** Multi-turn tasks: inputs run in order on the same conversation. */
  turns?: string[]
  /** Create fixtures before the turn. */
  setup?(dir: string): void | Promise<void>
  /** Seed the conversation before the prompt (used by the compaction task). */
  history?: ChatMessage[]
  /** Deterministic stand-in for a model. Unused when `--provider` is passed. */
  script?: MockScript
  /** Runtime-path task that a live model may never trigger; skipped in live mode. */
  scriptOnly?: boolean
  approval?: 'ask' | 'auto' | 'deny'
  maxSteps?: number
  contextWindow?: number
  /** Extra context knobs, e.g. `keepRecent` for the compaction task. */
  contextOptions?: { threshold?: number; keepRecent?: number; maxMessageChars?: number }
  /** Restrict the tool set (defaults to every tool). */
  tools?: ToolRegistry
  /** Abort the turn as soon as the model streams its first delta. */
  abortAfterFirstDelta?: boolean
  /** The turn is expected to end with an error event; do not fail the task for it. */
  expectError?: boolean
  /** Throw to fail the task. */
  verify(ctx: BenchContext): void | Promise<void>
}

export interface BenchResult {
  id: string
  title: string
  ok: boolean
  durationMs: number
  error?: string
  /** Extra line printed under the result, e.g. the recorded transcript path. */
  note?: string
}
