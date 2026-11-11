# oarlock

一个从零手写的 agent 项目：模型适配层、Agent 循环、工具调用、上下文压缩、会话持久化与分支管理、权限审批、子 agent、工具钩子、MCP、图片输入与成本核算，外加终端 CLI 和一个本地 Web 界面。运行时零第三方依赖，只用 Node 标准库。名字取自桨栓——桨架上那个供桨转动吃水的支点：模型负责出力，runtime 负责把力气传下去。

定位是**通用 agent runtime**，不是编码工具的复刻。文件、命令、子 agent、审批、MCP 这些能力面向任何任务——写周报、整理资料、跑一段数据处理、检索外部系统，和改代码走的是同一条循环。编码只是被用得最多、也因此打磨得最细的一类场景，所以文档里会拿 Claude Code / Codex CLI / Cursor 做参照：量的是运行时完成度的差距，不是要把项目改成它们的形态。

```
agent/
├── src/
│   ├── config.ts              # .env / 环境变量 / .agent/settings.json / .agent/keys.json / provider 选择
│   ├── providers/             # 模型适配层
│   │   ├── types.ts           # ChatProvider 接口与消息/事件协议（content parts）
│   │   ├── content.ts         # 文本/图片片段读取、data URL 与消息组装
│   │   ├── openai-compatible.ts  # DeepSeek / OpenAI / Ollama / 任意兼容网关
│   │   ├── recording.ts         # 可选运行时录制（AGENT_RECORD，网关调试用）
│   │   └── mock.ts            # 无 key 也能跑通的假模型
│   ├── tools/
│   │   ├── types.ts           # ToolDefinition / ToolContext / 审批协议
│   │   ├── fs.ts              # read/write/edit/list/glob/grep + 路径沙箱
│   │   ├── ripgrep.ts         # grep_files 的 rg 加速层（可选，失败回退 JS walk）
│   │   ├── bash.ts            # bash -lc，超时、输出截断、危险命令拦截
│   │   ├── task.ts            # 子 agent 委派
│   │   ├── ask.ts             # ask_user 交互式提问
│   │   ├── todo.ts            # todo_write 计划状态
│   │   ├── memory.ts          # remember 工具：写/删跨会话记忆（按条目记审批规则）
│   │   ├── web_fetch.ts       # 内置网页抓取：fetch + 流式截断 + 逐跳跳转校验
│   │   └── registry.ts        # 工具注册表 → 模型可用的 JSON Schema
│   ├── core/
│   │   ├── agent.ts           # Agent 循环（本项目的心脏）
│   │   ├── context.ts         # token 估算 + 摘要压缩
│   │   ├── approval.ts        # ask / auto / deny 审批策略
│   │   ├── rules.ts           # 「始终允许」规则持久化（.agent/permissions.json）
│   │   ├── prompt.ts          # 系统提示词
│   │   ├── subagents.ts       # 子 agent 预设：内置 general / explore + .agent/agents/*.md
│   │   ├── memory.ts          # 跨会话记忆存储（.agent/memory/*.md，一条一个文件）
│   │   ├── frontmatter.ts     # `.agent/` 文件共用的 `---` frontmatter 解析（fail-open）
│   │   ├── instructions.ts    # 读取 AGENTS.md 项目规则，拼进系统提示词
│   │   ├── hooks.ts           # PreToolUse / PostToolUse shell 钩子（.agent/hooks.json）
│   │   ├── pricing.ts         # 按模型单价计算成本、按币种聚合
│   │   ├── checkpoint.ts      # 每轮工作区快照（shadow git）、回滚与撤销快照
│   │   ├── edit-match.ts      # edit_file 的精确优先 + 受控空白容错匹配
│   │   ├── diff.ts            # 写操作的统一 diff 预览（与执行同一套匹配）
│   │   ├── semaphore.ts       # 计数信号量（并发委派限流、审批提示排队）
│   │   └── setup.ts           # 把 provider、工具、会话拼成一个 runtime
│   ├── mcp/
│   │   ├── config.ts          # 解析 .agent/mcp.json（服务器命令、env、risk、超时）
│   │   ├── client.ts          # stdio JSON-RPC 客户端：握手、tools/list、tools/call
│   │   └── index.ts           # 并行载入服务器，把 MCP 工具转成 ToolDefinition
│   ├── session/store.ts       # JSONL 会话记录、恢复、压缩重写
│   ├── cli.ts                 # 终端 REPL
│   └── web/
│       ├── server.ts          # HTTP + SSE 服务（含 /api/settings）
│       ├── presets.ts         # 云厂商 / 本地模型快捷预设
│       └── public/index.html  # 单页聊天界面（原生 JS）
├── bench/                     # 评测台：17 个任务 + 断言，脚本/真模型/录制回放
├── .github/workflows/ci.yml   # CI：typecheck + test + build + bench + 录制回放
├── scripts/copy-assets.mjs    # 构建时把 Web 静态页复制进 dist/
├── Dockerfile                 # 多阶段构建；运行镜像不含依赖和源码
└── test/                      # node:test，219 个用例
```

## 快速开始

要求 Node >= 22.6（直接用 `node` 跑 TypeScript，无需构建）。打包后的 `dist/` 只需要 Node >= 20。

```bash
cd agent
pnpm install          # 只装 typescript / @types/node，用于类型检查
cp .env.example .env
node src/cli.ts       # 没有 key 时自动使用 mock 模型
```

无 key 也能完整体验循环。在 REPL 里试：

```
!tool list_files {"path":"."}
```

会给模型一个工具调用的机会，走完「模型 → 工具 → 结果 → 模型」全过程。

接真实模型，在 `.env` 里填：

```bash
AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-...
# 或 openai / ollama：
# AGENT_PROVIDER=openai
# OPENAI_API_KEY=...
# OPENAI_BASE_URL=https://your-gateway/v1
# 火山方舟 Ark（OpenAI 兼容的 Coding 接口）
# AGENT_PROVIDER=openai
# OPENAI_API_KEY=ark-...
# OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
# AGENT_MODEL=deepseek-v4.1-flash-economy
# AGENT_PROVIDER=ollama        # 本地，无需 key
# OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
```

