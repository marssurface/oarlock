import type { AppConfig } from '../config.ts'
import { readEnabledModels, readHooks } from '../config.ts'
import type { ChatProvider } from '../providers/types.ts'
import { createProvider } from '../providers/index.ts'
import { DebugRecordingProvider, recordingTarget } from '../providers/recording.ts'
import type { Session } from '../session/store.ts'
import { ToolRegistry } from '../tools/registry.ts'
import type { ApprovalGate, AskGate, ToolDefinition } from '../tools/types.ts'
import { Agent } from './agent.ts'
import { checkpointDisabled, checkpointManager } from './checkpoint.ts'
import { composeInstructions, readProjectInstructions } from './instructions.ts'
import { pricingResolver } from './pricing.ts'
import { ContextManager } from './context.ts'
import type { AgentEvent } from './events.ts'

export interface RuntimeOptions {
  approval: ApprovalGate
  ask?: AskGate
  onEvent?: (event: AgentEvent) => void
  extraInstructions?: string
  /** Extra tools (e.g. MCP) merged into the default registry; duplicate names are skipped. */
  extraTools?: ToolDefinition[]
}

export interface Runtime {
  config: AppConfig
  provider: ChatProvider
  tools: ToolRegistry
  context: ContextManager
  agent: Agent
}

/** Wire a provider, tool set, agent and transcript together for one session. */
export function createRuntime(config: AppConfig, session: Session, options: RuntimeOptions): Runtime {
  let provider = createProvider(config)
  // Opt-in gateway debugging: dump every raw model call. Subagents and
  // compaction reuse this provider, so they are recorded too.
  const recordDir = recordingTarget(config.cwd)
  if (recordDir !== undefined) provider = new DebugRecordingProvider(provider, recordDir)
  const tools = ToolRegistry.default({ allowShell: config.allowShell })
  for (const tool of options.extraTools ?? []) {
    if (!tools.has(tool.name)) tools.add(tool)
  }
  // The enabled list is the only place per-model window/output metadata lives.
  const enabledModels = readEnabledModels(config.cwd)
  const activeModel = enabledModels.find(
    (entry) => entry.baseUrl === config.baseUrl && entry.model === config.model,
  )
  const pricing = pricingResolver(enabledModels, config)
  const contextWindow = activeModel?.contextWindow ?? config.contextWindow
  const requestMaxTokens =
    activeModel?.maxOutputTokens !== undefined
      ? Math.min(config.maxTokens, activeModel.maxOutputTokens)
      : config.maxTokens
  const context = new ContextManager({ window: contextWindow })
  // AGENTS.md holds the project's standing rules; a caller-supplied instruction
  // (rare) is appended after it so neither gets dropped.
  const instructions = composeInstructions(readProjectInstructions(config.cwd), options.extraInstructions)

  const onEvent = (event: AgentEvent): void => {
    session.recordTrace(event)
    options.onEvent?.(event)
  }

  // Workspace snapshots before each turn: one manager per working directory,
  // shared by every session in this process (and the CLI).
  const checkpointHook = checkpointDisabled()
    ? undefined
    : {
        begin: (label?: string): Promise<string | undefined> =>
          checkpointManager(config.cwd).begin(label !== undefined ? `${session.id} · ${label}` : session.id),
      }

  const agent = new Agent({
    provider,
    tools,
    context,
    cwd: config.cwd,
    approval: options.approval,
    ...(options.ask !== undefined ? { ask: options.ask } : {}),
    ...(checkpointHook !== undefined ? { checkpoint: checkpointHook } : {}),
    hooks: readHooks(config.cwd),
    maxSteps: config.maxSteps,
    ...(config.maxTurnTokens !== undefined ? { maxTurnTokens: config.maxTurnTokens } : {}),
    ...(config.maxTurnMs !== undefined ? { maxTurnMs: config.maxTurnMs } : {}),
    maxRetries: config.maxRetries,
    maxConcurrentSubagents: config.maxConcurrentSubagents,
    pricing,
    temperature: config.temperature,
    maxTokens: requestMaxTokens,
    onEvent,
    ...(instructions !== undefined ? { extraInstructions: instructions } : {}),
    persistence: {
      onMessage: (message) => session.append(message),
      onCompaction: (summary, kept) => session.compact(summary, kept),
    },
  })
  agent.setHistory(session.messages)

  return { config, provider, tools, context, agent }
}
