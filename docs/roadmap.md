# P3 路线图：与业界先进 agent 的差距

参照系：Claude Code / Codex CLI / Cursor 这一档。对标只为量差距，不改定位——oarlock 是**通用 agent runtime**，编码是一等场景而非唯一场景（见 README 开头）。P0–P2 完成后（见 [harness-gaps.md](./harness-gaps.md)），oarlock 的功能骨架已齐——循环、审批、钩子、MCP、子 agent、会话分支、成本、轨迹、重试、rg 检索、运行时录制都有。差距集中在**深度与可靠性**，不在功能有无。

## 差距清单

| 维度 | 业界先进做法 | 当前状态 |
| --- | --- | --- |
| 工作区 checkpoint | 每轮自动快照文件状态（git shadow commit），rewind 连代码一起回滚 | 已实现：每轮 shadow git 快照，fork 可选回滚文件；git 缺失静默降级 |
| 代码智能 | LSP/tree-sitter 符号导航、AST 感知编辑、仓库索引/嵌入检索 | 只有 rg 文本检索，跨文件引用全靠模型自己 grep |
| 编辑可靠性 | apply_patch 上下文匹配 + fuzzy fallback、多处编辑原子化 | 精确优先 + 受控 whitespace fallback（唯一整行匹配，diff 预览同源）；仍无 apply_patch 式上下文补丁与 `multi_edit` 原子批量 |
| 权限与沙箱 | 规则持久化、模式化 allow/deny、OS 级沙箱（Seatbelt/Landlock） | 规则已按工作目录持久化（设置可查可清）；bash 仍靠灾难命令黑名单，无 OS 隔离 |
| 记忆与索引 | 跨会话 auto-memory、项目知识沉淀、repo wiki | 已实现跨会话记忆：`.agent/memory/*.md` 一条一个文件，摘要每轮注入系统提示词，`remember` 工具写入/删除，按条目记审批规则。仍无自动沉淀（只记模型主动写的）、无用户级/全局层、无仓库知识索引 |
| 后台与并发 | 后台长任务、并行子 agent、任务间消息 | 同一轮多个委派并行执行（信号量限流，默认 3），子 agent 预设可声明在 `.agent/agents/*.md`；仍无后台长任务、任务间通信，bash 每次新进程无状态 |
| 协议与缓存 | Anthropic/Gemini 原生适配、主动 prompt cache 布局 | 已实现 Anthropic 原生 Messages 线格式与 Gemini 原生 generateContent 线格式（`provider: 'anthropic' | 'gemini'`，见 ⑧⑨）；Anthropic 主动 `cache_control` 布局默认开启（系统/工具/历史前缀三处断点）；Gemini 显式 cachedContent 仍未做 |
| 内置网络工具 | WebSearch/WebFetch/浏览器自动化一等工具 | `web_fetch` 已实现（Node 自带 fetch，流式截断 + 逐跳跳转校验 + SSRF 尽力守卫，见 ⑦）；WebSearch 仍缺——需要先定一个搜索后端 |

「有但浅」的几处：压缩是启发式估算 + 摘要（先进做法保留文件状态做结构化微压缩）；bench 是 17 个合成任务，缺 SWE-bench 式真实仓库评测；无 IDE 集成、无 git 工作流（自动提交/PR）、无插件/技能生态。

对齐度已经很高的：hooks、MCP、审批 diff 预览、会话 fork、成本快照——不少开源框架反而没做到这个完整度。

## 实施计划（性价比排序）

### ① 文件 checkpoint（已完成）

体验提升最大、实现成本可控。方案：**git shadow 仓库**——不碰用户的 `.git`，用独立 GIT_DIR 把工作区定期提交成快照。