启动后终端显示 `deepseek/deepseek-chat · … · approval=ask`，即为接入成功。

## CLI 用法

```bash
node src/cli.ts                       # 交互式
node src/cli.ts --provider mock       # 强制 mock
node src/cli.ts --auto                # 写文件/跑命令不再询问
node src/cli.ts --resume <session-id> # 继续历史会话
node src/cli.ts --trace <session-id>  # 打印该会话的轨迹
node src/cli.ts --once "解释这个仓库"  # 跑一轮就退出
```

REPL 内命令：`/new`、`/sessions`、`/resume <id>`、`/trace`、`/memory [name]`、`/forget <name>`、`/agents`、`/help`、`/exit`。

## Web 界面

```bash
node src/web/server.ts --port 4173
# http://127.0.0.1:4173
```

左侧会话列表（含轮数与 token 总量）、右侧对话与工具卡片；会话行的「⋯」菜单可重命名、新建分支或删除，用户消息旁可「从此处分支」，另有「回滚文件并分支」（两次点击确认）。高风险操作会在输入框上方弹出「允许 / 拒绝」。SSE 流式输出，刷新页面可从 `.agent/sessions/*.jsonl` 恢复历史。详见 [docs/session-management.md](docs/session-management.md)。

审批卡片会显示工具胶囊、可读的操作摘要，写操作直接给出 diff 预览（其余工具仍是参数详情），收在折叠块里；允许为强调色主按钮、拒绝为次按钮，另有「始终允许」——按工作目录把相同的命令或目录记进 `.agent/permissions.json`，之后同类调用直接放行，设置 → 权限里可查可清。窄屏时按钮换行右对齐。详见 [docs/approval-card.md](docs/approval-card.md)。

运行中发送按钮变为「停止」，点击后中止模型流与工具、释放待审批/待提问，并把未执行的工具调用补成中止结果，会话历史不会留下悬空的 tool_call。详见 [docs/harness-gaps.md](docs/harness-gaps.md)。

瞬时错误（429 / 5xx / 网络抖动）在产生任何输出前自动重试：指数退避与服务端 `Retry-After` 取较大值，封顶 60 秒；`Retry-After` 支持秒数与标准 HTTP-date，垃圾值安全忽略。CLI 与 Web 会标注等待是否来自服务端建议。详见 [docs/retry.md](docs/retry.md)。

当模型需要用户拍板时会调用 `ask_user`：对话里弹出一张交互式选择卡（2–4 个选项 + 推荐标记 + 单选/多选 + 自定义输入），提交或跳过后答案沿 SSE 回到模型继续执行，并记入会话与轨迹；刷新后卡片以只读终态恢复。命令行 REPL 里同一个问题用编号选择作答，非交互模式自动跳过。完整链路见 [docs/ask-card.md](docs/ask-card.md)。

对话里的思考和工具执行默认折叠，连续多条会合并成一个「执行过程」摘要；收起时仍能看到当前动作、用时和成功/失败统计。底部「琢磨中… / 执行中…」是界面按阶段生成的文案，不是模型输出。完整规则见 [docs/conversation-activity.md](docs/conversation-activity.md)。

每条助手回答下方有一行操作：复制、有帮助 / 没帮助、分享、固定、更多，右侧标注「由 AI 生成」。复制与分享写剪贴板，更多菜单支持引用到输入框、复制 Markdown、导出 `.md`；赞踩和固定只存在本机浏览器，不进入模型上下文。完整说明见 [docs/message-actions.md](docs/message-actions.md)。

运行时（harness）已实现的能力、已知缺口与后续计划见 [docs/harness-gaps.md](docs/harness-gaps.md)。与业界先进 agent（Claude Code / Codex CLI / Cursor）的差距分析与 P3 实施计划见 [docs/roadmap.md](docs/roadmap.md)。

顶栏常驻「对话 / 轨迹」分段开关（两个视图共用同一条顶栏，开关位置不跳变，Esc 也可返回对话）；切到轨迹后替换对话栏（左侧只保留会话列表，≤760px 时侧栏也收起），布局对齐 DSH 的 Trajectory。设置入口在侧栏左下角的「设置」按钮（对话与轨迹视图都能看到），打开后是左侧栏目导航 + 右侧内容的两栏面板：「外观」板块切换跟随系统 / 浅色 / 深色，存在本机浏览器。轨迹面板：

- **顶部时间概览**：把轮次、请求、首字（TTFT）、工具调用、压缩按真实起止时间画成横向色条，按泳道错开，悬停看名称与耗时；一次模型请求会拆成「首字」和「生成」两段。
- **左侧记录账本**：一行一个记录，列为时间 / 类型 / 内容 / **Token** / 耗时。类型与 DSH 一致：**轮次、用户、助手（子 agent 内记为「子助手」）、工具（子工具）、子代理、压缩、审批、重试、错误、用量**；每个模型请求前有细分的「请求 #N（step X）」行，轮次行汇总该轮步数与 `↑输入 ↓输出`。工具调用与结果合并成一行（`→ name 参数 · ✓ 结果`），右侧显示配对耗时；`turn-end` 不显示成行。助手行在 Token 列显示 `↑输入 ↓输出`（前缀 `~` 表示运行时估算），压缩行显示摘要请求的用量。支持按「助手 / 工具 / 审批 / 提问 / 错误 / 上下文」筛选。
- **右侧检查器**：选中一行后显示完整 JSON、耗时、状态与层级。助手行有「本次请求 / 会话累计」两组用量：输入、缓存命中、输出、推理、合计，以及 总耗时 / 首字 / 吞吐（tok/s）；压缩行显示摘要请求用量；轮次行显示本轮用量。
- **子 agent 归属**：子 agent 的助手、工具、用量事件带 `depth` 冒泡到父轨迹，插入 `┌ 子代理` / `└ 结束` 行并缩进；子 agent 的 token 同时计入父轮 `turn-end` 和会话总计。
- **顶部汇总**：`N 轮 · M 请求 · ↑输入 ↓输出 · 缓存 X · 合计 Y · 耗时`；右上角「导出」下载汇总与全部事件。

