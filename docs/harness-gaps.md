# Harness 层缺口与执行计划

审计对象：`src/core/agent.ts`、`session/store.ts`、`tools/*`、`web/server.ts` 这条运行时链路。
结论：主干（provider 适配、循环、工具、审批、提问、压缩、会话、轨迹、子 agent）已经完整；缺口集中在**可恢复性、停止控制、审批粒度、上下文溢出**四类。

## 本轮实现（P0）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 会话尾部修复 | 已实现 | `SessionStore.open()` 自动修复「assistant.tool_calls 缺少 tool 结果」的断尾，并原子重写转录；abort 时未执行的工具调用也会补合成结果，保证内存历史始终可再次发送。 |
| Web 停止通道 | 已实现 | 新增 `POST /api/sessions/:id/abort`；运行中发送按钮切换为「停止」，点击后中止 provider 流与工具、清空待审批/待提问。 |
| 审批规则与 diff | 已实现 | `ApprovalDecision` 支持 `always`；`RuleApprovalGate` 按「bash 完整命令 / 写工具目录」记住规则，命中后不再弹审批（P3 起落盘到 `.agent/permissions.json`，重启仍生效，设置 → 权限可查可清）；write/edit 的 detail 改为变更预览（diff），审批卡新增「始终允许」。 |
| 溢出兜底与模型窗口 | 已实现 | 识别 context-length 类 400/413：强制压缩后重试一次；runtime 使用已启用模型中记录的 `contextWindow` / `maxOutputTokens`。 |

## 后续（P1 / P2）

### P1 效率与能力

- **并行只读工具**：已实现。连续的 `read` 风险调用与 `task` 委派（除 `ask_user`、`todo_write`）会并发执行；`write` / `exec` / 交互类保持串行。`tool-call` / `tool-result` 事件与转录消息仍按模型调用顺序输出，完成顺序不影响可读性。
- **计划状态**：已实现。新增状态型工具 `todo_write`：Agent 拦截并保存当前计划（`agent.plan()`），每次全量替换、至多一项 `in_progress`；发布 `todo` 事件并写入轨迹，CLI 与 Web 轨迹均渲染计划行与明细。子 agent 不携带该工具，也不参与并发批处理。
- **每轮预算**：已实现。新增 `maxTurnTokens` / `maxTurnMs`（env `AGENT_MAX_TURN_TOKENS` / `AGENT_MAX_TURN_MS`，默认不限）；在 step 之间检查累计 token（含子 agent 用量）与 wall-clock，超限正常收尾发布 `turn-end status: 'budget'`。检查放在 step 之间，当前 step 会先完整结束，避免留下悬空 tool_call；CLI 与 Web 轨迹标「预算」。
- **子 agent 可配置**：已实现（核心 + 专用类型）。`task` 新增 `agent`（预设路由）、`model`（同网关的模型分层）、`tools`（最小权限白名单，与父能力取交，绝不越权）；内置预设 `general`（继承父工具/模型）与 `explore`（只读检索，工具收窄到 `read_file/list_files/glob_files/grep_files`，配廉价模型）。子 agent 继承父轮 token/时间预算；并发已实现——同一条回复里的多个委派一起跑，`Semaphore` 按槽位限流（默认 3），事件按调用顺序成块、审批提示一次只问一个；仍为最多一层。`.agent/agents/*.md` 声明式注册表未纳入本轮，留待后续。详见 [subagents.md](./subagents.md)。

### P1 扩展性

