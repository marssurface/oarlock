import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { emptyHooks, parseHooks } from './core/hooks.ts'
import type { HooksConfig } from './core/hooks.ts'
import { parsePricing } from './core/pricing.ts'
import type { ModelPricing } from './core/pricing.ts'

export type ProviderKind = 'deepseek' | 'openai' | 'ollama' | 'mock'
export type ApprovalMode = 'ask' | 'auto' | 'deny'

export interface AppConfig {
  provider: ProviderKind
  model: string
  baseUrl: string
  apiKey?: string
  maxSteps: number
  /** Optional per-turn token budget; absent means unlimited. */
  maxTurnTokens?: number
  /** Optional per-turn wall-clock budget in ms; absent means unlimited. */
  maxTurnMs?: number
  maxRetries: number
  contextWindow: number
  approval: ApprovalMode
  /** How many `task` delegations one turn may run at once. */
  maxConcurrentSubagents: number
  cwd: string
  sessionsDir: string
  allowShell: boolean
  temperature: number
  maxTokens: number
}

/** User-editable overrides persisted in `.agent/settings.json`. */
export interface SettingsPatch {
  provider?: ProviderKind
  model?: string
  baseUrl?: string
  /** null removes the stored key; undefined leaves it untouched. */
  apiKey?: string | null
  /** The full enabled list; writing it replaces the previous one. */
  models?: EnabledModel[]
}

/** A model the user configured and enabled; the composer switcher lists these. */
export interface EnabledModel {
  provider: ProviderKind
  baseUrl: string
  model: string
  /** Context window in tokens; absent means unknown. */
  contextWindow?: number
  /** Max output tokens; absent means unknown. */
  maxOutputTokens?: number
  /** Supported input modalities; absent means text-only. */
  input?: Array<'text' | 'image'>
  /** Per-1M-token prices used for cost accounting; absent means "not priced". */
  pricing?: ModelPricing
}

const PROVIDER_DEFAULTS: Record<ProviderKind, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
  mock: { baseUrl: 'http://mock.invalid/v1', model: 'mock-1' },
}

export const PROVIDER_KINDS: ProviderKind[] = ['deepseek', 'openai', 'ollama', 'mock']

export function providerDefaults(provider: ProviderKind): { baseUrl: string; model: string } {
  return PROVIDER_DEFAULTS[provider]
}

function settingsFile(cwd: string): string {
  return resolve(cwd, '.agent/settings.json')
}

function keysFile(cwd: string): string {
  return resolve(cwd, '.agent/keys.json')
}

