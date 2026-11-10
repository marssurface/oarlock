# 项目规则（AGENTS.md）

让 agent 遵守仓库自身的长期约定：用什么包管理器、怎么跑测试、有哪些禁区。链路是「读文件 → 合并 → 拼进系统提示词 → 委派时继承」，实现集中在 `src/core/instructions.ts` 与 `src/core/setup.ts`。

## 用途

系统提示词原本只描述通用工作方式，不带仓库特定信息。`AGENTS.md` 补齐这一层：一份放在工作目录（`config.cwd`，即启动时的 `--cwd`）的 Markdown，随每个会话进入模型上下文。约定沿用业界 `AGENTS.md` 规范——纯文本、面向 agent 的指令，人和模型都可读。

## 读取（src/core/instructions.ts）

- `readProjectInstructions(cwd)`：读 `resolve(cwd, 'AGENTS.md')`，返回 `trim()` 后的内容。
- 文件缺失、不可读或全空白都返回空串——调用方把「没有文件」和「空文件」当作同一件事，避免向模型注入噪声。
- 只读工作目录这一份，不做向上遍历或嵌套合并（留待后续）。

## 合并与接线（src/core/setup.ts）

`createRuntime` 是所有入口（CLI、Web server、bench）唯一的拼装点，规则在这里注入一次即全线生效：

```ts
const instructions = composeInstructions(readProjectInstructions(config.cwd), options.extraInstructions)
// … new Agent({ …, ...(instructions !== undefined ? { extraInstructions: instructions } : {}) })
```

- `composeInstructions(...parts)` 按顺序拼接非空片段（以空行分隔），全空返回 `undefined`，让 Agent 干脆不带这个字段。
- 片段顺序：`AGENTS.md` 在前，调用方 `extraInstructions` 在后。`AgentOptions.extraInstructions` 通道此前已存在但无人填；现在它承载仓库规则，未来 tool hook 也可复用同一通道。
- Agent 内部由 `buildSystemPrompt({ …, extra })` 把这段追加到「How to work」基线之后，仍是同一条 `role: 'system'` 消息，因此会话历史、轨迹、压缩都不受影响。

## 子 agent 继承（src/core/agent.ts）

子 agent 的 `systemPrompt` 是显式给出的（预设人格 + `Task: …`），不会经过 `buildSystemPrompt`，所以父级规则需要单独转发：

- Agent 构造时把 `options.extraInstructions` 存到 `projectInstructions`。
- `spawnSubagent` 组装子 `systemPrompt` 时，在人格与任务之后追加这份规则：`[persona + Task, projectInstructions].filter(非空).join('\n\n')`。

这样 `explore` / `general` 子 agent 也不会违反父级已知的仓库约定（例如擅自用 npm 而非 pnpm）。

## 边界

- 仅工作目录单文件；嵌套 `AGENTS.md`、全局 `~/.agents/AGENTS.md` 尚未实现（工具钩子见 [hooks.md](./hooks.md)，MCP 见 [mcp.md](./mcp.md)）。
- 规则是提示层约束，不是硬隔离；真正的权限控制仍靠审批门与工具白名单。

## 验证

- `test/instructions.test.ts`：`readProjectInstructions` 的存在/缺失/空白、`composeInstructions` 的顺序与全空返回 `undefined`、`createRuntime` 把 `AGENTS.md` 拼进发给 provider 的系统消息（包裹 `provider.stream` 捕获首个请求断言）、子 agent 继承父级 `extraInstructions`。
- `pnpm typecheck`、`node --test test/*.test.ts`、`npm run build`（同步 `dist/core/instructions.js`）。