轨迹实时更新，并落盘在 `.agent/sessions/<id>.events.jsonl`（只记结构性事件，流式文本不重复存；工具结果截断到 2KB），刷新后可查。每个模型请求写一条 `usage` 记录（`step` / `purpose: turn | compaction` / `model` / `durationMs` / `ttftMs` / `attempts`，以及 `promptTokens` / `completionTokens` / `cachedTokens` / `reasoningTokens` / `totalTokens` / `estimated`），压缩请求和子 agent 请求同样记账；`turn-end` 带本轮合计。provider 不返回 usage 时，运行时按字符估算并标记 `estimated`；旧轨迹只有 `turn-end` 总量时也能回退汇总。命令行用 `--trace <id>` 或 REPL 的 `/trace` 看同一份数据（含请求编号、每请求 token/缓存/首字与会话累计），`/sessions` 也会显示每会话的轮数与 token。

### 模型设置

模型是全局开关：对话输入框左侧的模型徽标点开是一个下拉菜单，只列**已启用清单**里的模型（`.agent/settings.json` 的 `models` 数组，见下），当前使用中的会标出来，其余项带上厂商标签；点任意一项即全局切换，当前会话从下一回合开始使用，新建或切到其他会话也用同一个模型。清单为空时只兜底显示当前正在用的模型。预设只是快速配置的入口，不会自动出现在这个菜单里；菜单底部「管理已启用模型…」进入设置面板的模型板块。

设置面板是左侧栏目导航（外观 / 模型）+ 右侧内容：外观只做主题切换（即时生效，不需要保存，保存按钮自动隐藏）；模型板块再分两栏，左栏是云厂商预设列表，右栏是选中预设的具体信息（协议、Base URL、模型、API Key）。内置 DeepSeek、OpenAI、通义千问、火山方舟、Moonshot Kimi、智谱 GLM、硅基流动、阶跃星辰、本地 Ollama、离线 Mock 与自定义网关共 16 个快捷预设，点一下预设即带出协议、Base URL 和候选模型。模型字段是下拉框，列出候选与刷新到的全部模型，末尾的「其他（手动输入）…」可手填任意名称。填好后点「启用该模型」把它加入已启用清单（只登记、不切换当前模型），右栏下方的「已启用的模型」列表可对每项「使用」（全局切换）或「移除」；直接点「保存」则既切换当前模型也把它登记进清单。

Coding Plan 使用套餐专属端点，和按量计费地址不能混用，面板里单独提供 **火山方舟 Coding**（`/api/coding/v3`，用 `/api/v3` 会额外计费）、**Kimi Code**（国内 `https://api.kimi.com/coding/v1` / 海外 `https://api.kimi.ai/coding/v1`，模型固定 `kimi-for-coding`）和 **智谱 GLM Coding**（国内 `https://open.bigmodel.cn/api/coding/paas/v4` / 海外 `https://api.z.ai/api/coding/paas/v4`，不能用 `/api/paas/v4`）预设；模型仍可按套餐账号权限通过「刷新模型」重新拉取。

模型列表可以随时更新：点模型下拉右侧的「刷新模型」，服务端会带上表单里填的 Key（留空则用该端点已保存的 Key）请求 `{baseUrl}/models`，把厂商当前可用的模型全部填进下拉（保留原选中项），10 秒超时；失败时在下拉下方显示 HTTP 状态或连接错误，不会覆盖已填内容。刷新结果会缓存，供「启用该模型」时挑选。

配置保存在工作目录的 `.agent/settings.json`，`models` 就是发送框下拉读取的已启用清单：

```json
{
  "provider": "deepseek",
  "model": "deepseek-reasoner",
  "baseUrl": "https://api.deepseek.com",
  "models": [
    { "provider": "deepseek", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat" },
    { "provider": "deepseek", "baseUrl": "https://api.deepseek.com", "model": "deepseek-reasoner" }
  ]
}
```

切换后空闲会话立即重建 runtime，正在跑的回合结束后生效。配置优先级为 **CLI 参数 > `.agent/settings.json` > 环境变量 / `.env` > 内置默认值**。

API Key 按端点存放在 `.agent/keys.json`（权限 `0600`），切换厂商不会串用旧 Key。密钥只写不读：`GET /api/settings` 只返回 `hasKey`、已保存密钥的端点列表 `keyed` 和已启用清单 `enabled`（不含密钥），面板里的密钥框留空表示沿用该端点已保存的密钥。`POST /api/settings/enabled` 登记一个模型（可顺带写 Key），`DELETE /api/settings/enabled` 移除一个，都不改动当前生效的模型。密钥以明文保存，请像对待 `.env` 一样不要提交它。

## Agent 循环

`src/core/agent.ts` 的 `run()` 就是一个异步生成器，事件即接口：

```
user 消息入栈
loop step = 1..maxSteps:
  估算 token → 超阈值就先压缩（摘要请求也记用量）
  调 provider.stream(messages, tools)       // 流式文本 / 推理 / tool_call
  记录本次请求的 usage / 首字 / 耗时（缺 usage 时估算并标记）
  assistant 消息入栈
  没有 tool_call → turn-end（本轮合计），结束
  对每个 tool_call:
     审批（write/exec）→ 执行 → 结果截断 → tool 消息入栈
  继续下一 step
```

所有状态都在 `messages` 数组里：没有隐藏内存，会话可重放、可恢复、可 fork。每个事件（`text-delta`、`usage`、`assistant`、`tool-call`、`tool-result`、`approval-request`、`compaction`、`turn-end`、`error`）都同时通过 `yield` 和 `onEvent` 暴露，并带上 `depth`（主 agent 为 0，子 agent 逐层递增），CLI / Web / 测试共用同一套协议。

## 关键机制

**上下文压缩**（`core/context.ts`）：按字符估算 token（中文按 1、其余按 1/4），超过 `window × threshold` 时把较早的对话交给模型生成摘要，替换成一条 system 消息，保留最近 `keepRecent` 条原文。摘要请求本身也记 usage（含估算）和耗时；压缩后会重写 JSONL，保证恢复出来的状态和内存一致。

