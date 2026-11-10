import type { JsonSchema, ToolSpec } from '../providers/types.ts'

export type Risk = 'read' | 'write' | 'exec'

export interface ApprovalRequest {
  tool: string
  risk: Risk
  /** One line the UI can show, e.g. `bash: npm test`. */
  summary: string
  /** Command or change preview the user may want to inspect. */
  detail?: string
  /** Stable identity a gate may remember, e.g. the exact bash command or a write directory. */
  ruleKey?: string
}

/** `always` remembers the rule for this gate's lifetime (one web session). */
export type ApprovalDecision = 'allow' | 'deny' | 'always'

/** How risky calls are decided. Read-only tools never consult a gate. */
export interface ApprovalGate {
  readonly mode: 'ask' | 'auto' | 'deny'
  /** Optional silent allow for a remembered rule; skips the approval event entirely. */
  precheck?(request: ApprovalRequest & { id: string }): 'allow' | 'deny' | undefined
  request(request: ApprovalRequest & { id: string }): Promise<ApprovalDecision>
}

export interface AskOption {
  /** Short one-line label. */
  label: string
  /** One line clarifying what choosing this means. */
  description?: string
  /** Mark the option the agent recommends (at most one). */
  recommended?: boolean
}

/** A structured question the agent poses to the user mid-turn. */
export interface AskRequest {
  question: string
  /** Short section title for the question card. */
  header?: string
  options: AskOption[]
  multiSelect: boolean
  allowOther: boolean
}

export type AskAnswer =
  | { status: 'answered'; selected: string[]; other?: string }
  | { status: 'skipped' }

/** Where user answers to `ask_user` come from; the agent awaits one per question. */
export interface AskGate {
  request(request: AskRequest & { id: string }): Promise<AskAnswer>
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface ToolContext {
  cwd: string
  signal?: AbortSignal
  /** Provided by the Agent that owns this tool registry. */
  spawnSubagent?(input: {
    description: string
    prompt: string
    agent?: string
    model?: string
    tools?: string[]
    signal?: AbortSignal
  }): Promise<string>
  log?(message: string): void
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  risk: Risk
  /** Hard upper bound for one call; the agent also applies its own default. */
  timeoutMs?: number
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export function toolSpec(tool: ToolDefinition): ToolSpec {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}
