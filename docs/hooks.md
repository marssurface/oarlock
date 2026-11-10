# 工具钩子（PreToolUse / PostToolUse）

在工具生命周期上挂用户自己的 shell 命令，用于审计、拦截和回灌。链路是「配置 `.agent/hooks.json` → runtime 载入 → executeTool 前后触发 → 解释退出码/JSON → 影响工具结果」。实现集中在 `src/core/hooks.ts`，接入点在 `src/core/agent.ts` 的 `executeTool`。

## 用途

对齐 Claude Code 的 hooks 设计：模型决定调用某个工具时，用户侧可以插入「先看、可否决、再补话」的外部逻辑，而不改 harness 代码。典型用法——禁止 `rm -rf` 之外的危险 `bash`、给所有 `write_file` 跑一次格式化、对 `read_file` 结果附加 lint 提示。

## 配置（`.agent/hooks.json`）

工作目录（`config.cwd`）下的一份 JSON，两个事件各是一个数组：

```json
{
  "PreToolUse": [
    { "matcher": "bash", "command": "grep -q 'rm -rf' || exit 0; exit 2", "timeoutMs": 5000 }
  ],
  "PostToolUse": [
    { "matcher": "write_file", "command": "npx prettier --check \"$TOOL_PATH\" 2>&1" }
  ]
}
```

- `matcher`（可选，默认 `*`）：工具名精确匹配，或 `*` 匹配所有；没有命中的钩子**不会起进程**。
- `command`（必填）：经 `/bin/bash -c` 执行。
- `timeoutMs`（可选）：单次钩子超时，钳制在 1s–60s，默认 15s。
- `parseHooks` 丢弃缺 `command`、非对象等非法项；文件缺失或无法解析时 `readHooks` 返回 `{ PreToolUse: [], PostToolUse: [] }`，即「无钩子」。

## 输入契约（stdin）

钩子从 stdin 读到一行事件 JSON，字段随事件而变：

- `PreToolUse`：`{ hook_event_name, cwd, tool_name, tool_input }`
- `PostToolUse`：`{ hook_event_name, cwd, tool_name, tool_input, tool_output, is_error }`

## 决策契约（stdout / 退出码）

`interpret`（`hooks.ts`）按优先级把一次钩子运行折成 `HookOutcome`：`block` > `allow` > `neutral`，`context` 累加。

| 情形 | 结果 |
| --- | --- |
| stdout 是 JSON 且 `decision`/`permissionDecision` = `block`/`deny` | `block`，`reason` 取 `reason` 字段，否则 stderr 首行 |
| stdout 是 JSON 且 = `allow`/`approve` | `allow`（仅 PreToolUse 有意义） |
| stdout 是 JSON 且 = `ask` 或无决策字段 | `neutral` |
| 退出码 2（Claude Code 约定） | `block`，`reason` 取 stderr 首行或 stdout 首行 |
| 其它非零退出码 | `neutral`（**fail-open**：坏钩子不拦） |
| 超时 / 被中断 | `neutral`（**fail-open**：不拖垮回合） |
| 退出码 0 且有纯文本 stdout | `neutral` + `context` |

同一事件多条命中钩子会依次执行并折叠：任一 `block` 即 `block`，否则任一 `allow` 即 `allow`，`context` 按序合并。

## 接入（src/core/agent.ts 的 executeTool）

- **PreToolUse** 在审批与执行之前：
  - `block` → 直接 `return { content: 'blocked by PreToolUse hook: …', isError: true }`，工具不执行。
  - `allow` → 跳过交互式审批（不发 `approval-request`、不询问），但 `approval.mode === 'deny'` 的硬性策略仍然优先，allow 不会绕过 deny。
  - `neutral` / `context` → 正常走审批；`context` 会在成功后并入工具结果文本。
- **PostToolUse** 仅在工具成功后运行（抛错的 catch 分支不触发）：
  - `block` → 把已经成功的结果标为 `isError`，追加「PostToolUse hook flagged a problem: …」，回灌模型促其改道。
  - `context` → 追加为 `[hook] …` 行。
  - 运行 PostToolUse 本身再包一层 try，钩子异常绝不污染成功结果。

工具结果内容最终仍是一条 `tool-result`，没有新增事件类型——旧轨迹与 UI 不受影响。

## 子 agent

`spawnSubagent` 把父级 `this.hooks` 原样传给子 Agent，因此委派出去的检索/编辑同样受钩子约束与审计。

## 边界

- 只做 `PreToolUse` / `PostToolUse`；`SessionStart`、`UserPromptSubmit` 未接。
- `allow` 只跳过审批提示，不改变 deny 策略，也不绕过工具白名单/沙箱。
- matcher 只支持 `*` 与工具名精确匹配，暂不支持正则或多名列表。
- 钩子输出按文本处理，不解析 Claude Code 更细的 `hookSpecificOutput` 结构。
- MCP 工具（`mcp__<server>__<tool>`）也是普通工具，PreToolUse / PostToolUse 对它们同样生效（见 [mcp.md](./mcp.md)）。

## 验证

- `test/hooks.test.ts`：`matchesHook` 通配与精确、`parseHooks` 校验、`readHooks` 存在/缺失、单条解释（exit2→block、JSON block/allow、纯文本→neutral+context、非零/未命中→fail-open、stdin 携带 `tool_name`）；Agent 层集成：PreToolUse 拦截使 `write_file` 不落盘、allow 跳过审批且不触碰 ask 门、deny 策略压过 allow、PostToolUse 把成功的 `read_file` 标错并回灌。
- `pnpm typecheck`、`node --test test/*.test.ts`、`npm run build`（同步 `dist/core/hooks.js`）。