- `core/checkpoint.ts`：`CheckpointManager`，shadow 仓库放 `.agent/checkpoints/`；`git` 不存在时整个能力静默降级（fail-open，与 rg 同哲学）。
- 快照时机：每个用户回合开始前（`turn-start` 前），提交信息带会话/回合标识；排除 `.agent/`、`node_modules/` 等重目录，复用工作区 `.gitignore`。
- 事件协议：`turn-start` 增加可选 `checkpoint` 字段（提交 hash），轨迹天然持久化，旧轨迹不受影响。
- 恢复入口：fork 时可选 `restoreFiles`（把文件恢复到分支点对应回合的快照）；Web 分支确认弹窗明示「将恢复文件」，CLI `/fork [keep] --restore`。**恢复是破坏性操作，必须显式 opt-in + 二次确认**；默认 fork 仍只分支对话，保持非破坏性原则。
- 边界：未跟踪且被排除的文件（node_modules 等）不参与恢复；恢复前再做一次安全快照，恢复本身也可撤销。

落地细节（与计划的差异）：空工作区的第一轮也会做一次空提交（否则首个回合无可回滚锚点）；恢复后安全快照留在 `pre-restore` 分支；压缩导致轨迹前缀缺失时按后缀对齐并校验原文，对不上就放弃快照而非回滚到错误位置。完整行为与开关见 [checkpoints.md](./checkpoints.md)。

### ② 权限规则持久化（已完成）

`RuleApprovalGate` 的 `always` 规则落盘到 `.agent/permissions.json`（按工作目录），重启后生效；设置面板「权限」板块可查、单条移除、二次确认清空。保持「deny 优先、规则只放宽不收紧」语义。

落地细节：规则用 `{ version: 1, rules: [...] }` 的纯 JSON 保存，原子替换写入，解析失败/缺文件按空规则集处理；同一进程内所有会话（Web + CLI）共享一份 `PermissionRules`，CLI 直接复用 Web 里放行的规则；`always` 落盘失败时本次调用照常放行，只是不记忆。实现见 `core/rules.ts`，交互细节见 [approval-card.md](./approval-card.md)。

### ③ edit 容错（已完成）

`edit_file` 精确匹配失败时做受控 fuzzy：只规范化行首缩进、行尾空白与行尾符，行内空白差异不算相等；候选必须唯一、区间必须覆盖整行、片段去掉首尾空白不少于 10 字符；命中后在结果里声明「whitespace-tolerant match」，多候选仍报错。

落地细节：匹配与替换收在 `core/edit-match.ts`（`resolveEdit` / `replacePlan`），审批卡片的 diff 走同一条路径，所以预览与写入内容严格一致。`new_string` 按匹配到的缩进差重映射——行数对齐时逐行套用各自的差（2 空格片段落在 4 空格文件里仍是文件原本的结构），行数不一致时退回首个非空行的统一差，不做猜测；tab 与空格互不包含就不动；区间内出现过 CRLF 就把替换结果还原成 CRLF。`replace_all` 与模糊路径互斥，模糊时只替换唯一那一处并说明。规则、边界与验证见 [edit-fuzzy.md](./edit-fuzzy.md)。`multi_edit` 原子批量仍未做。

### ④ 子 agent 并发（已完成）

`task` 支持同一轮多个委派并行执行（信号量限流，默认 3），事件与转录仍按调用顺序输出；继承每轮预算不变。

落地细节：`task` 加入同批执行资格（只读工具与委派都不干扰彼此状态，`ask_user`/`todo_write` 仍串行），批量结果与转录沿用既有的按调用顺序落盘。限流是 `core/semaphore.ts` 的计数信号量，父 agent 一份 `maxConcurrentSubagents`（`AGENT_MAX_CONCURRENT_SUBAGENTS`，默认 3），批里的委派先拿槽位再开始计时，所以排队不消耗它自己的工具超时；预算继承与最小权限装配不变。事件顺序用「按调用缓冲再冲刷」：批量里有 ≥2 个委派时，每个调用的嵌套活动（子 agent 事件、起止标记、重试）先进入该调用的缓冲区，轮到它时一次冲刷，渲染端一委派一块；单个委派仍实时流式。`approval-request`/`approval-decision` 永不缓冲，并且 `approvalLock`（1 槽信号量，父与所有子共用）把「发问—等回答」串成一次一个——Web 只有一张审批卡、CLI 只有一条 readline。没有新增事件类型，协议与旧轨迹不受影响。细节与边界见 [subagents.md](./subagents.md)。声明式 `.agent/agents/*.md` 注册表见 ⑥。

