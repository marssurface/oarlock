import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '../tools/types.ts'
import type { PermissionRules } from './rules.ts'

export type ApprovalPrompt = (request: ApprovalRequest & { id: string }) => Promise<ApprovalDecision>

class StaticGate implements ApprovalGate {
  readonly mode: 'auto' | 'deny'
  private readonly decision: ApprovalDecision

  constructor(mode: 'auto' | 'deny', decision: ApprovalDecision) {
    this.mode = mode
    this.decision = decision
  }

  async request(): Promise<ApprovalDecision> {
    return this.decision
  }
}

class PromptGate implements ApprovalGate {
  readonly mode = 'ask' as const
  private readonly prompt: ApprovalPrompt

  constructor(prompt: ApprovalPrompt) {
    this.prompt = prompt
  }

  async request(request: ApprovalRequest & { id: string }): Promise<ApprovalDecision> {
    return this.prompt(request)
  }
}

/**
 * Ask gate that remembers `always` decisions. With a `PermissionRules` store
 * the rules survive restarts (shared per working directory); without one they
 * stay in memory for the lifetime of the gate.
 */
export class RuleApprovalGate implements ApprovalGate {
  readonly mode = 'ask' as const
  private readonly prompt: ApprovalPrompt
  private readonly store: PermissionRules | undefined
  private readonly rules = new Set<string>()

  constructor(prompt: ApprovalPrompt, store?: PermissionRules) {
    this.prompt = prompt
    this.store = store
  }

  ruleCount(): number {
    return this.store?.list().length ?? this.rules.size
  }

  precheck(request: ApprovalRequest & { id: string }): 'allow' | undefined {
    if (request.ruleKey === undefined) return undefined
    const known = this.store === undefined ? this.rules.has(request.ruleKey) : this.store.has(request.ruleKey)
    return known ? 'allow' : undefined
  }

  async request(request: ApprovalRequest & { id: string }): Promise<ApprovalDecision> {
    const decision = await this.prompt(request)
    if (decision === 'always' && request.ruleKey !== undefined) {
      if (this.store === undefined) this.rules.add(request.ruleKey)
      // A failed write still allowed this call; it just will not be remembered.
      else this.store.add(request.ruleKey)
    }
    return decision
  }
}

/** Allow every write/exec call (use only in trusted automation). */
export function autoApproval(): ApprovalGate {
  return new StaticGate('auto', 'allow')
}

/** Refuse every write/exec call. */
export function denyApproval(): ApprovalGate {
  return new StaticGate('deny', 'deny')
}

/** Ask a human for each write/exec call. */
export function promptApproval(prompt: ApprovalPrompt): ApprovalGate {
  return new PromptGate(prompt)
}

/** Ask a human, but honour `always` decisions (persisted when a store is given). */
export function ruleApproval(prompt: ApprovalPrompt, store?: PermissionRules): ApprovalGate {
  return new RuleApprovalGate(prompt, store)
}

export function approvalFor(mode: 'ask' | 'auto' | 'deny', prompt?: ApprovalPrompt): ApprovalGate {
  if (mode === 'auto') return autoApproval()
  if (mode === 'deny') return denyApproval()
  if (prompt === undefined) throw new Error('approval mode "ask" requires a prompt function')
  return promptApproval(prompt)
}