**权限审批**（`core/approval.ts` + `core/rules.ts` + `agent.ts`）：工具声明 `read` / `write` / `exec` 风险等级；只读工具直接执行，写与执行在 `ask` 模式下先发 `approval-request` 事件再等待决定。`--auto` 放行，`--deny` 全部拒绝。「始终允许」把规则按工作目录写进 `.agent/permissions.json`（`bash:<完整命令>` 或 `<写工具>:<目录>`），重启后仍生效，Web 与 CLI 共享；命中规则只跳过询问，deny 策略和当次拒绝仍然优先。设置 → 权限列出全部规则，可单条移除或两次点击清空。详见 [docs/approval-card.md](docs/approval-card.md)。

**路径沙箱**（`tools/fs.ts`）：所有文件工具都把路径解析到工作目录内，`../` 与绝对路径越界直接报错。`bash` 另有灾难命令黑名单（`rm -rf /`、`mkfs`、写裸设备、fork bomb），不依赖审批也会拒绝。

**编辑容错**（`core/edit-match.ts` + `tools/fs.ts` + `core/diff.ts`）：`edit_file` 仍以精确匹配优先，只有精确找不到时才回退到一次刻意收窄的空白容错匹配——只规范化行首缩进、行尾空白与行尾符（行内空格差异不算相等），匹配区间必须是整行、片段去掉首尾空白不少于 10 字符、规范化后的候选必须唯一，多候选直接报错而不是猜第一个。成功后 `new_string` 按匹配到的缩进差重映射：行数对齐就逐行套用各自的差（模型少缩进 4 格不会把文件改成阶梯状，原来 8 空格的行替换后仍是 8 空格），行数不一致时只套用首个非空行的统一差；tab 与空格互不包含就不动；区域内出现过 CRLF 就把替换还原成 CRLF。工具结果会标注 `(whitespace-tolerant match)`，审批卡片的 diff 走同一套 `resolveEdit` / `replacePlan`，看到的就是会写进文件的内容。详见 [docs/edit-fuzzy.md](docs/edit-fuzzy.md)。

**大仓检索**（`tools/ripgrep.ts` + `tools/fs.ts`）：`grep_files` 在检测到 ripgrep 时优先 spawn rg（`--sort=path` 保证与 JS walk 相同的确定顺序），跳过目录、隐藏文件、文件大小上限与输出格式都对齐原有语义；rg 缺失、拒绝模式（如 JS 独有的 lookahead）、超时或输出超限一律回退 JS 全量 walk，工具契约仍是 JavaScript 正则。`AGENT_NO_RG=1` 强制走 JS，`AGENT_RG_PATH` 指定二进制。详见 [docs/search.md](docs/search.md)。

**内置网页抓取**（`tools/web_fetch.ts`）：`web_fetch` 用 Node 自带的 `fetch`（运行时零第三方依赖这条不破）拉单个已知 URL，正文按 chunk 流式读到约 1.5MB 上限就停，HTML 去掉 script/style/标签转成近似纯文本，再按 `maxChars`（默认 5 万字符）截断并在头部报告实际拿到了多少；跳转用 `redirect: 'manual'` 逐跳重验——只允许 http(s)，`localhost`、回环、RFC1918、169.254/16 与 `*.local`/`*.internal` 一律拒（防 SSRF 的尽力而为版，挡不住 DNS 之后才解析到内网的名字），最多 5 跳；超时 30 秒/跳。二进制（image/video/audio/pdf）不解码，只报一行占位。WebSearch 不属于这个工具——它要先定搜索后端，留待后续。

**运行时录制**（`providers/recording.ts` + `core/setup.ts`）：`AGENT_RECORD=1`（或 `AGENT_RECORD_DIR=<目录>`）开启网关调试录制：`createRuntime` 把 provider 包一层，每次模型调用的完整请求与原始事件流（含失败状态、Retry-After、半截流）dump 成 `.agent/recordings/` 下的可读 JSON；压缩与子 agent 复用同一 provider 自动入录，写盘失败 fail-open 不影响对话。与 bench 的指纹录制是两套东西：这个供人排查，不参与回放。详见 [docs/recording.md](docs/recording.md)。

**子 agent**（`tools/task.ts` + `agent.ts` + `core/subagents.ts`）：`task` 工具起一个独立上下文的子 agent，可路由——`agent` 选预设（`general` 继承父工具/模型，`explore` 只读检索、工具收窄到读文件类）、`model` 在同一网关做模型分层（简单检索用更便宜的模型）、`tools` 给最小权限白名单（与父能力取交集，绝不越权）。递归靠去掉子集里的 `task` 阻断，默认仍只允许一层；同一条回复里的多个委派并行跑（槽位限流，默认 3），每个委派的活动按调用顺序成块上报。子 agent 继承父轮预算，其审批、工具、助手文本和用量带 `depth` 冒泡到父轨迹并计入父轮合计，但正文不污染父回答。完整链路见 [docs/subagents.md](docs/subagents.md)。

**声明式子 agent 预设**（`core/subagents.ts` + `core/frontmatter.ts` + `agent.ts`）：预设不只内置两个——`.agent/agents/<name>.md` 一个文件就是一个常驻角色，frontmatter 写 `description`（路由依据）、`tools` 白名单、可选 `model`，正文就是它的人格。`subagentPresets(cwd)` 把它接在内置之后、同名文件就地替换内置项，`createRuntime` 与记忆同一个时机**每轮重读目录**，所以新增文件不用重启会话。路由语义完全沿用既有的最小权限装配：文件预设拿不到父级没有的工具，也不能写记忆；两处诚实报错——预设名不存在时列出当前真实可用的名字，白名单与父能力交集为空（典型是工具名写错）时直接报错而不是放一个没工具的孩子出去。系统提示词里的预设清单动态生成，只有存在文件预设时才多一句「合适就直接路由，别重述角色」；CLI `/agents` 看同一份目录。文件名不是 slug 的（`README.md`）当人看的说明，不进目录；读取全程 fail-open。详见 [docs/agent-presets.md](docs/agent-presets.md)。