### ⑤ 跨会话记忆（已完成）

补上「这次学到的东西下次还要重新学」的缺口：agent 主动把事实、偏好、决定、做法写成一条条短笔记，之后的每个会话一开始就能看见。

- `core/memory.ts`：`.agent/memory/<slug>.md`，一条一个文件，frontmatter 存 `name/description/kind`，正文给人和模型一起读。slug 归一（空格/下划线/冒号折成 `-`）顺带挡掉目录穿越；写入是临时文件 + rename 的原子替换；目录缺失、frontmatter 损坏一律 fail-open，手写文件按「第一行当摘要」继续索引。
- 注入：`createRuntime` 给 Agent 一个 `memoryIndex` 函数，**每轮开始重读目录并重建系统提示词**——本轮写的笔记下一轮就在，不需要重启；索引有上限（60 条 / 约 4000 字符，剩余折叠成一行提示），只给摘要不给正文，细节靠 `read_file`。
- `remember` 工具（`tools/memory.ts`，risk `write`）：`write` / `remove` 两个动作。审批规则按条目走（`remember:write:<name>` / `remember:remove:<name>` 分别是两个键），这是 `ToolDefinition` 新增 `ruleKeyFor` / `summaryFor` 的原因——没有路径参数的工具第一次能自己说清「这一步放行的是什么」。
- 子 agent 看得到摘要但没有 `remember`：孩子汇报，父级决定什么值得记。
- 人的入口：CLI `/memory [name]` 与 `/forget <name>`；文件本身是普通 markdown，`.agent/` 已被 gitignore，所以记忆是这台机器这个目录的状态，不会随仓库提交。
- 未做（有意）：自动沉淀（每轮多花一次模型调用，且噪声多）、失效时间、用户级/全局记忆层。完整语义与边界见 [memory.md](./memory.md)。

### ⑥ 声明式子 agent 注册表（已完成）

内置的 `general` / `explore` 够通用，但不了解你的项目。把「只有这个仓库才知道的角色」写成文件：`.agent/agents/<name>.md`，frontmatter 是路由字段（`description` / `tools` / 可选 `model`），正文就是这个子 agent 的人格。

- `core/subagents.ts`：`subagentPresets(cwd)` = 内置 + 目录里的文件预设，同名文件**就地替换**内置项，其余按名字排在内置之后；`parseSubagentFile` 复用与记忆同一套 frontmatter 解析（抽到 `core/frontmatter.ts`）。文件名不是 slug 的（`README.md`）视为给人看的说明，不进目录。
- 刷新时机与记忆一致：`createRuntime` 传 `subagentPresets: () => subagentPresets(cwd)`，Agent **每轮开始重读**，系统提示词里的预设清单跟着变——新增或改文件不用重启会话。读不出、frontmatter 坏、名字非法、文件超大一律跳过；提供函数本身抛错退回内置。
- 委派语义一字未改：仍是「父能力去掉 `task`/`ask_user`/`todo_write`/`remember`，再与白名单取交集」，文件预设拿不到父级没有的工具，也不能写记忆；模型优先级仍是显式 `model` > 预设 `model` > 继承父级。
- 两处诚实报错，避免「配了但什么都不做」：预设名不存在时列出这个目录真实可用的名字；白名单与父能力交集为空（典型是工具名写错，如 `read_filez`）时报错说明它只允许什么、父级实际有什么，而不是放一个没有工具的孩子出去。
- 人的入口：CLI `/agents` 列出同一份目录，标注来源、工具白名单与模型。
- 未做（有意）：预设之间嵌套（循环与不可见的权限放大）、Web 设置面板里的预设管理。完整格式与边界见 [agent-presets.md](./agent-presets.md)。

