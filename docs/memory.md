# 跨会话记忆：`.agent/memory/` 与 `remember` 工具

会话转录记的是「这次聊了什么」，`AGENTS.md` 记的是「这个仓库的长期约定」，两者中间缺了一层：**agent 在这台机器上、这个工作目录里干活时学到的东西**——某个端口必须带 `--cwd` 起、测试只能跑在 nvm node 24 上、用户拍板过的一个决定。这些东西每次开新会话都要重新踩一遍。这一层补上后，runtime 才开始跨会话积累经验，而不只是跨会话恢复对话。

## 落盘格式

一条记忆一个 markdown 文件，放在 `<cwd>/.agent/memory/<slug>.md`：

```markdown
---
name: dev-server-cwd
description: dev server 必须用真实 agent 根目录起，否则设置读空
kind: procedure
---

4173 端口用 `node src/web/server.ts --cwd <agent 根目录>` 启动。
```

- `name` 与文件名一致，是小写 slug：空格/下划线/冒号都折成 `-`，非法字符丢掉，首尾的 `-._` 去掉，最长 64。**slug 归一同时挡掉目录穿越**——`../../etc/passwd` 只会变成 `etc-passwd`，永远落不出 `.agent/memory/`。
- `description` 是一行索引摘要，会出现在**以后每一次会话的系统提示词里**，所以它决定 agent 要不要去读正文。缺省时取正文第一行（去掉 `#` / `-` 前缀）。
- `kind` 只有四种：`fact`（事情就是这样）、`preference`（用户要什么）、`decision`（已经拍板了什么）、`procedure`（该怎么做）。写错或没写一律按 `fact` 处理。
- 正文上限 12000 字符，超了直接拒绝并说明原因——记忆是提示，不是文档仓库；大内容应该写成 `docs/` 里的文件。
- 写盘是 `临时文件 + rename` 的原子替换：写失败保留原文件，`.tmp` 清掉。

## 注入

`createRuntime` 给 Agent 传一个 `memoryIndex` 渲染函数，每轮开始时重读目录、渲染索引、重建系统提示词：

```
Memory from earlier sessions, one markdown file per note under `.agent/memory/`:
- dev-server-cwd — dev server 必须用真实 agent 根目录起（procedure）
- … 12 more not listed; `ls .agent/memory` or list_files on it
```

- **每轮重读**，所以这一轮 `remember` 写下的笔记，下一轮就在提示词里，不用重启会话、也不会出现第二个「记忆索引」文件跟真实目录抢一致性。
- 有上限：最多 60 条、约 4000 字符，超出部分换成一行「还有 N 条未列出」。目录在长，提示词不会跟着无限膨胀。
- 只注入摘要不注入正文。agent 需要细节时用 `read_file` 读 `.agent/memory/<name>.md`——读一次花一次上下文，比无脑全量塞进提示词便宜得多。
- 空目录不注入任何段落，提示词里不会多出「Memory:」这种空壳。
- 子 agent 看得到摘要（拼在它的角色提示之后），但**没有 `remember` 工具**：孩子负责汇报，「什么值得记下来」是父级的决定。

## `remember` 工具

`risk: 'write'`，两个动作：

| 参数 | 说明 |
| --- | --- |
| `action` | `write` 新建或覆盖一条；`remove` 删除一条 |
| `name` | slug，同名即更新（不会产生第二条描述同一件事的笔记） |
| `description` | 一行摘要，进索引 |
| `kind` | `fact` / `preference` / `decision` / `procedure` |
| `content` | 正文，短、自包含、脱离本次对话也能读懂 |

审批规则按**条目**记，不是按整个工具：`remember:write:<name>` 与 `remember:remove:<name>` 是两个独立的键，所以「始终允许」某条笔记的更新，不会顺手放行所有记忆的写入或删除。审批卡上显示的也是 `.agent/memory/<name>.md` 这个具体文件。

## 人在中间怎么管

- `/memory` 列出全部（名字 / kind / 摘要），`/memory <name>` 打印正文，`/forget <name>` 删一条。
- 文件就是普通 markdown，直接编辑、`git` 之外的任何方式整理都行；改坏了也不会炸——读不出 frontmatter 的文件按「第一行当摘要、kind 当 fact」继续索引。
- `.agent/` 整体在 `.gitignore` 里，**记忆不会跟着仓库提交**：它是这台机器、这个工作目录的状态，换一台机器不该带过去。想沉淀成团队共享的约定，应该写进 `AGENTS.md` 或 `docs/`。

## 边界

- fail-open：目录缺失、文件损坏、disk 抛错，一律当「没有记忆」处理，`memoryIndex` 抛异常也不影响回合（Agent 侧 catch）。记忆是旁路，不在关键路径上。
- 没有自动摘要/自动沉淀：本轮只在 agent 主动调用 `remember` 时写入。自动抽取会每轮多花一次模型调用，且很容易记下噪声，等确认过「记什么」的取舍再谈。
- 没有失效时间：过期靠模型核对（提示词里明确写了「Memory is a claim, not a fact」，读到与记忆矛盾的事实就去改或删）。
- 只按工作目录隔离，没有用户级/全局层——跨项目的通用偏好目前仍留在 `AGENTS.md` 或对话里。

## 验证

`test/memory.test.ts`（12 个用例）覆盖：frontmatter 往返、slug 归一与穿越拒绝、同名覆盖、空/超长正文拒绝且原文件不动、手写与损坏文件的降级索引、删除与「不存在」的诚实报错、索引上限与「还有 N 条」提示、`remember` 工具各分支、按条目的审批规则键、本轮写入下一轮生效（含 `memoryIndex` 抛异常不拖垮回合）、子 agent 能看不能写。

手工链路（`--provider mock`，无需 API key）：`!tool remember {...}` 落文件 → `/memory` 列出 → `/memory <name>` 读正文 → `/forget <name>` 删除 → 全新会话的系统提示词里出现该条摘要。
