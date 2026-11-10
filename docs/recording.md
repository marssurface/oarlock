# 运行时录制：AGENT_RECORD 网关调试开关

排查网关问题（usage 字段怪形状、推理字段差异、429 头、半截流）时，需要看到**模型调用原样**。会话 JSONL 记的是加工后的消息与轨迹，不够；bench 录制绑定任务 fixture，又离日常使用太远。这个开关把两者之间的空档补上：日常 CLI / Web 对话时，把每次模型调用的完整请求与原始事件流 dump 成可读 JSON。

## 开启

```bash
AGENT_RECORD=1 node src/cli.ts          # → <cwd>/.agent/recordings/
AGENT_RECORD_DIR=dumps node src/web/server.ts   # 自定义目录，单独设置即开启
```

- 两个变量在每次 `createRuntime` 时读取：Web 改设置重建 runtime 后即生效，无需重启；`AGENT_RECORD_DIR` 优先，相对路径按 cwd 解析。
- 包装点在 `core/setup.ts`：`createRuntime` 用 `DebugRecordingProvider` 包住 `createProvider` 的结果。Agent 循环、压缩请求、子 agent 都复用同一个 provider 实例，因此**全部自动入录**。
- bench 不走 `createRuntime`（自己组 provider），不受此开关影响；bench 的录制回放是另一套（见 `bench/transcripts/README.md`）。
- 开启时 stderr 提示一次落盘目录。

## 落盘格式

每次调用一个文件：`<ISO时间戳>-<进程序号>.json`，时间戳 sortable，进程内序号防同毫秒碰撞。

```json
{
  "version": 1,
  "at": "2026-11-09T19:55:01.123Z",
  "provider": "openai",
  "model": "请求级覆盖或 provider 默认",
  "durationMs": 1234,
  "request": { "messages": [...], "tools": [...], "temperature": 0.3 },
  "events": [ { "type": "reasoning-delta", ... }, { "type": "usage", ... }, ... ],
  "error": { "message": "...", "status": 429, "retryAfterMs": 7000 }
}
```

- `request` 是发往适配层的原始请求，仅去掉不可序列化的 `AbortSignal`；图片 parts 保留 base64 原样。
- `events` 按流式顺序原样收集；中途失败时保留已收到的半截事件，`error` 记录消息、HTTP 状态与 `retryAfterMs`（如有），错误照常向上抛给循环处理。
- 消费方提前中止迭代时，记录的是实际消费到的事件——所见即所得。

## 安全边界

- **fail-open**：mkdir / 写盘失败只在 stderr 提示一次，绝不影响对话；录制是旁观者，不是链路环节。
- **隐私与磁盘**：dump 含完整对话内容（含图片 base64），体积可能很大。默认目录 `.agent/recordings` 已被 `.gitignore` 覆盖；`AGENT_RECORD_DIR` 指到别处时自行留意。只在本机调试时开启，问题复现后关掉。
- 不录 API key：密钥在 HTTP 头里，不在 `ProviderRequest` 中。

## 验证

`test/recording.test.ts`：开关与目录解析（含优先级）、请求/事件落盘与 signal 剔除、模型覆盖、失败记录（状态 + Retry-After）后重抛、目标不可写时流照常、`createRuntime` 按开关包装且整轮产出文件。