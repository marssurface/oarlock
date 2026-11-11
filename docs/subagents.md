# 子 agent（task 委派）

父 agent 把一块独立、会淹没当前对话的工作交给一个全新上下文的子 agent，只收回它的最终报告。本轮吸收工业界经验，把固定的「同 provider、同工具集、最多一层」升级为可路由、可分层、最小权限的委派。

## 工具契约（src/tools/task.ts）

`task` 参数 `risk: 'read'`（委派本身不改盘），`timeoutMs` 300s：

- `description`（必填）：3–5 词任务名，进入子 agent 的 system prompt。
- `prompt`（必填）：给子 agent 的完整指令，它看不到父对话。
- `agent`（可选）：预设名路由，默认 `general`。
- `model`（可选）：同一网关下的模型分层；简单检索可指定更便宜的模型。
- `tools`（可选，字符串数组）：子 agent 的工具白名单，与父能力取交集，**绝不越权**。

`execute` 只做参数清洗（空串视为未提供），把可选字段透传给 `ctx.spawnSubagent`；子 agent 抛错时返回 `subagent failed: …` 的错误文本给模型，回合继续。

## 预设从哪来（src/core/subagents.ts）

`SubagentPreset = { name, description, systemPrompt, tools?, model?, source? }`。`SUBAGENT_PROMPT` 从 `prompt.ts` 移到这里，`general` 直接复用它。

内置两个：

- **general**：`tools` 与 `model` 均省略 → 继承父工具（去掉 `task/ask_user/todo_write/remember`）与父模型；用于「可能改盘或跑命令」的多步任务。
- **explore**：`tools` 收窄到 `read_file/list_files/glob_files/grep_files`，独立只读人格；`model` 保持省略。

模型名是网关相关的，所以内置预设不硬编码 `model`——「廉价层」靠只读白名单与聚焦人格实现，具体便宜模型由调用方通过 `model` 传入。

工作区还可以自带预设：`.agent/agents/<name>.md`，frontmatter 写 `description` / `tools`（或别名 `allowed-tools`）/ 可选 `model`，正文就是这个子 agent 的人格。`subagentPresets(cwd)` 把内置与文件预设合并——同名文件**就地替换**内置项，其余按名字排在内置之后；`findPreset(name, presets)` 解析（路由名大小写不敏感），`formatPresetCatalog(presets)` / `presetCatalog(cwd)` 生成一行内联清单供系统提示做路由。Agent 通过 `subagentPresets: () => subagentPresets(cwd)` 拿到目录，**每个回合开始重读一次**，新增文件不用重启会话；整条链路 fail-open，读不到就退回内置两个。完整格式、上限与边界见 [agent-presets.md](./agent-presets.md)。

## 模型分层（ProviderRequest.model）

`ProviderRequest` 增加可选 `model`：同一 provider 实例发送不同模型名。`OpenAICompatibleProvider.stream` 的 body 用 `model: request.model ?? this.model`。

Agent 侧新增 `modelOverride` 选项与字段，`effectiveModel()` 返回 `modelOverride ?? provider.model`：

- 流式请求注入 `model`；`usage` / `assistant` 事件的 `model` 标签用 `effectiveModel()`，父级（无 override）仍显示 provider 默认。
- 压缩同样走分层：`ContextManager.compact` 新增 `options.model`，透传给内部 `completeText`，`compaction` usage 标签也随之一致。

## spawnSubagent 装配（src/core/agent.ts）

1. 深度闸：`depth >= maxDepth` 抛 `maximum subagent depth reached`。
2. 解析预设：在当前回合的 `this.presets`（内置 + `.agent/agents/*.md`）里按名查找，名字先小写归一；未知则抛 `unknown agent preset: <name>. Available: …`，列出这个目录真实可用的预设（被 `task` 捕获成错误文本，模型下一轮能据此改对）。
3. **最小权限工具**：`parentTools = tools.without('task').without(ask).without(todo).without(remember)`；`allowlist = input.tools ?? preset.tools`；无白名单直接用 `parentTools`，否则 `parentTools.list().filter(name ∈ allowlist)` 重建注册表——子集天然不可能超过父集，文件预设也一样拿不到 `remember`。白名单非空但与父能力交集为空（典型是工具名写错）时直接报错说明「它只允许 X，父级实际有 Y」，而不是放一个没有工具的孩子出去。
4. **模型**：`childModel = input.model ?? preset.model ?? this.modelOverride`，有值才设 `modelOverride`。
5. **预算继承**：子 agent 拷贝父的 `maxTurnTokens`/`maxTurnMs`，失控子任务不会超过发起它的回合。
6. 人格：`systemPrompt = preset.systemPrompt + "\n\nTask: " + description`。
7. 事件桥：子 `usage` 计入父 `turnNestedUsage`（回合总额含嵌套用量），审批/工具/assistant/压缩/重试/子生命周期事件向上冒泡给 `onEvent`，父 `task` 行拥有子 agent 的起止展示。