**并行只读与并行委派**（`agent.ts` + `core/semaphore.ts`）：一条消息里连续的 `read` 风险调用（除 `ask_user`、`todo_write`）用 `Promise.all` 并发执行，`task` 委派也加入同批——各子 agent 上下文独立，互不污染。父 agent 用一个计数信号量给并发委派限流（`maxConcurrentSubagents`，env `AGENT_MAX_CONCURRENT_SUBAGENTS`，默认 3），批里的委派先拿槽位再开始执行，所以排队不消耗它自己的工具超时。`tool-call` 事件先按调用顺序发出，结果与缓冲事件再按调用顺序回放，转录消息也按调用顺序入栈，完成先后不影响可读性；两个以上委派同批时，每个委派的嵌套活动先进入该调用的缓冲区、轮到它时一次冲刷，轨迹里是一委派一块而不是互相穿插（单独一个委派仍实时流式）。写/执行/交互类保持串行，`approval-request`/`approval-decision` 永不缓冲，并由一个 1 槽信号量（父与所有子共用）保证「一次只问一件事」——Web 只有一张审批卡、CLI 只有一条 readline。

**计划状态**（`tools/todo.ts` + `agent.ts`）：`todo_write` 是状态型工具，由 Agent 拦截而非真正执行：校验后全量替换 `agent.plan()`（至多一项 `in_progress`、≤20 项），发布 `todo` 事件并写入轨迹，CLI 与 Web 轨迹都渲染计划行与明细；返回给模型的是带 `[ ]/[~]/[x]` 标记的当前清单。子 agent 不携带该工具，它也不参与并发批处理。

**每轮预算**（`agent.ts` + `config.ts`）：除 `maxSteps`（24）与单请求 `maxTokens` 外，可设整轮上限 `maxTurnTokens` / `maxTurnMs`（env `AGENT_MAX_TURN_TOKENS` / `AGENT_MAX_TURN_MS`，默认不限）。预算在 step 之间检查：token 计累计输入+输出（含子 agent 用量），时间计 wall-clock；超限先让当前 step 完整结束，再正常收尾发布 `turn-end status: 'budget'`（不是 error，不留悬空 tool_call）。CLI 打印「预算收尾」、Web 对话给提示且轨迹轮次标「预算」。

**瞬时错误重试**（`agent.ts`）：`ProviderError` 的 429/5xx、网络层失败会在**还没输出任何内容**时重试（默认 2 次，指数退避，`AGENT_MAX_RETRIES` 可调）；一旦已经流出了文本就不再重试，避免把半截回答重放两遍。401/403 这类确定性错误不重试。

**会话持久化**（`session/store.ts`）：一行一个 JSON 记录（meta / message / compaction），追加写；压缩时原子重写为「摘要 + 保留消息」的新基线。相邻的 `<id>.events.jsonl` 是轨迹：turn / step / 工具调用 / 审批 / 压缩 / 重试 / usage / turn-end，每行带 `at` 时间戳；`SessionStore.list()` 会顺带汇总 trace 里的每请求用量，得到会话级 `turns` 与 `usage`（输入、输出、缓存、推理、请求数、是否含估算）。Web 端通过 `/api/sessions/:id/trace` 读取事件和汇总，刷新/恢复后 token 账目不会丢。

**会话管理**（`session/store.ts` + `web/server.ts`）：侧栏每个会话的「⋯」菜单支持内联重命名、新建分支与二次确认删除；用户消息旁还可「从此处分支」。重命名只改 meta 并保留文件 mtime，列表顺序不跳；删除同时移除转录与轨迹；分支复制前 N 条消息到新会话（`keep` 省略即全量、`0` 即空分支），新会话有独立 id / 时间且不继承轨迹与成本，原会话完全不动——因此 rewind 是非破坏性的。运行中的会话拒绝 rename / fork / delete（409）。CLI 对应 `/rename`、`/fork [keep]`、`/delete <id>`。完整语义与边界见 [docs/session-management.md](docs/session-management.md)。

**工作区快照**（`core/checkpoint.ts` + `agent.ts` + `web/server.ts` + `cli.ts`）：每个主 agent 回合开始前，用独立 shadow 仓库（`.agent/checkpoints/`，从不碰用户的 `.git`）提交一次工作区，提交 hash 写进 `turn-start.checkpoint` 随轨迹持久化；`node_modules/`、`dist/`、`.agent/` 等重目录与工作区 `.gitignore` 一起排除。用户消息旁的「回滚文件并分支」或 `/fork [keep] --restore` 把文件恢复到那条消息之前的快照——恢复前自动再做一次安全快照（`pre-restore` 分支），回滚本身可撤销；不选回滚的普通分支仍只复制对话、文件不动。`git` 缺失、初始化失败或命令超时全部 fail-open（这一轮不做快照，对话照常进行）；`AGENT_CHECKPOINT=0` 关闭，`AGENT_GIT_PATH` 指定二进制。详见 [docs/checkpoints.md](docs/checkpoints.md)。

**项目规则**（`core/instructions.ts` + `core/setup.ts`）：`createRuntime` 读取工作目录下的 `AGENTS.md`，去空白后经 `composeInstructions` 拼在系统提示词末尾——这是仓库对 agent 的长期约定（用什么包管理器、跑哪些命令、有哪些禁区），CLI、Web、bench 共用同一条 runtime 链路所以自动生效。文件缺失或为空则整段省略，不注入噪声。子 agent 委派时会把同一份规则附在它的角色提示之后，确保孩子不会违反父级已知的仓库约定。完整说明见 [docs/project-rules.md](docs/project-rules.md)。

