# 提问卡（ask_user）

模型在回合中途向用户提出结构化选择题的完整链路：工具定义 → 事件流 → 门（gate）→ 回答接口 → 对话卡片 → 结果回传模型。

## 用途

当「该做什么」是一个真正需要用户拍板的决定（偏好、缺失需求、多个可行方向），模型可以调用 `ask_user` 而不是替用户猜。系统提示里有一条条件指导语：

> Use the ask_user tool when a real decision is ambiguous… Offer 2-4 concrete options, mark the one you recommend…

子 agent 不携带 `ask_user`（`src/core/agent.ts` 的 `spawnSubagent` 从父工具集里 `without('task').without('ask_user').without('todo_write')`），也拿不到 ask 门，因为子 agent 不能询问用户（`SUBAGENT_PROMPT` / `explore` 只读人格，见 [subagents.md](./subagents.md)）。

## 工具契约

`src/tools/ask.ts` 定义 `ask_user`：

- `question`（必填）：一句话问题
- `header`（可选）：卡片眉题，≤12 字符
- `options`（必填，2–4 项）：`label`（唯一、非空）、`description`（可选一行说明）、`recommended`（推荐标记，至多一个）
- `multiSelect` / `allowOther`：多选 / 允许自定义输入
- `risk: 'read'`——提问不需要审批门

`parseAskArgs` 在 agent 调用门之前做校验（选项数 2–4、label 唯一非空），非法参数直接返回错误文本给模型，不会弹卡。

## 事件流（src/core/events.ts）

- `ask-request`：`{ id, callId, question, header?, options, multiSelect, allowOther }`——UI 用它替换对应的工具活动行并渲染卡片
- `ask-answer`：`{ id, answer }`，`answer = { status:'answered', selected[], other? } | { status:'skipped' }`

两个事件都进会话轨迹（`src/session/store.ts` 的 `TRACE_TYPES`），CLI 的 `/trace` 和 Web 轨迹面板把它们渲染成「提问」行（面板新增「提问」筛选）。

## 门与回答接口

`AskGate`（`src/tools/types.ts`）只要求 `request(request & { id }) => Promise<AskAnswer>`。实现：

- **Web**（`src/web/server.ts`）：`ensure()` 里用 `promptAsk` 建门，把 resolve 存进 `state.pendingAsks`，10 分钟未答按「跳过」处理；SSE 关闭时把未决问题全部按跳过 resolve。浏览器通过 `POST /api/sessions/:id/answer`（`{ id, selected, other }` 或 `{ id, skipped: true }`）提交，服务器 resolve 后 agent 继续，`ask-answer` 沿 SSE 回到页面。回答不写入消息体以外的地方：结果作为 `tool-result` 内容进入对话与轨迹，回传给模型。
- **CLI**（`src/cli.ts`）：TTY 下用 readline 打印编号选项并读入（逗号分隔多选，回车跳过）；非 TTY（管道 / `--once` 自动化）用 `skipAsks()`，模型按自己的判断继续。
- **无门**：agent 没有 ask 门时 `ask_user` 返回错误 `not available in this context`，回合继续（bench、无 UI 场景的兜底）。

模型看到的工具结果是 `formatAskAnswer` 的文本，例如：

```
The user answered "Which approach?".
Selected: Safe
Other: …
```

跳过时：

```
The user skipped the question. Proceed with your best judgment and state the assumption you made.
```

## 对话卡片（index.html）

- 结构：图标眉部（问题 + 可选 header）→ 选项组（单选 radio / 多选 checkbox，`data-kind` 区分圆/方选中标记）→ 底部「提示 · 跳过 · 提交」。
- 选中态：边框与底色用 `--accent` 的 `color-mix` 淡色，选中标记实心 accent；推荐项带「推荐」胶囊。键盘焦点用 `.ask-opt:has(input:focus-visible)` 描边。
- 自定义「其他」行：勾选后启用虚线输入框并自动聚焦，输入内容即选择；提交在没有任何选项被选中且自定义为空时禁用。
- 提交 / 跳过 → `POST /api/sessions/:id/answer`；提交失败恢复可编辑并 toast 报错。
- `ask-answer` 到达后卡片进入只读终态：选中项本身即标识（实心勾选 + 淡色底），底部状态行整行移除；跳过没有视觉标记，因此保留「已跳过」；工具活动行在 `ask-request` 时被卸载避免重复。
- 回合结束（`turn-end` 或 SSE 断开）时未决卡片标记「未作答 · 本轮已结束」（`cancelPendingAsks`）。
- 刷新恢复：`renderHistory` 识别 `toolName === 'ask_user'` 的工具消息，从 assistant 消息里的工具调用参数重建卡片（`askFromArgs`），从工具结果文本解析终态（`fillAskFromContent`），只读呈现。
- 主题与响应式：全部走 CSS 变量，`prefers-reduced-motion` 关掉入场动画；窄屏选项和按钮自动占满。

## 验证

- `npm test`：agent 层覆盖提问事件、答案回传、无门失败、跳过、参数校验；tools 层覆盖默认注册与 `parseAskArgs`/`formatAskAnswer`；ui 层用 jsdom + 可流式 SSE stub 覆盖「渲染 → 选择 → 提交 → 已作答终态」「跳过终态」「历史只读恢复」。
- `npm run typecheck`、`npm run build`（构建产物同步到 `dist/web/public`）。
