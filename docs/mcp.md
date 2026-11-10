# MCP(stdio) 外部工具服务器

把外部进程提供的模型工具接进 harness，链路是「配置 `.agent/mcp.json` → 启动时 spawn + 握手 → `tools/list` 转成 `ToolDefinition` → `tools/call` 执行」。实现集中在 `src/mcp/`（`config.ts` 配置、`client.ts` JSON-RPC 客户端、`index.ts` 载入与工具转换），接在进程启动处，再经 `createRuntime` 的 `extraTools` 注入工具注册表。

## 用途

工具集原先硬编码在 `ToolRegistry.default()` 里，加一个能力就要改 harness。MCP 提供标准的外部工具协议：给一份服务器配置，模型就能调用这些服务器暴露的工具，审批、并行、轨迹、子 agent 全部复用现有链路，不必为新工具写 TypeScript。

## 配置（`.agent/mcp.json`）

工作目录（`config.cwd`）下的一份 JSON：

```json
{
  "servers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "risk": "read" },
    "db": {
      "command": "node",
      "args": ["./tools/db-mcp.mjs"],
      "env": { "DATABASE_URL": "sqlite:./dev.db" },
      "cwd": "./tools",
      "risk": "write",
      "timeoutMs": 20000
    }
  }
}
```

- `command`（必填）：可执行文件；`args` 可选。
- `env`：与父进程环境合并后传给子进程。
- `cwd`：服务器进程的工作目录，缺省继承 harness。
- `risk`（默认 `exec`）：该服务器**所有**工具的风险等级，决定审批行为。`read` 可不经审批直接执行；`write` / `exec` 在 `ask` 模式下先发 `approval-request`。
- `timeoutMs`（默认 15000）：单次请求（握手 / 列表 / 调用）的超时。
- 服务器名必须匹配 `^[A-Za-z0-9_-]+$`（会进入工具名）；名字非法、缺 `command` 或不是对象的条目被丢弃。`risk` 非法时只丢弃该字段、服务器保留（回落到默认 `exec`）。
- `readMcpConfig` 在文件缺失或 JSON 非法时返回 `{ servers: {} }`，即「不接 MCP」。

## 协议（`client.ts`）

`McpClient` 是最小 stdio 客户端，只用 Node 标准库：

- spawn 服务器，`stdin` / `stdout` / `stderr` 全管道。
- **分帧**：一行一个 JSON-RPC 2.0 消息（`\n` 分隔），按行解析；非法行直接忽略。
- **握手**：`initialize`（`protocolVersion: '2025-06-18'`、`clientInfo: { name: 'dock-agent', version }`）→ `notifications/initialized`。
- **列举**：`tools/list` → 过滤出有 `name` 的条目，保留 `description` / `inputSchema`。
- **调用**：`tools/call`，参数 `{ name, arguments }` → `{ content, structuredContent, isError }`。
- **请求匹配**：自增数字 id 对应 pending map，逐请求计时；超时 reject `McpError`，进程退出时 `failAll` 一次性 reject 所有在途请求。服务器发来的通知与非数字 id 的消息忽略。
- **stderr** 只留最后 8KB 用于错误诊断，不进入模型上下文。

## 工具映射（`index.ts`）

每个服务器列举出的工具转成一个普通 `ToolDefinition`：

- 名称 `mcp__<server>__<tool>`：命名空间避免与内置工具或其他服务器冲突；`createRuntime` 合并时若重名则跳过注入（内置工具优先）。
- `parameters`：把 MCP `inputSchema` 收成 harness 需要的 `{ type:'object', properties, required?, additionalProperties? }`；形状不符时退化为空对象 schema。
- `risk`：取服务器配置，默认 `exec`（保守：未知工具需要审批）。
- `execute`：调 `tools/call`，文本块按序拼成内容；非文本块输出 `[<type>] text`；有 `structuredContent` 时追加其 JSON；全空输出 `(no output)`；`isError: true` 原样标记为失败结果。

工具结果是普通 `tool-result`，pre/post 钩子、输出截断、轨迹与 UI 都照旧生效。

## 生命周期与接线

`loadMcpServers(cwd)` 在 **进程启动时调用一次**（`createRuntime` 是同步函数，不能在里面 await）：

- 每个服务器并行 `connect` + `handshake` + `listTools`；工具与服务器名排序，保证顺序稳定。
- **逐服务器 fail-open**：spawn 失败、握手失败、超时只记录到 `errors` 并跳过该服务器，绝不阻塞其余服务器或 harness 启动。没有任何配置时不 spawn 任何进程。
- CLI 启动时打印 `MCP: <servers>` 与逐条告警；所有 `createRuntime` 调用都带 `extraTools: mcp.tools`。`process.once('exit')` / 退出钩子调用 `mcp.close()`。
- Web 服务在 `createAgentServer` 之前载入，工具通过 `AgentServerOptions.extraTools` 传入每个会话的 runtime；stderr 打印逐条告警。
- `close()` 先 reject 在途请求，再关 stdin、发 `SIGTERM`，500ms 后 `SIGKILL` 兜底（定时器 `unref`，不拖住事件循环）。

## 子 agent

子 agent 的工具来自父级注册表（去掉 `task` / `ask_user` / `todo_write` 后与白名单取交），因此 MCP 工具会自动传播：`general` 子 agent 能调用父级可见的 MCP 工具，`explore` 的只读收窄会把它们排除。

## 边界

- 只做 **stdio** 传输；HTTP / SSE 传输、resources、prompts、采样、服务器发起的请求未接。
- 只接 **tools**；`tools/list_changed` 通知不处理，工具集在进程启动时固定（重启才刷新）。
- 无 OAuth / 凭据协商，鉴权靠服务器进程自身环境变量。
- 工具名不做长度限制；服务器列表在单个进程内共享，不做按会话隔离。
- 多模态仍未接入：`ChatMessage.content` 是 string，见 [harness-gaps.md](./harness-gaps.md)。

## 验证

- `test/mcp.test.ts`：`parseMcpConfig` 保留合法项、丢弃非法名/缺 command、非法 risk 只丢字段；`readMcpConfig` 缺文件；用 Node 写的假 MCP 服务器跑通握手、`tools/list`、`tools/call`（多文本块拼接、`isError`）；坏命令与静默服务器按 `errors` fail-open；`createRuntime` 合并 `extraTools` 且跳过重名。
- `pnpm typecheck`、`node --test test/*.test.ts`、`npm run build`（同步 `dist/mcp/*`）、`node bench/run.ts`。