**跨会话记忆**（`core/memory.ts` + `tools/memory.ts` + `agent.ts`）：agent 在这个工作目录学到的东西存成 `.agent/memory/<slug>.md`，一条一个文件——frontmatter 记 `name/description/kind`，正文是短笔记，人和模型一起读，`.agent/` 已在 gitignore 里所以不随仓库提交。`createRuntime` 给 Agent 一个 `memoryIndex` 渲染函数，**每轮开始重读目录**、把摘要列表注进系统提示词（上限 60 条 / 约 4000 字符，只给摘要不给正文，细节用 `read_file` 取），因此这一轮写下的笔记下一轮就在，不需要重启会话。写入走 `remember` 工具（risk `write`，`write` / `remove`）：审批规则按条目记（`remember:write:<name>` 与 `remember:remove:<name>` 互不相干），这是 `ToolDefinition` 新增可选 `ruleKeyFor` / `summaryFor` 的用处。子 agent 看得到摘要但没有 `remember`——孩子汇报，父级决定什么值得记。目录缺失、frontmatter 损坏、渲染函数抛错一律 fail-open；手写文件按「第一行当摘要」继续索引。CLI 用 `/memory [name]` 看、`/forget <name>` 删。完整语义与边界见 [docs/memory.md](docs/memory.md)。

**工具钩子**（`core/hooks.ts` + `.agent/hooks.json`）：在工具生命周期上挂 shell 命令，对齐 Claude Code 的做法。`PreToolUse` 在审批与执行之前跑，可 `block`（直接返回错误、不执行工具）、`allow`（跳过交互式审批，但 `deny` 策略仍优先）或中性放行；`PostToolUse` 在工具成功后跑，可把结果 `block` 标记为错误回灌模型，或追加上下文。钩子用 `bash -c` 执行，事件 JSON（工具名/参数/输出）走 stdin，决策由退出码或 stdout JSON 表达：`exit 2` 或 `{"decision":"block","reason":…}` 拦截、`{"decision":"allow"}` 放行、其它非零退出与超时/中断一律 **fail-open**（坏钩子不拖垮回合）。`matcher` 按工具名精确匹配或 `*` 通配；没有匹配项就不起进程，默认（无 hooks.json）零开销。子 agent 继承同一套钩子。详见 [docs/hooks.md](docs/hooks.md)。

**MCP 外部工具**（`src/mcp/` + `.agent/mcp.json`）：启动时按配置 spawn 每个 stdio MCP 服务器，走 `initialize` + `tools/list` 握手，把服务器工具转换成普通工具注入注册表——名称 `mcp__<server>__<tool>`，参数沿用其 `inputSchema`，风险等级按服务器配置（默认 `exec`，需审批）。模型侧看到的就是普通工具：审批、并行、钩子、轨迹与子 agent 全部复用现有链路。任何一个服务器 spawn 失败、握手失败或超时都只记一条告警并跳过，不影响其余服务器与 harness 启动；没有配置时不 spawn 任何进程。工具集在进程启动时固定，重启才刷新。完整说明见 [docs/mcp.md](docs/mcp.md)。

**图片输入**（`providers/content.ts` + `web/server.ts`）：user 消息的 content 可以是 `string | ContentPart[]`，一条消息最多带 4 张图片；OpenAI 兼容层把图片映射成 `image_url` 的 data URL，assistant / tool / system 仍保持纯文本。上下文按每张 1200 token 估算，生成摘要时图片只写 `[image: mime]` 占位符，不把 base64 带进摘要请求；会话把 parts 原样写进 JSONL，纯图片消息标题回退为 `[N 张图片]`。Web 输入框支持选择、粘贴与拖入，浏览器先按最长边 1600px 缩放再上传，服务端校验数量、MIME、base64 与单图 4MB / 请求体 24MB；当前模型声明不支持图片时附件入口直接禁用。完整说明见 [docs/multimodal.md](docs/multimodal.md)。

**成本核算**（`core/pricing.ts` + `core/setup.ts` + `session/store.ts`）：每个已启用模型可在设置里填「输入 / 输出 / 缓存」单价与 USD/CNY 币种（每百万 tokens），随 `.agent/settings.json` 持久化。每次请求结束按当时单价把用量折成金额，作为 `cost` 快照写进 `usage` 事件——缓存部分先从输入里切出、按缓存价计，推理已含在输出里不重复收费；压缩请求与子 agent 同样计价，之后改价不会改写历史轨迹。轨迹摘要、Token 列 tooltip、检查器用量面板、会话列表与 CLI `sessions` / `trace` 都展示成本，`summarizeTrace` 按币种分别聚合；没有单价的模型不产生成本，旧轨迹行为不变。完整说明见 [docs/cost.md](docs/cost.md)。

## 内置工具

| 工具 | 风险 | 说明 |
| --- | --- | --- |
| `read_file` | read | 带行号读取，支持 offset/limit |
| `write_file` | write | 创建/覆盖，自动建父目录 |
| `edit_file` | write | 精确字符串替换，歧义时报错；精确失败时只在唯一整行匹配下做空白容错（结果里标注） |
| `list_files` | read | 目录树，跳过 node_modules/.git 等 |
| `glob_files` | read | `**/*.ts` 风格匹配 |
| `grep_files` | read | 正则搜索，`file:line: text`；有 ripgrep 时优先用 rg，失败回退 JS walk |
| `web_fetch` | read | 拉取单个 http(s) 页面并转成近似纯文本；流式截断 + 逐跳校验跳转，拒绝私有/回环地址 |
| `remember` | write | 写/删一条跨会话记忆（`.agent/memory/<slug>.md`），审批规则按条目记（子 agent 不可用） |
| `bash` | exec | `bash -c`（不加载登录 profile），60s 默认超时（超时/中止按错误返回），输出截断 |
| `task` | read | 委派子 agent 并取回报告；可按 `agent` 预设路由（内置 `general`/`explore`，加上 `.agent/agents/*.md` 里自定义的）、`model` 分层、`tools` 最小权限白名单，同批多个委派并行（默认 3 路限流） |
| `ask_user` | read | 向用户弹交互式选择卡，答案回灌给模型（子 agent 不可用） |
| `todo_write` | read | 全量替换当前计划，至多一项 in_progress；发布 `todo` 事件并渲染到轨迹（子 agent 不可用） |

## 扩展

新增工具只要实现 `ToolDefinition`（名称、描述、JSON Schema、风险等级、`execute`），注册进 `ToolRegistry` 即可，模型会自动看到 schema。需要自定义「这一步放行的是什么」的工具再实现两个可选项：`ruleKeyFor` 决定「始终允许」记下的规则键（默认是完整 bash 命令或写操作所在目录，`remember` 用它做到按条目授权），`summaryFor` 决定审批卡上那一行摘要。

