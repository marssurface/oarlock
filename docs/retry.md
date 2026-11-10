# 重试与 Retry-After

瞬时失败（429 / 408 / 5xx、连接类网络错误）在**尚未产生任何输出**时自动重试，默认最多 2 次（`maxRetries`），首次延迟 500ms 逐次翻倍（`retryDelayMs`）。流中途断开不重试，避免重复半截文本——这条语义不变。

本轮补齐的是服务端限速提示：网关返回 `Retry-After` 时，等待时间不再拍脑袋。

## 链路

1. **适配层**（`providers/openai-compatible.ts`）：HTTP 非 2xx 时读取响应头 `Retry-After`，经 `parseRetryAfterMs` 解析后放进 `ProviderError.retryAfterMs`（毫秒，可选字段）。
2. **解析**（`providers/types.ts` 的 `parseRetryAfterMs`）：按 RFC 9110 支持两种取值——
   - `delta-seconds`：非负整数秒，如 `Retry-After: 7` → 7000ms；
   - HTTP-date：仅接受三种标准格式（IMF-fixdate / RFC 850 / asctime），换算为距当前时刻的毫秒数，过去的时间钳到 0。
   - `Date.parse` 过于宽松（连 `-5` 都能当日期），所以先用格式正则把关；缺失、空串、垃圾值一律返回 `undefined`，绝不产生 NaN。
3. **循环**（`core/agent.ts` 的 `computeRetryDelayMs`）：实际延迟 = `max(指数退避, Retry-After)`，再钳到上限 `MAX_RETRY_DELAY_MS = 60s`——恶意或写错的响应头不能把回合挂起一小时。等待期间 abort 信号照常生效。

## 事件与展示

`retry` 事件新增可选字段 `retryAfterMs`（服务端原始建议值）；`delayMs` 始终是最终等待时长。旧轨迹没有该字段，行为不变。CLI REPL、CLI 轨迹与 Web 对话/检查器在含服务端建议时标注「含服务端 Retry-After」。

## 边界

- 只有 `ProviderError` 携带 `retryAfterMs`；其它可重试错误（网络码、fetch failed）仍走纯指数退避。
- 上下文溢出（400/413）走强制压缩重试，与限速重试是两条独立路径，互不叠加。
- 上限 60s 是 harness 的自保值：若服务端要求等更久，重试大概率再次 429，耗尽预算后正常报错，而不是无限等待。

## 验证

- `test/provider.test.ts`：`parseRetryAfterMs` 的秒数 / 三种日期格式 / 过去时间 / 垃圾值；429 带头与 503 不带头的透传。
- `test/retry.test.ts`：`computeRetryDelayMs` 的取大与封顶（纯函数，不真等）；429 + `retryAfterMs` 的端到端等待与事件字段；无提示时事件保持原样。