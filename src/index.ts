/**
 * dock-agent — a small agent runtime written from scratch.
 *
 * Layers, bottom-up:
 *   providers/  model adapters (OpenAI-compatible, mock)
 *   tools/      sandboxed file / shell / delegation tools
 *   core/       agent loop, context compaction, approval gates
 *   session/    append-only JSONL transcripts
 *   cli.ts      terminal REPL
 *   web/        HTTP + SSE server and single-page UI
 */
export { Agent } from './core/agent.ts'
export type { AgentOptions, AgentPersistence } from './core/agent.ts'
export { ContextManager, estimateTokens, DEFAULT_CONTEXT } from './core/context.ts'
export { autoApproval, denyApproval, promptApproval, approvalFor } from './core/approval.ts'
export { buildSystemPrompt } from './core/prompt.ts'
export { readProjectInstructions, composeInstructions } from './core/instructions.ts'
export { emptyHooks, parseHooks, matchesHook, runHooks } from './core/hooks.ts'
export type { HookDef, HooksConfig, HookEvent, HookOutcome, HookCallInfo } from './core/hooks.ts'
export { loadMcpServers, McpClient, McpError, parseMcpConfig, readMcpConfig, emptyMcpConfig } from './mcp/index.ts'
export type { McpConfig, McpServerConfig, McpLoadResult, McpToolInfo, McpCallResult, McpContentBlock } from './mcp/index.ts'
export { costOf, formatCost, parsePricing, pricingResolver } from './core/pricing.ts'
export type { ModelPricing, PriceCurrency, TokenCost } from './core/pricing.ts'
export { SUBAGENT_PROMPT, SUBAGENT_PRESETS, findPreset, presetCatalog } from './core/subagents.ts'
export type { SubagentPreset } from './core/subagents.ts'
export type { AgentEvent } from './core/events.ts'
export { createRuntime } from './core/setup.ts'
export type { Runtime, RuntimeOptions } from './core/setup.ts'

export {
  loadDotEnv,
  resolveConfig,
  describeConfig,
  readSettings,
  writeSettings,
  readKeys,
  writeKey,
  readEnabledModels,
  readHooks,
  enableModel,
  disableModel,
  providerDefaults,
  PROVIDER_KINDS,
} from './config.ts'
export type { AppConfig, ApprovalMode, ProviderKind, SettingsPatch, EnabledModel } from './config.ts'
export { VENDOR_PRESETS } from './web/presets.ts'
export type { VendorPreset } from './web/presets.ts'

export { createProvider, MockProvider, OpenAICompatibleProvider, readSseData, ProviderError } from './providers/index.ts'
export type {
  ChatMessage,
  ChatProvider,
  ContentPart,
  ImagePart,
  JsonSchema,
  MessageContent,
  ProviderEvent,
  ProviderRequest,
  TextPart,
  ToolCall,
  ToolSpec,
  Usage,
} from './providers/types.ts'
export { imageDataUrl, imagesOf, messageContent, textOf } from './providers/content.ts'

export { ToolRegistry } from './tools/registry.ts'
export { fileTools, resolveInside } from './tools/fs.ts'
export { bashTool, runShell } from './tools/bash.ts'
export { taskTool, TASK_TOOL_NAME } from './tools/task.ts'
export type { ApprovalDecision, ApprovalGate, ApprovalRequest, Risk, ToolContext, ToolDefinition, ToolResult } from './tools/types.ts'

export { Session, SessionStore } from './session/store.ts'
export type { SessionMeta, SessionSummary } from './session/store.ts'