function hooksFile(cwd: string): string {
  return resolve(cwd, '.agent/hooks.json')
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/** The endpoint is the key's identity: switching vendors must not reuse a key. */
export function readKeys(cwd: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(keysFile(cwd), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const keys: Record<string, string> = {}
    for (const [endpoint, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') continue
      const url = normalizeBaseUrl(endpoint)
      const key = value.trim()
      if (url !== '' && key !== '') keys[url] = key
    }
    return keys
  } catch {
    return {}
  }
}

/** Persist or remove the key for one endpoint; null deletes it. */
export function writeKey(cwd: string, baseUrl: string, apiKey: string | null): void {
  const endpoint = normalizeBaseUrl(baseUrl)
  if (endpoint === '') return
  const keys = readKeys(cwd)
  if (apiKey === null || apiKey.trim() === '') delete keys[endpoint]
  else keys[endpoint] = apiKey.trim()
  const file = keysFile(cwd)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Read the settings file; malformed or unknown fields are ignored. */
export function readSettings(cwd: string): SettingsPatch {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile(cwd), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const raw = parsed as Record<string, unknown>
    const settings: SettingsPatch = {}
    const provider = typeof raw['provider'] === 'string' ? raw['provider'] : undefined
    if (provider !== undefined && (PROVIDER_KINDS as string[]).includes(provider)) settings.provider = provider as ProviderKind
    const model = typeof raw['model'] === 'string' ? raw['model'].trim() : ''
    if (model !== '') settings.model = model
    const baseUrl = typeof raw['baseUrl'] === 'string' ? raw['baseUrl'].trim().replace(/\/+$/, '') : ''
    if (baseUrl !== '') settings.baseUrl = baseUrl
    const apiKey = typeof raw['apiKey'] === 'string' ? raw['apiKey'].trim() : ''
    if (apiKey !== '') settings.apiKey = apiKey
    const models = parseEnabledModels(raw['models'])
    if (models.length > 0) settings.models = models
    return settings
  } catch {
    return {}
  }
}

function parseEnabledModels(value: unknown): EnabledModel[] {
  if (!Array.isArray(value)) return []
  const models: EnabledModel[] = []
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const provider = typeof entry['provider'] === 'string' ? entry['provider'] : ''
    const baseUrl = typeof entry['baseUrl'] === 'string' ? entry['baseUrl'].trim().replace(/\/+$/, '') : ''
    const model = typeof entry['model'] === 'string' ? entry['model'].trim() : ''
    if (!(PROVIDER_KINDS as string[]).includes(provider) || baseUrl === '' || model === '') continue
    if (models.some((existing) => existing.baseUrl === baseUrl && existing.model === model)) continue
    const parsed: EnabledModel = { provider: provider as ProviderKind, baseUrl, model }
    const contextWindow = entry['contextWindow']
    if (typeof contextWindow === 'number' && Number.isInteger(contextWindow) && contextWindow > 0) parsed.contextWindow = contextWindow
    const maxOutputTokens = entry['maxOutputTokens']
    if (typeof maxOutputTokens === 'number' && Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) parsed.maxOutputTokens = maxOutputTokens
    const input = entry['input']
    if (Array.isArray(input)) {
      const modalities = input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
      parsed.input = [...new Set(modalities)]
    }
    const pricing = parsePricing(entry['pricing'])
    if (pricing !== undefined) parsed.pricing = pricing
    models.push(parsed)
  }
  return models
}

export function readEnabledModels(cwd: string): EnabledModel[] {
  return readSettings(cwd).models ?? []
}

/** Read `.agent/hooks.json`; a missing or malformed file means no hooks. */
export function readHooks(cwd: string): HooksConfig {
  try {
    return parseHooks(JSON.parse(readFileSync(hooksFile(cwd), 'utf8')) as unknown)
  } catch {
    return emptyHooks()
  }
}

/** Add a model to the enabled list; an existing entry keeps its place and absorbs defined fields. */
export function enableModel(
  cwd: string,
  entry: EnabledModel,
  options: { clearPricing?: boolean } = {},
): EnabledModel[] {
  const baseUrl = entry.baseUrl.trim().replace(/\/+$/, '')
  const model = entry.model.trim()
  const models = readEnabledModels(cwd)
  if (baseUrl !== '' && model !== '') {
    const normalized: EnabledModel = { provider: entry.provider, baseUrl, model }
    if (entry.contextWindow !== undefined) normalized.contextWindow = entry.contextWindow
    if (entry.maxOutputTokens !== undefined) normalized.maxOutputTokens = entry.maxOutputTokens
    if (entry.input !== undefined) normalized.input = entry.input
    if (entry.pricing !== undefined) normalized.pricing = entry.pricing
    const existing = models.find((item) => item.baseUrl === baseUrl && item.model === model)
    if (existing === undefined) models.push(normalized)
    else {
      Object.assign(existing, normalized)
      if (options.clearPricing === true) delete existing.pricing
    }
    writeSettings(cwd, { models })
  }
  return models
}

/** Drop one model from the enabled list; the active config is left alone. */
export function disableModel(cwd: string, baseUrl: string, model: string): EnabledModel[] {
  const endpoint = baseUrl.trim().replace(/\/+$/, '')
  const name = model.trim()
  const models = readEnabledModels(cwd).filter((existing) => !(existing.baseUrl === endpoint && existing.model === name))
  writeSettings(cwd, { models })
  return models
}

/** Merge a patch into the settings file and return the stored settings. */
export function writeSettings(cwd: string, patch: SettingsPatch): SettingsPatch {
  const previous = readSettings(cwd)
  const next: SettingsPatch = { ...previous, ...patch }
  // Keys live in `.agent/keys.json` keyed by endpoint; migrate the legacy
  // top-level key so old settings files keep working.
  const legacyEndpoint = previous.baseUrl ?? patch.baseUrl ?? ''
  if (previous.apiKey !== undefined && legacyEndpoint !== '') writeKey(cwd, legacyEndpoint, previous.apiKey)
  if (patch.apiKey !== undefined) writeKey(cwd, patch.baseUrl ?? previous.baseUrl ?? '', patch.apiKey)
  if (legacyEndpoint !== '') delete next.apiKey
  const clean: SettingsPatch = {}
  if (next.provider !== undefined) clean.provider = next.provider
  if (next.model !== undefined) clean.model = next.model
  if (next.baseUrl !== undefined) clean.baseUrl = next.baseUrl
  if (next.apiKey !== undefined) clean.apiKey = next.apiKey
  // an emptied list must persist too, otherwise the last removal would reappear
  if (next.models !== undefined) clean.models = next.models
  const file = settingsFile(cwd)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
  return clean
}

/** Minimal .env loader: KEY=VALUE, quotes stripped, existing env wins. */
export function loadDotEnv(cwd: string): void {
  const file = resolve(cwd, '.env')
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined
}

function detectProvider(): ProviderKind {
  const explicit = env('AGENT_PROVIDER')?.toLowerCase()
  if (explicit !== undefined && (PROVIDER_KINDS as string[]).includes(explicit)) return explicit as ProviderKind
  if (env('DEEPSEEK_API_KEY') !== undefined) return 'deepseek'
  if (env('OPENAI_API_KEY') !== undefined) return 'openai'
  return 'mock'
}

function apiKeyFor(provider: ProviderKind): string | undefined {
  if (provider === 'deepseek') return env('DEEPSEEK_API_KEY')
  if (provider === 'openai') return env('OPENAI_API_KEY')
  return undefined
}

function baseUrlFor(provider: ProviderKind): string | undefined {
  if (provider === 'deepseek') return env('DEEPSEEK_BASE_URL')
  if (provider === 'openai') return env('OPENAI_BASE_URL')
  if (provider === 'ollama') return env('OLLAMA_BASE_URL')
  return undefined
}

function intEnv(name: string, fallback: number): number {
  const value = env(name)
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function intEnvZero(name: string, fallback: number): number {
  const value = env(name)
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function optionalIntEnv(name: string): number | undefined {
  const value = env(name)
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function floatEnv(name: string, fallback: number): number {
  const value = env(name)
  if (value === undefined) return fallback
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function resolveConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const cwd = resolve(overrides.cwd ?? process.cwd())
  const settings = readSettings(cwd)
  const provider = overrides.provider ?? settings.provider ?? detectProvider()
  const defaults = PROVIDER_DEFAULTS[provider]
  const approvalRaw = (overrides.approval ?? env('AGENT_APPROVAL') ?? 'ask').toLowerCase()
  const approval: ApprovalMode = approvalRaw === 'auto' || approvalRaw === 'deny' ? approvalRaw : 'ask'
  const allowShell = overrides.allowShell ?? env('AGENT_ALLOW_SHELL') !== '0'
  const baseUrl = (overrides.baseUrl ?? settings.baseUrl ?? baseUrlFor(provider) ?? defaults.baseUrl).replace(/\/+$/, '')
  const legacyKey = (settings.baseUrl ?? baseUrl) === baseUrl ? settings.apiKey : undefined

  return {
    provider,
    model: overrides.model ?? settings.model ?? env('AGENT_MODEL') ?? defaults.model,
    baseUrl,
    apiKey: overrides.apiKey ?? readKeys(cwd)[baseUrl] ?? legacyKey ?? apiKeyFor(provider),
    maxSteps: overrides.maxSteps ?? intEnv('AGENT_MAX_STEPS', 24),
    maxTurnTokens: overrides.maxTurnTokens ?? optionalIntEnv('AGENT_MAX_TURN_TOKENS'),
    maxTurnMs: overrides.maxTurnMs ?? optionalIntEnv('AGENT_MAX_TURN_MS'),
    maxRetries: overrides.maxRetries ?? intEnvZero('AGENT_MAX_RETRIES', 2),
    contextWindow: overrides.contextWindow ?? intEnv('AGENT_CONTEXT_WINDOW', 65536),
    approval: overrides.approval ?? approval,
    maxConcurrentSubagents: overrides.maxConcurrentSubagents ?? intEnv('AGENT_MAX_CONCURRENT_SUBAGENTS', 3),
    cwd,
    sessionsDir: overrides.sessionsDir ?? resolve(cwd, env('AGENT_SESSIONS_DIR') ?? '.agent/sessions'),
    allowShell,
    temperature: overrides.temperature ?? floatEnv('AGENT_TEMPERATURE', 0.3),
    maxTokens: overrides.maxTokens ?? intEnv('AGENT_MAX_TOKENS', 8192),
  }
}

export function describeConfig(config: AppConfig): string {
  const auth = config.apiKey === undefined ? 'no key' : 'key set'
  return `${config.provider}/${config.model} · ${config.baseUrl} · ${auth} · approval=${config.approval}`
}