`prompt.ts` 的 `buildSystemPrompt` 在工具含 `task` 时追加一条路由指导，清单用当前目录渲染出来的预设（不是写死的两个），并提示传更便宜的 `model`、给最小 `tools`。只有确实存在文件预设时才再加一句「这些是本工作区作者写好的常驻人格，合适就直接路由，别在 prompt 里重述角色」——纯内置时不制造噪声。

## 同一轮多个委派并行

模型在一条回复里给出多个 `task` 调用时不再排队，`core/agent.ts` 的批量执行与两处限流负责：

- **批量资格**：`canRunConcurrently` 把 `task` 与只读工具一起放行——委派各有独立上下文，彼此不会污染；`ask_user`、`todo_write` 涉及交互与计划状态，仍串行。转录与结果沿用既有的 ordered replay：先并发跑完，再按模型给出的调用顺序落盘，完成顺序不进入对话历史。
- **槽位**：父 agent 持有一个 `Semaphore(maxConcurrentSubagents)`（`core/semaphore.ts`，默认 3，`AGENT_MAX_CONCURRENT_SUBAGENTS` 可调），配置在 `config.ts → setup.ts → AgentOptions` 之间透传。批里的委派**先拿槽位再开始执行**，因此排队时间不吃它自己的工具超时；超出上限的调用只是延后开始，不会丢。
- **事件成块**：批量包含 ≥2 个委派时，每个调用的嵌套事件（子 agent 的 `tool-call`/`tool-result`/`assistant`/`usage`/压缩/重试、`subagent-start`/`subagent-end`）先进入该调用的 `EventRoute` 缓冲，轮到它时一次冲刷给 `onEvent`。渲染端因此看到的是「一个委派一块、按调用顺序」，而不是两个子 agent 互相穿插；冲刷同时做在 `finally` 里（`splice` 保证幂等），中断路径不会把缓冲事件留在原地。单独一个委派不走缓冲，仍实时流式。
- **审批仍即时**：`approval-request`/`approval-decision` 从不缓冲，否则子 agent 等的是一张还没显示的卡片，整批一起死锁。
- **提示一次一个**：`approvalLock`（1 槽 `Semaphore`）由父与所有子共用，包住「发问 → 等回答」这段。Web 端只有一张审批卡片、CLI 只有一条 readline，并发发问会把答案给错对象。
- 预算与用量：子 `usage` 仍即时计入父 `turnNestedUsage`（不受事件缓冲影响），每轮 token/时间预算继续由子继承。

没有新增事件类型，轨迹格式与旧会话不受影响。

## 边界

- 最多一层（`maxDepth` 默认 1）；子 agent 拿不到 `task`，所以并发只发生在发起它的那一层，每层各自计数。
- 并发范围是「同一次模型回复里的连续可批调用」，跨步骤仍串行；没有后台长任务与任务间通信（见 harness-gaps）。
- 预设文件只定义人格与能力，不改变委派语义；预设之间不嵌套，`.agent/agents/*.md` 的加载与边界见 [agent-presets.md](./agent-presets.md)。
- 子 agent 不能问用户、不携带 `todo_write` 与 `remember`，`task` 自身被移除以终止递归。

## 验证

- `npm test`：agent 层覆盖 `explore` 只读白名单、最小权限不越权、`model` 覆盖进子请求与事件标签、未知预设报错并列出可用名；文件预设见 [agent-presets.md](./agent-presets.md) 的验证清单；并发部分覆盖「两个委派同时在飞且事件按调用顺序成块」「超出上限排队（峰值并发等于槽位数）」「并发写操作的审批提示一次只出现一个，且审批事件仍然实时先于缓冲内容」「单独委派不被缓冲」。既有子 agent 委派与用量折叠用例保持通过。
- `npm run typecheck`、`npm run build`（产物同步到 `dist`）、`node bench/run.ts`（含 `subagent`、`abort-turn`、`parallel-tools`）。