### ⑦ 内置网页抓取 web_fetch（已完成）

补上「模型想读一个网页却没有网络能力」的缺口，但只做**抓取**不做**搜索**——搜索必须先定一个后端（API key 服务 vs keyless 抓取不稳），留待后续。

- `tools/web_fetch.ts`：`risk: 'read'`，只读工具不过审批；用 Node ≥22 自带的全局 `fetch`，运行时零第三方依赖这条不破。参数只有 `url`（必填）和 `maxChars`（默认 50_000，封顶 200_000）。
- **流式截断**：响应体按 chunk 读，到约 1.5MB（随 `maxChars` 浮动、硬顶 8MB）就 `reader.cancel()`，不整包缓冲——大页面不会把内存或上下文拖垮；返回头部报告实际字节数、字符数与转换方式。
- **跳转逐跳重验**：`redirect: 'manual'`，最多 5 跳；每一跳重新校验 scheme 与主机，所以一个 302 到 `http://169.254.169.254/` 会被拒掉而不是静默跟随。
- **SSRF 尽力守卫**：`isPrivateHost()` 挡 `localhost`、`*.local`/`*.internal`、回环、RFC1918、169.254/16、CGNAT、IPv6 `::1`；诚实边界是它挡不住「名字在 DNS 之后才解析到内网」的情况（`fetch` 不暴露解析结果），只挡 URL 里直接写死的私网地址。
- **HTML 转近似纯文本**：去 doctype/script/style/注释 → 块级标签转换行 → 其余标签剥掉 → 实体反转义 → 折叠空白。刻意不做全量 HTML 解析器，布局与交互内容丢失就是「当文本读」的意思。image/video/audio/pdf 与探测到的二进制直接一行占位，不解码。
- 复用既有超时语义：`AbortSignal.timeout(30s)`/跳，与父 `ctx.signal` 组合，超时/中断按错误文本返回给模型。
- WebSearch（需要搜索后端）与浏览器自动化（要无头浏览器）有意未做。

### ⑧ 原生 Anthropic 协议（已完成）

补上「只有 OpenAI 兼容线」的缺口：加一条 Anthropic Messages API 原生适配器，prompt cache 的一等结构（`cache_control`）留给后续按需开。