- **hooks / 项目规则 / MCP**：项目规则已实现——`createRuntime` 读取工作目录 `AGENTS.md` 并拼进系统提示词，CLI / Web / bench 共用同一条 runtime 链路自动生效；子 agent 委派继承父级规则。详见 [project-rules.md](./project-rules.md)。工具钩子已实现——`.agent/hooks.json` 配 shell 命令，`PreToolUse`（拦截 / 放行 / 跳过审批）与 `PostToolUse`（标记错误 / 追加上下文），`bash -c` + stdin JSON + 退出码/JSON 决策、非零与超时 fail-open、子 agent 继承。详见 [hooks.md](./hooks.md)。MCP(stdio) 已实现——启动时按 `.agent/mcp.json` spawn 外部服务器，走 `initialize` + `tools/list` 握手，把工具转成 `mcp__<server>__<tool>` 注入运行时工具集；逐服务器 fail-open、默认 `exec` 风险需审批、子 agent / 审批 / 轨迹复用现有链路。详见 [mcp.md](./mcp.md)。
- **多模态**：已实现（图片输入）。`ChatMessage.content` 扩为 `string | ContentPart[]`，user 消息可带「文本 + 至多 4 张图片」；OpenAI 兼容线格式映射为 `image_url` data URL，上下文按每图 1200 token 估算、摘要只写 `[image: mime]` 占位符；会话内联持久化 parts，纯图片消息标题回退为 `[N 张图片]`；Web 提供附件 API（4 张 / 单图 4MB / 24MB 请求体校验）、选择/粘贴/拖放、浏览器端缩放、缩略图与历史还原，并按模型 `input` 声明门控入口。音频/PDF/视频与图片生成不在本轮。详见 [multimodal.md](./multimodal.md)。

P1 至此全部完成。

### P2 可观测与运维

- **成本与聚合**：已实现。每个已启用模型可在设置里配置「输入 / 输出 / 缓存」单价与币种（USD/CNY，每百万 tokens）；每次请求结束时按当时单价生成 `cost` 快照写入 `usage` 事件（压缩与子 agent 同样计入）。轨迹摘要、Token 列 tooltip、检查器各用量面板、会话列表与 CLI 均展示成本；`summarizeTrace` 按币种分别聚合，旧轨迹无 `cost` 时行为不变。详见 [cost.md](./cost.md)。
- **会话管理**：已实现。`SessionStore.rename` / `remove` / `fork(keep)` 覆盖重命名、删除与分支；Web 增加 `PATCH /api/sessions/:id`、`DELETE /api/sessions/:id`、`POST /api/sessions/:id/fork`，运行中一律 409；侧栏「⋯」菜单提供内联重命名、全量分支与二次确认删除，用户消息旁可「从此处分支」（非破坏性 rewind，原会话保留），CLI 增加 `/rename`、`/fork [keep]`、`/delete <id>`。详见 [session-management.md](./session-management.md)。
- **重试细节**：已实现。HTTP 失败的 `Retry-After` 响应头（秒数或 HTTP-date）经严格解析后放进 `ProviderError.retryAfterMs`；重试延迟取「指数退避 与 服务端建议」的较大值，封顶 60s，abort 照常生效。`retry` 事件新增可选 `retryAfterMs`，CLI / Web 标注等待来源。流中途断开仍不重试（避免重复输出）。详见 [retry.md](./retry.md)。
- **大仓检索**：已实现。`grep_files` 检测到 ripgrep 时优先 spawn rg（确定排序、跳过目录/大小上限/输出格式对齐 JS walk）；rg 缺失、拒绝模式、超时或输出超限自动回退 JS 全量 walk，契约仍是 JavaScript 正则。`AGENT_NO_RG=1` / `AGENT_RG_PATH` 可切换后端。详见 [search.md](./search.md)。

P2 至此全部完成。

## 设计约束

- 事件协议是对外接口：新增字段保持可选，旧轨迹与旧测试不受影响。
- ABORT 语义保持 `error: 'aborted'`（bench `abort-turn` 依赖该断言）；UI 负责本地化成「已停止」。
- 审批规则自 P3 起按工作目录落盘到 `.agent/permissions.json`（仍只放宽审批、不覆盖 deny 策略）；持久化仍只走 `.agent/` 文件，不引入数据库。
