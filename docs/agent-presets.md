# 声明式子 agent 预设（`.agent/agents/*.md`）

`task` 委派的内置预设只有两个：`general` 和 `explore`。它们够通用，但不够了解你的项目——一个只有这个仓库才知道的角色（发布检查员、只看某个模块的检索员、按团队约定写文档的写手）不该每次都在 prompt 里重新解释。预设注册表把这些角色固化成文件：往 `.agent/agents/` 放一个 markdown，父 agent 的系统提示词里就多一个可路由的 `agent` 名字。

## 文件格式

```markdown
---
name: summarizer
description: 把长文压成要点，只读不改
tools: read_file grep_files
model: cheap-model
---

You compress documents into bullet points.
Quote nothing you did not read; cite file:line for every claim.
```

- 正文是这个子 agent 的人格（取代内置的通用 `SUBAGENT_PROMPT`），父对话不会传给它。
- `description` 是路由依据，写清楚「什么时候该用它」；缺省取正文第一行非空文本。
- `name` 是实际路由名（缺省用文件名），必须是小写 slug；`tools`（或别名 `allowed-tools`）接受空格、逗号或方括号列表，工具名保留下划线，非法名字直接丢弃。`model` 可省略。
- 内置的 `general` / `explore` 不写 `model`：模型名是网关相关的，廉价层靠只读白名单实现。文件预设的作者知道自己网关上有什么模型，所以允许写。
- 文件名不是 slug 的（`README.md`、`Notes.md`）视为给人看的说明，不进目录。

## 加载与优先级

`subagentPresets(cwd)` = 内置预设 + 这个目录的 `.agent/agents/*.md`，同名文件**就地替换**内置项（顺序不变），其余文件按名字排在内置之后。`Agent` 通过 `subagentPresets: () => subagentPresets(cwd)` 拿到目录，与跨会话记忆同一个时机——**每个回合开始重读一次**，所以新增或修改文件不需要重启会话；`setup.ts` 里已经接好，CLI、Web、bench 共用。

读取全部 fail-open：目录缺失、文件读不出、frontmatter 坏掉、名字非法、文件过大（>32KB）都只跳过那一个；提供函数本身抛错时退回内置预设，回合照常进行。上限：单次最多 32 个文件、人格正文截到 6000 字符、描述 200 字符、工具名 40 个。

## 路由与最小权限

`spawnSubagent` 用当前目录解析 `agent`（大小写不敏感），命中后与既有语义完全一致：

- 工具集仍是「父能力去掉 `task`/`ask_user`/`todo_write`/`remember`，再与 `tools` 白名单取交集」，文件预设**不可能**给子 agent 加一个父级没有的工具，也不能写记忆。
- 模型优先级仍是「调用方显式 `model` > 预设 `model` > 继承父级」。
- 人格仍是 `preset.systemPrompt + Task: <description>`，之后再附记忆摘要与 `AGENTS.md` 项目规则。

两处诚实报错，避免出现「看起来配了但什么都不做」的子 agent：

- `agent` 名字不存在 → `unknown agent preset: <name>. Available: …`，列出当前目录真实可用的预设。
- 白名单非空但与父能力交集为空（典型是工具名写错，如 `read_filez`）→ 直接报错并说明它只允许哪些工具、父级实际有哪些，而不是放一个没有工具的孩子出去。

系统提示词里 `agent` 的清单随目录动态生成；只有确实存在文件预设时，才额外加一句「这些是本工作区作者写好的常驻人格，合适就直接路由，别在 prompt 里重述角色」。`/agents` 在命令行里列出同一份目录，标注来源（内置 / `.agent/agents/<file>.md`）、工具白名单与模型。

## 边界

- 预设只定义人格与能力，不改变委派语义：仍是最多一层（`maxDepth` 默认 1）、预算继承、事件按调用顺序成块、审批一次只问一个。
- `.agent/` 在 gitignore 里，预设目录是这台机器这个仓库的本机状态。要不要把某个预设随仓库分发（那就不再是 `.agent/`，而是提交进版本库的共享配置）由使用者决定，runtime 不代为判断。
- 预设之间不嵌套：文件里再引用别的预设不被支持，避免循环与不可见的权限放大。
- Web 设置面板暂未列出预设（与记忆的 Web 入口一起 deferred），当前用 CLI `/agents` 或直接看目录。

## 验证

- `node --test test/subagent-presets.test.ts`（8 例）：frontmatter 与正文解析、别名与缺省回退、无正文文件仍可用、非法名字/越界名/超大文件跳过、`README.md` 不进目录、文件替换内置且保持顺序、经 `task` 真实路由时人格+白名单+模型三者都落到子请求、未知名报错列出可用项、白名单全无效时报错、回合中新文件进入下一轮提示词、提供函数抛错时回退内置且回合不中断。
- 全量：`node --test test/*.test.ts` 212 用例；`pnpm typecheck`、`pnpm build`、`pnpm bench`（17/17）全绿。
- 真机冒烟：CLI REPL `/agents` 在含 `summarizer.md`、覆写 `explore.md`、`README.md` 的目录里输出三个预设（README 被忽略）；`createRuntime` 装配出的系统提示词包含 `summarizer` 与常驻人格指导。