- `providers/anthropic.ts`：`AnthropicProvider`，走 `/v1/messages`、SSE 流式、`x-api-key` + `anthropic-version: 2023-06-01` 头；`createProvider` 在 `config.provider === 'anthropic'` 时路由过来，其余 provider 仍是 OpenAI 兼容线。
- 消息映射：系统提示抽到顶层 `system` 字段；`role: 'tool'` 折进用户轮的 `tool_result` 块，相邻工具结果与下一条用户文本合并到同一个 user turn（否则相邻 tool_result 会被拆成多个 user 消息）；assistant 的 tool_calls 映射成 `tool_use` 块；tool 参数的 JSON 字符串在发线前 parse 成对象（发不出坏请求）。
- 流式事件：`message_start` / `content_block_start` / `content_block_delta`（text_delta / thinking_delta / input_json_delta）/ `content_block_stop` / `message_delta` / `message_stop`；工具调用在 input_json_delta 累积完后一次发出，`stop_reason` 映射到既有 `FinishReason`（end_turn→stop、tool_use→tool_calls、max_tokens→length）。
- usage：`input_tokens` / `output_tokens` / `cache_read_input_tokens` 映射到 `Usage`，usage 在 message_start 和 message_delta 两处取（后者覆盖 output）。
- 配置：`ProviderKind` 加 `'anthropic'`，默认 `https://api.anthropic.com/v1` + `claude-sonnet-4-5`；`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 环境变量与 settings 走同一条 `.agent/keys.json` 端点键。Gemini 原生线与主动 cache_control 布局见 ⑨。

### ⑨ Gemini 原生协议 + 主动 prompt cache 布局（已完成）

provider 家族的另一半：补上 Gemini 原生线，并把 Anthropic 的 prompt cache 从「靠网关自动命中」升级为「主动布置断点」。

- `providers/gemini.ts`：`GeminiProvider`，走 `/models/{model}:streamGenerateContent?alt=sse`、SSE 流式、`x-goog-api-key` 头；`createProvider` 在 `config.provider === 'gemini'` 时路由过来。baseUrl 已带 `/models` 后缀时不重复拼接，`request.model` 覆盖默认模型（子 agent 分层复用同一网关）。
- 消息映射：系统提示抽到 `systemInstruction`；`role: 'assistant'` → `model`，tool_calls → `functionCall` part；`role: 'tool'` → 用户轮里的 `functionResponse` part，相邻工具结果与下一条用户文本合并到同一个 user turn（与 Anthropic 同一套 userAcc 累积逻辑）；图片 → `inlineData`。工具定义包成 `tools: [{ functionDeclarations: [...] }]`。
- 流式事件：逐 chunk 读 `candidates[0].content.parts`，`text` part 按 `thought` 标志分流到 reasoning-delta / text-delta，`functionCall` part 收集成 tool-call（Gemini 一次给完整 args，不像 Anthropic 增量拼 JSON）；`finishReason` STOP→stop、MAX_TOKENS→length，有工具调用时收口为 tool_calls。usage 从 `usageMetadata` 映射（含 `cachedContentTokenCount` / `thoughtsTokenCount`）。
- 配置：`ProviderKind` 加 `'gemini'`，默认 `https://generativelanguage.googleapis.com/v1beta` + `gemini-2.5-flash`；`GEMINI_API_KEY`（回退 `GOOGLE_API_KEY`）/ `GEMINI_BASE_URL` 环境变量，密钥仍走 `.agent/keys.json` 端点键。
- **Anthropic 主动 cache 布局**：`AnthropicProvider` 默认在稳定前缀布 `cache_control: { type: 'ephemeral' }` 断点——最后一个工具定义、系统块（系统提示因此从字符串变成单 text 块）、以及最新一轮之前那一轮的末块（历史前缀）。三处断点（Anthropic 上限四个），只留最新一轮新鲜；前缀断点随每步前移，旧缓存仍按最长匹配前缀命中。低于模型最小可缓存长度的断点被 API 静默忽略，短提示也安全。`promptCache: false` 可退回纯线格式（映射测试即走这条）。Gemini 的显式 `cachedContent`（需先建缓存资源）有意未做。

### 暂不排期

剩下的差距工程量都不小，各自单独立项。按通用定位排序（谁离「任何任务都用得上」更近谁在前）：后台长任务与任务间通信、内置网络工具里的 WebSearch / 浏览器自动化（`web_fetch` 已在 ⑦ 落地）在前；OS 沙箱随后；provider 家族的原生 Anthropic / Gemini 与主动 prompt cache 布局已在 ⑧⑨ 落地（Gemini 显式 cachedContent 留待按需）；纯编码场景专属的代码智能（LSP / tree-sitter / 仓库索引）与 IDE 集成排在最后——对写代码收益大，但不扩展 runtime 的通用能力边界。记忆里还差的两步——自动沉淀与用户级作用域——属通用能力，等真实用过一段再决定；跨会话记忆与预设目录的 Web 管理入口同理。

## 设计约束（沿用）

- 事件协议新增字段保持可选，旧轨迹与旧测试不受影响。
- 外部二进制（git/rg）一律可选：缺失静默降级，不引入运行时第三方依赖。
- 持久化仍走 `.agent/` 文件，不引入数据库。
- 破坏性操作（文件恢复）必须显式确认，默认路径永远非破坏性。