新增模型后端只要实现 `ChatProvider`：

```ts
interface ChatProvider {
  readonly id: string
  readonly model: string
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>
}
```

然后在 `providers/index.ts` 里接一行分支。

## 评测台

`bench/` 是任务集 + 断言，同一套任务有两种跑法：

```bash
node bench/run.ts                                # 脚本模型：验证运行时（不需要 key）
node bench/run.ts --provider deepseek            # 真模型：量模型能力
node bench/run.ts --provider deepseek --record   # 真模型 + 录制事件流
node bench/run.ts --replay                       # 回放录制：不联网、不需要 key
node bench/run.ts --only fix-bug,subagent        # 只跑指定任务
node bench/run.ts --json                         # 机器可读结果
node bench/run.ts --verbose --keep               # 打印工具活动、保留临时工作目录
```

| 任务 | 考察点 |
| --- | --- |
| `read-and-answer` | 读文件后的事实准确性 |
| `multi-tool` | grep/glob/read 组合定位 |
| `fix-bug` | 读代码 → 最小修改 → 自己跑测试 |
| `add-feature` | 实现 + 补测试，隐藏测试判定 |
| `large-file` | 5000 行文件必须分页才能找到目标 |
| `sandbox` | 越出工作目录被拒绝 |
| `deny-write` | 拒绝模式下不落盘 |
| `dangerous-bash` | 灾难命令被拦截 |
| `bad-arguments` | 工具参数是残缺 JSON 时循环不崩 |
| `parallel-tools` | 一条消息返回两个 tool_call |
| `retry` | 503 后自动重试（仅脚本模式） |
| `multi-turn` | 先澄清、确认后再改 |
| `subagent` | `task` 委派与结果回传 |
| `tool-timeout` | `sleep 10` 超过 1s 被终止，且按错误上报 |
| `output-truncation` | 10 万字符输出被压到 3 万以内并保留头尾 |
| `abort-turn` | 流式输出途中 abort：只留用户消息，不留半截回答 |
| `compaction` | 长上下文自动压缩后继续工作 |

每个任务在独立的临时目录里跑，断言看的是**结果**（文件内容、`node --test` 退出码、最终回答）而不是模型说了什么，所以同一套任务可以换不同模型对比。脚本模式覆盖的是运行时行为；真模型模式才代表模型质量。`scriptOnly` 的任务（模拟协议错误、瞬时失败）在真模型模式下会跳过，避免把运行时测试算进模型分数。

**录制 / 回放**：`--record` 需要真模型，任务通过后把该任务的 provider 事件流写进 `bench/transcripts/<task>.json`；`--replay` 用这些文件重跑断言，不联网、不需要 key，适合放进 CI。回放会校验每次请求的指纹（提示词、工具集、历史结构；工作目录路径已归一化），fixture 或 prompt 改了会直接报 `replay drift`，而不是静默跑偏。没有录制的任务在回放模式下自动跳过。

加任务只需要实现 `BenchTask`（`bench/types.ts`）：写 fixture、给 prompt、给断言；可选提供 `script` 让它在无 key 时也能跑。

## 测试

```bash
node --test test/*.test.ts   # 219 个用例，约 8s
node bench/run.ts            # 17 个评测任务
pnpm typecheck               # tsc --noEmit
```

