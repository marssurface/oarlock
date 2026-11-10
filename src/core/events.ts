import type { Usage } from '../providers/types.ts'
import type { TokenCost } from './pricing.ts'
import type { AskAnswer, AskOption } from '../tools/types.ts'
import type { TodoItem } from '../tools/todo.ts'

/** Every event carries the agent depth that produced it (0 = main, 1+ = subagent). */
export interface EventMeta {
  depth?: number
}

/** Everything the UI needs to render one agent turn, in order. */
export type AgentEvent = EventMeta &
  (
    | {
        type: 'turn-start'
        input: string
        /** Number of inline images attached to the turn. */
        attachments?: number
        /** Shadow-git snapshot taken before this turn (workspace checkpoint). */
        checkpoint?: string
      }
    | { type: 'step-start'; step: number }
    | {
        type: 'assistant'
        step: number
        text: string
        toolCalls: number
        /** Usage for this provider request, when the provider reported it. */
        usage?: Usage
        /** Model that answered this request. */
        model?: string
        /** Step start → stream done, including retries. */
        durationMs?: number
        /** Step start → first token of this request. */
        ttftMs?: number
      }
    | { type: 'text-delta'; text: string }
    | { type: 'reasoning-delta'; text: string }
    | { type: 'tool-call'; id: string; name: string; arguments: string }
    | { type: 'tool-result'; id: string; name: string; content: string; isError: boolean }
    | { type: 'approval-request'; id: string; tool: string; summary: string; detail?: string }
    | { type: 'approval-decision'; id: string; allowed: boolean; remembered?: boolean }
    | {
        type: 'ask-request'
        id: string
        /** The tool call this question belongs to, so the UI can replace its activity row. */
        callId: string
        question: string
        header?: string
        options: AskOption[]
        multiSelect: boolean
        allowOther: boolean
      }
    | { type: 'ask-answer'; id: string; answer: AskAnswer }
    | { type: 'todo'; todos: TodoItem[] }
    | { type: 'retry'; attempt: number; delayMs: number; message: string; retryAfterMs?: number }
    | { type: 'subagent-start'; id: string; description: string }
    | { type: 'subagent-end'; id: string; ok: boolean }
    | {
        type: 'usage'
        usage: Usage
        /** Agent step the request belongs to (absent for compactions). */
        step?: number
        /** Why the request ran; `turn` is a model answer, `compaction` a summary call. */
        purpose?: 'turn' | 'compaction'
        model?: string
        durationMs?: number
        ttftMs?: number
        attempts?: number
        /** Estimated price for this request; absent when the model has no pricing. */
        cost?: TokenCost
      }
    | {
        type: 'compaction'
        before: number
        after: number
        summary: string
        /** Tokens consumed by the summary request itself. */
        usage?: Usage
        durationMs?: number
      }
    | {
        type: 'turn-end'
        steps: number
        usage: Usage
        text: string
        durationMs?: number
        status?: 'ok' | 'error' | 'aborted' | 'budget'
      }
    | { type: 'error'; message: string }
  )
