# 成本与聚合

每次请求结束后，运行时按模型配置的单价把当次用量折算成金额，并以**快照**形式写进 `usage` 事件。轨迹、会话列表、CLI 与 Web 都从这些快照聚合成本，不依赖事后重新计价。

范围：按模型配置「输入 / 输出 / 缓存」单价（每百万 tokens），计价货币 USD 或 CNY。不做汇率换算、不内置价目表、不限制预算——预算仍是 `maxTurnTokens` / `maxTurnMs` 的独立能力。

## 数据模型

`src/core/pricing.ts`：

```ts
export type PriceCurrency = 'USD' | 'CNY'

export interface ModelPricing {
  input: number      // 未命中缓存输入，每 1M tokens
  output: number     // 完成 tokens（含推理），每 1M tokens
  cached?: number    // 缓存输入；缺省按 input 价
  currency: PriceCurrency
}

export interface TokenCost {
  amount: number
  currency: PriceCurrency
}
```

`EnabledModel` 增加可选 `pricing?: ModelPricing`，随 `.agent/settings.json` 的 `models[]` 持久化。**没有 `pricing` 的模型不产生成本**，旧配置与旧轨迹完全不受影响。

## 计价算法

```ts
costOf(usage, pricing)
```

1. `promptTokens` 是输入总量，`cachedTokens` 已经被包含在其中，先切出缓存部分：`cached = min(max(cachedTokens, 0), promptTokens)`。
2. 未缓存输入 `input = promptTokens - cached`。
3. `amount = input * pricing.input + cached * (pricing.cached ?? pricing.input) + completionTokens * pricing.output`，再除以 1,000,000。
4. 推理 tokens 已经计入 `completionTokens`，不重复收费。
5. 没有用量字段时按 0 计，返回 `{ amount: 0 }` 而不是缺省。

金额不做四舍五入，展示时才格式化（`formatCost`：≥1 两位小数、≥0.01 三位、更小四位；符号 `$` / `¥`）。

## 配置与校验

`parsePricing(value)` 是唯一的解析入口：

- `input` 与 `output` 必填，必须是有限且 ≥ 0 的数字；否则整块丢弃。
- `cached` 可选，非法时忽略（回退到 `input` 价）。
- `currency` 只认 `'CNY'`，其余一律 `'USD'`。

Web API（`POST /api/settings/enabled`，`POST /api/settings` 同理）：

```jsonc
{
  "provider": "openai",
  "baseUrl": "https://api.example.com/v1",
  "model": "gpt-4.1-mini",
  "pricing": { "input": 0.4, "output": 1.6, "cached": 0.1, "currency": "USD" }
}
```

- 合法 `pricing` 写入/覆盖该模型的单价。
- `"pricing": null` 是显式清除：保存后该模型回到「未计价」。
- 字段缺省或非法：保留已存单价（普通保存不会误清）。
- 只切换激活模型（`POST /api/settings` 且不带 `pricing`）不会改动单价。

`enableModel(cwd, entry, { clearPricing: true })` 是底层清除语义，与 API 的 `pricing: null` 对应。

## Agent 与事件

- `AgentOptions.pricing?: (model: string) => ModelPricing | undefined`。
- `createRuntime` 用 `pricingResolver(readEnabledModels(cwd), config)` 构造解析器：先按模型名匹配，同名模型跨供应商时优先当前激活端点；没有单价的模型返回 `undefined`。
- 每个 `usage` 事件（普通请求与压缩请求）新增可选 `cost: TokenCost`。成本在请求结束时按**当时的模型与单价**落盘，之后改价不会改写历史轨迹。
- 子 agent 继承父级解析器，其请求同样带成本；聚合时与主 agent 一起计入。
- 旧轨迹没有 `cost` 字段：所有展示走 `costs?` 可选分支，渲染保持原样。

## 聚合与展示

`summarizeTrace(records)` 在 `TraceUsage` 上新增可选 `costs?: TokenCost[]`，按货币分别累加（USD 与 CNY 不混算），至少有一条带成本的请求才出现该字段。

| 位置 | 展示 |
| --- | --- |
| 会话列表（Web 侧栏） | 模型用量后追加聚合成本，如 `· $0.0021` |
| 轨迹摘要 | `… · 合计 212 · 成本 $0.0021 · 1.2s` |
| 轨迹明细 | Token 列 tooltip 追加 `· 成本 $0.0009` |
| 轨迹检查器 | 「本次请求 / 压缩请求 / 请求用量 / 本轮 / 会话累计」面板底部一行「成本」 |
| CLI `sessions` | 会话行末尾追加成本 |
| CLI `trace` | 摘要行追加成本 |

设置面板：每个模型的「参数」区新增**单价**块（输入 / 输出 / 缓存 三个数字框 + USD/CNY 选择）。输入或输出留空即视为不记成本，保存时发送 `pricing: null`；已启用列表在模型名旁显示 `$2 / $8` 徽标，悬停可看缓存价。

## 边界

- **快照而非重算**：历史轨迹保持请求发生时的计价；改价只影响之后的请求。
- **单货币聚合**：`costs` 是 `TokenCost[]`，同一会话跨币种时并列显示，不做汇率折算。
- **不内置价目表**：价格由用户填写；供应商调价需手动更新。
- **与预算无关**：`maxTurnTokens` / `maxTurnMs` 是运行时保护，不会因为成本超限而停止。
- **估算用量也有价**：模型未上报用量时，运行时估算的 tokens 同样按配置计价，事件里 `estimated: true` 仍保留。

## 验证

- `node --test test/pricing.test.ts`：计价公式、缓存回退、解析校验、解析器优先级、持久化与清除、设置 API 往返、`usage` 事件快照、轨迹按币种聚合。
- `node --test test/ui.test.ts`：单价回显与清空、已启用列表徽标、轨迹摘要 / 明细 / 检查器成本。
- `pnpm typecheck && node --test test/*.test.ts && npm run build && node bench/run.ts`。