覆盖：工具循环、未知工具、并行只读并发与调用顺序、并发委派（同批一起跑与按调用顺序成块、超出槽位先排队、并发子 agent 的审批提示一次只出一个且实时送达、单独委派不被缓冲）、todo_write 计划替换/校验/串行、每轮 token/时间预算 graceful 收尾与 env 解析、审批拒绝、审批放行、步数上限、子 agent、token 估算、按请求记录 usage/首字/耗时、provider 缺 usage 时的估算兜底、子 agent 用量冒泡与父轮合计、子 agent 预设路由（`explore` 只读白名单）、最小权限工具交集不越权、`model` 分层进子请求与事件标签、`request.model` 覆盖与默认回退、未知 `agent` 预设报错、`AGENTS.md` 项目规则读取（存在/缺失/空白）与合并顺序、`createRuntime` 把规则拼进系统提示词、子 agent 继承父级项目规则、工具钩子解释器（exit2/JSON block/allow/中性 context、非零与超时 fail-open、matcher 通配与精确、stdin 携带调用、readHooks 存在/缺失/非法）、PreToolUse 拦截阻止执行与 allow 跳过审批但 deny 优先、PostToolUse 把成功结果标错回灌、MCP 配置校验（非法名/缺 command 丢弃、非法 risk 只丢字段）、假 stdio 服务器握手与 `tools/list` / `tools/call` 映射、坏服务器与超时 fail-open、`createRuntime` 合并 extraTools 且跳过重名、摘要压缩与压缩请求记账、压缩后会话恢复、SSE 流解析（文本/推理/工具调用/usage/DeepSeek 缓存字段）、HTTP 错误、路径越界、危险命令、glob/grep/edit 边界、瞬时错误重试与「已输出后不重试」、录制/回放与请求指纹、工具超时按错误上报、超长输出截断（含落盘的历史消息）、会话 token 汇总与旧轨迹回退、轨迹面板 DOM（jsdom 里点开轨迹断言轮次/请求/用户/助手/工具/Token 列/检查器用量与累计，以及实时 SSE 追加后的汇总更新）、全局模型切换（发送框菜单只列已启用清单、点选即全局生效、设置面板左导航+右内容且模型板块预设/详情两栏、启用/使用/移除清单、预设快捷填充、刷新后下拉列出全部模型、密钥不回显、Esc 关闭）、外观板块主题即时切换与跟随系统、`/api/settings`（持久化、空闲会话立即重建 runtime、非法输入 400）、按端点保存 Key 与 `keyed` 列表、`/api/settings/enabled`（登记/移除不改动当前模型、重复登记保持顺序、清空后不复活、GET 不携带密钥）、`/api/settings/models`（读取厂商 `/models`、401/超时按 502 上报）、图片输入（content parts 文本/图片读取、OpenAI `image_url` 线格式、`run()` 附件与 `turn-start.attachments`、无图保持字符串、每图 1200 token 估算与摘要占位符不泄漏 base64、会话 parts 持久化与纯图片标题、图片-only SSE 回合、附件 API 400/413 校验矩阵、历史缩略图渲染、模型能力门控附件按钮、成本核算（计价公式与缓存切分、无缓存价回退、解析校验、同名模型端点优先、单价持久化/保留/显式清除、设置 API 往返、`usage` 事件成本快照、轨迹按币种聚合、设置面板单价回显与清空、已启用列表徽标、轨迹与会话列表成本展示、会话管理（store 重命名保留 mtime 与清空回退、同毫秒时间戳按 id 兜底排序、删除转录与轨迹、分支前缀/全量/空分支/越界校验、PATCH/DELETE/fork API 与运行中 409、侧栏菜单内联重命名与二次确认删除、用户消息分支预填）、Retry-After 头解析（秒数/三种 HTTP-date/垃圾值）与重试延迟取大封顶、grep_files ripgrep 优先（参数映射、结果上限、拒绝模式与坏路径回退、后端开关、真 rg 与 JS walk 输出一致）、运行时录制开关（目录解析与优先级、请求/事件落盘、失败记录重抛、写盘 fail-open、createRuntime 按开关包装）、工作区快照（快照/恢复往返、空工作区锚点、排除目录不动、未知快照拒绝、无 git 与开关关闭降级、每主轮一次且子 agent 不拍、压缩轨迹后缀对齐与文本漂移 fail-safe、fork `restoreFiles` 端到端与无快照回退、Web 两次点击确认与回执）、权限规则持久化（宽容读取缺失/损坏/重复文件、add/remove/clear 落盘与跨实例读取、规则门禁预检与 always 记忆、无 store 保留内存语义、`/api/settings` 返回规则、单条移除/清空 API 与非法输入 400、设置权限板块列表与二次确认清空、edit 空白容错（精确优先与整行唯一回退、最短片段门槛、行内空白不等价、逐行与统一缩进重映射、CRLF 保持、tab 与空格不强改、审批 diff 与执行同源）、跨会话记忆（frontmatter 往返、手写与损坏文件降级索引、slug 归一并挡住目录穿越、同名覆盖、空/超长正文拒绝且原文件不动、索引上限与省略提示、`remember` 各分支、按条目的审批规则键、本轮写入下轮进入系统提示词、`memoryIndex` 抛错不拖垮回合、子 agent 能看不能写）、声明式子 agent 预设（frontmatter 与别名解析、缺字段回退、非法名/越界/超大文件与 `README.md` 不进目录、同名文件就地替换内置、经 `task` 路由时人格/白名单/模型三者都落到子请求、未知名报错列出可用预设、白名单与父能力无交集时报错、回合中新文件进入下一轮提示词、提供函数抛错回退内置且回合不中断））。

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 push / PR 上跑：`pnpm install --frozen-lockfile` → `typecheck` → `test` → `bench`（脚本模型基线）→ 若 `bench/transcripts/*.json` 存在则 `node bench/run.ts --replay`，没有就打印 notice 跳过。Node 用 24（和本地一样直接跑 TS），带 pnpm 缓存和 concurrency 取消。

录制并提交后，CI 就会自动多一层「模型行为」回归：

```bash
node bench/run.ts --provider deepseek --record
git add bench/transcripts && git commit -m "record model baseline"
```

工作流假设本目录是仓库根；如果仓库根是上层目录，把 `.github/` 移到根目录，并给 job 加 `defaults.run.working-directory: agent`。

## 打包与分发

`pnpm build` 用 tsc 把 `src/` 编译到 `dist/`（`rewriteRelativeImportExtensions` 负责把 `.ts` 后缀改成 `.js`），再把 Web 静态页复制进 `dist/web/public/`。运行时零依赖，所以安装包只有编译产物。

```bash
pnpm build                 # -> dist/
npm pack                   # -> oarlock-0.1.0.tgz
npx ./oarlock-0.1.0.tgz --help

npm i -g ./oarlock-0.1.0.tgz
oarlock                     # 已安装的命令
```

要发布到 npm，去掉 `package.json` 里的 `"private": true` 再 `npm publish`。

Docker 用多阶段构建，运行镜像里只有 `dist/` 和 `package.json`（约 230MB，基于 `node:24-slim`，保留 bash）：

```bash
docker build -t oarlock .

# 交互式 CLI / 单轮，挂载工作目录
docker run --rm -it -v "$PWD:/work" -w /work oarlock
docker run --rm -v "$PWD:/work" -w /work oarlock --once "解释这个仓库"

# Web UI
docker run --rm -p 4173:4173 --entrypoint node oarlock \
  /app/dist/web/server.js --host 0.0.0.0 --port 4173
```

容器里没有 key，用 `-e DEEPSEEK_API_KEY=...` 传进去，或者把 `.env` 挂载到工作目录。

## 已知限制

- token 估算和缺 usage 时的兜底都是启发式的，不接 tiktoken；长上下文场景建议按模型实际窗口调 `AGENT_CONTEXT_WINDOW`。真实用量以 provider 返回的 `usage` 为准，轨迹里带 `~` 的行是估算值。
- 缓存只记录 provider 明确上报的命中量（DeepSeek `prompt_cache_hit_tokens` / OpenAI `prompt_tokens_details.cached_tokens`）；DeepSeek/OpenAI 不报 cache write，因此不伪造该字段。
- 连续的只读工具与 `task` 委派会并发执行（委派默认 3 路并发），写/执行/交互类（`ask_user`、`todo_write`）仍串行；事件与转录按模型调用顺序输出，一次只问一个审批。
- Web 端一次只跑一个 turn，不支持同一会话并发。
- 没有做流式 markdown 渲染，正文按纯文本展示。
- 子 agent 默认只有一层，`maxDepth` 可调，但更深层会放大 token 消耗。
