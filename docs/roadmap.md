# P3 路线图：与业界先进 agent 的差距

参照系：Claude Code / Codex CLI / Cursor 这一档。对标只为量差距，不改定位——dock-agent 是**通用 agent runtime**，编码是一等场景而非唯一场景（见 README 开头）。P0–P2 完成后（见 [harness-gaps.md](./harness-gaps.md)），dock-agent 的功能骨架已齐——循环、审批、钩子、MCP、子 agent、会话分支、成本、轨迹、重试、rg 检索、运行时录制都有。差距集中在**深度与可靠性**，不在功能有无。

## 差距清单

| 维度 | 业界先进做法 | 当前状态 |
| --- | --- | --- |
| 工作区 checkpoint | 每轮自动快照文件状态（git shadow commit），rewind 连代码一起回滚 | 已实现：每轮 shadow git 快照，fork 可选回滚文件；git 缺失静默降级 |
| 代码智能 | LSP/tree-sitter 符号导航、AST 感知编辑、仓库索引/嵌入检索 | 只有 rg 文本检索，跨文件引用全靠模型自己 grep |
| 编辑可靠性 | apply_patch 上下文匹配 + fuzzy fallback、多处编辑原子化 | 精确优先 + 受控 whitespace fallback（唯一整行匹配，diff 预览同源）；仍无 apply_patch 式上下文补丁与 `multi_edit` 原子批量 |
| 权限与沙箱 | 规则持久化、模式化 allow/deny、OS 级沙箱（Seatbelt/Landlock） | 规则已按工作目录持久化（设置可查可清）；bash 仍靠灾难命令黑名单，无 OS 隔离 |
| 记忆与索引 | 跨会话 auto-memory、项目知识沉淀、repo wiki | 只有 AGENTS.md 静态规则，会话之间互不学习 |
| 后台与并发 | 后台长任务、并行子 agent、任务间消息 | 同一轮多个委派并行执行（信号量限流，默认 3）；仍无后台长任务、任务间通信，bash 每次新进程无状态 |
| 协议与缓存 | Anthropic/Gemini 原生适配、主动 prompt cache 布局 | 仅 OpenAI 兼容线格式，缓存靠网关自动命中 |
| 内置网络工具 | WebSearch/WebFetch/浏览器自动化一等工具 | 无内置网络能力，靠 MCP 外挂 |

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

落地细节：`task` 加入同批执行资格（只读工具与委派都不干扰彼此状态，`ask_user`/`todo_write` 仍串行），批量结果与转录沿用既有的按调用顺序落盘。限流是 `core/semaphore.ts` 的计数信号量，父 agent 一份 `maxConcurrentSubagents`（`AGENT_MAX_CONCURRENT_SUBAGENTS`，默认 3），批里的委派先拿槽位再开始计时，所以排队不消耗它自己的工具超时；预算继承与最小权限装配不变。事件顺序用「按调用缓冲再冲刷」：批量里有 ≥2 个委派时，每个调用的嵌套活动（子 agent 事件、起止标记、重试）先进入该调用的缓冲区，轮到它时一次冲刷，渲染端一委派一块；单个委派仍实时流式。`approval-request`/`approval-decision` 永不缓冲，并且 `approvalLock`（1 槽信号量，父与所有子共用）把「发问—等回答」串成一次一个——Web 只有一张审批卡、CLI 只有一条 readline。没有新增事件类型，协议与旧轨迹不受影响。细节与边界见 [subagents.md](./subagents.md)。声明式 `.agent/agents/*.md` 注册表仍未做。

### 暂不排期

剩下的差距工程量都不小，各自单独立项。按通用定位排序（谁离「任何任务都用得上」更近谁在前）：跨会话记忆、后台长任务与任务间通信、内置网络工具（WebSearch / WebFetch / 浏览器）在前；OS 沙箱、原生 Anthropic/Gemini 协议是可靠性与覆盖面，随后；纯编码场景专属的代码智能（LSP / tree-sitter / 仓库索引）与 IDE 集成排在最后——对写代码收益大，但不扩展 runtime 的通用能力边界。`.agent/agents/*.md` 声明式子 agent 注册表属于通用能力，工程量可控，可以插队。

## 设计约束（沿用）

- 事件协议新增字段保持可选，旧轨迹与旧测试不受影响。
- 外部二进制（git/rg）一律可选：缺失静默降级，不引入运行时第三方依赖。
- 持久化仍走 `.agent/` 文件，不引入数据库。
- 破坏性操作（文件恢复）必须显式确认，默认路径永远非破坏性。