# 会话管理：重命名、分支与删除

以前只有创建、打开与列表。本能力补齐会话生命周期：**rename / fork（含 rewind）/ delete**，Web、CLI 与文件层语义一致。

设计原则：

- **非破坏性 rewind**：从某条消息之前继续，不会截断原会话；分支到新会话，原会话保持可恢复。
- **轨迹不复制**：分支是新的使用记录，`usage` / 成本从零开始，避免把旧账重复计到新分支。
- **运行中不动文件**：正在执行回合的会话拒绝 rename / fork / delete（HTTP 409），避免重写转录与追加写互相覆盖。

## 文件层语义

持久化格式不变：`<id>.jsonl` 是转录（首行 meta，随后 message / compaction），`<id>.events.jsonl` 是轨迹。

| 操作 | 行为 |
| --- | --- |
| `SessionStore.list()` | 按 `updatedAt`（取转录文件的 mtime）倒序返回会话摘要。同一毫秒内写入的两个会话比较结果相等，此时按 `id` 倒序兜底——`id` 前缀是创建时刻的 base36，所以「新的在前」的读法不变；没有这个兜底，顺序会落到 `readdir` 返回序（Linux 是目录 hash 序，macOS 是创建序），侧栏会在换平台或换次启动时莫名抖动。 |
| `SessionStore.rename(id, title)` | 读取转录，更新 `meta.title` 后原子重写（临时文件 + rename）。重写后恢复原 mtime，**列表排序不会因改名跳到顶部**。`title` 为空/缺省会删除字段，列表重新用首条用户消息生成预览标题。 |
| `SessionStore.remove(id)` | 删除 `<id>.jsonl` 与 `<id>.events.jsonl`，并清理轨迹汇总缓存。未知 id 抛 `ENOENT`，由 HTTP 层映射为 404。 |
| `SessionStore.fork(id, keep?)` | 复制源会话前 `keep` 条消息到新 id；省略 `keep` 复制全部，`0` 生成空分支。新 `createdAt`、标题为「源标题 · 分支」。复制前会复用断尾修复（assistant 工具调用缺结果时补合成结果），保证新转录可以直接继续对话。轨迹不复制。 |

`fork` 的 `keep` 在 store 层也校验：必须是 `0..messages.length` 的整数，否则抛 `RangeError`。

重命名示例：

```ts
const store = new SessionStore(config.sessionsDir)
store.rename(session.id, '修复登录超时')
store.rename(session.id, undefined) // 恢复自动标题
const branch = store.fork(session.id, 4) // 保留前 4 条
```

## HTTP API

| 方法与路径 | 请求体 | 成功响应 | 失败 |
| --- | --- | --- | --- |
| `PATCH /api/sessions/:id` | `{ "title": "..." }` | `{ ok, id, title }` | 400：title 非字符串 / 超过 120 字；404：不存在；409：运行中 |
| `DELETE /api/sessions/:id` | 无 | `{ ok, id }` | 404：不存在；409：运行中 |
| `POST /api/sessions/:id/fork` | `{ "keep"?: number }` | `{ id, meta }` | 400：keep 非非负整数或越界；404：不存在；409：运行中 |

服务端在 `title` 上做 `trim()`；空串等价于清除标题。重命名后会同步 `createAgentServer` 内存中的 `state.session.meta`，但保留已打开的对话状态。删除会同时移除内存里的 `WebSession`；当前页面若删的是正在查看的会话，UI 自动切到剩余最新会话，列表为空则新建一个。

HTTP 路由使用与打开会话相同的 id 白名单 `[A-Za-z0-9_-]+`，不会因为 `../` 之类路径穿越会话目录。

## Web UI

- **侧栏会话行**：悬浮/聚焦时显示「⋯」按钮，菜单包含「重命名 / 新建分支 / 删除会话」。菜单用 `position: fixed` 按视口翻转（下方空间不足时向上），滚动列表会自动收起。
- **内联重命名**：标题变成输入框，Enter 保存、Esc 取消、失焦也保存；成功后原地刷新列表并 toast，失败写入对话区错误提示。
- **删除**：第一次点击变「确认删除」并保持 3 秒，第二次才真正删除，避免误触。
- **从此处分支**：每条历史用户消息底部（hover / focus 可见）有分支按钮，调用 `fork` 且 `keep` 为该消息在会话数组中的下标，即复制「这条消息之前」的全部内容。切换后把原文预填进输入框，方便修改后重发。
- **运行中保护**：当前会话正在流式输出时，前端先提示「先停止」，服务端仍以 409 兜底；其他空闲会话可正常管理。

保留原有测试依赖的选择器：`#sessions .session`、`.session .t`、`.session .m`。会话行现在包在 `.session-row` 里，但计数与文本断言不受影响。

## CLI

REPL 新增：

```text
/rename <title>   重命名当前会话（留空恢复自动标题）
/fork [keep]      从当前会话分支（保留前 keep 条，默认全部）
/delete <id>      删除指定会话（不能删除当前会话）
```

`/fork` 会切换 runtime 到新会话；`/delete` 拒绝当前会话，避免运行时指向已删除的文件。`/sessions` 仍列出最近 10 条，可用于取 id。

## 边界

- **不做自动截断**：没有「回滚到某条消息并覆盖原会话」，rewind 一律走 fork，磁盘上永远保留原路径。
- **分支不含轨迹与成本**：需要完整审计请查看源会话；分支只继承消息上下文。
- **跨进程不协调**：运行态只存在当前服务进程内；另一个 oarlock 进程正在写的会话无法被检测。
- **删除不可撤销**：文件被直接移除，没有回收站或软删除。
- **UI 只提供用户消息分支点**：没有按 assistant / tool 节点分支的入口；需要精确切点可直接调用 API 的 `keep`。

## 验证

- `test/session.test.ts`：rename 持久化 / 清空 / mtime 不变，fork 前缀、全量、空分支与越界，remove 双文件与 ENOENT。
- `test/session-management.test.ts`：三个 HTTP 路由的成功路径、空标题回退、参数校验、未知 id 404、运行中 409。
- `test/ui.test.ts`：侧栏菜单重命名、全量分支、二次确认删除；用户消息分支 `keep` 与输入框预填。
