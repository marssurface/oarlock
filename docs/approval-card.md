# 审批卡片

高风险工具调用（`approval.mode = ask`）在输入框上方弹出的一张卡片，用来解释「要做什么」并让你选择允许、始终允许或拒绝。

```
⚠  需要确认  [编辑文件 · write_file]
    note.txt
    ▸ 查看变更 / 参数
    允许后继续本轮执行；「始终允许」按工作目录记住相同的命令或目录。  [拒绝] [始终允许] [允许]
```

## 内容从哪来

- 标题固定为「需要确认」；
- 工具胶囊由事件里的 `tool` 生成：动词来自 `TOOL_VERBS`（如 `bash → 运行命令`），后面跟原始工具名；
- 正文优先用 `summary`，并去掉与工具胶囊重复的 `工具名: ` 前缀（`bash: rm -rf dist` → `rm -rf dist`）；没有 `summary` 时退回 `detail`；
- `detail` 收在「查看变更 / 参数」的折叠块里：
  - 写类工具（`write_file` / `edit_file`）由运行时生成统一 diff（`--- /dev/null` / `--- a/...`、`+++ b/...`、`@@ ... @@` 与 `+`/`-` 行），大文件按行/字符上限截断；
  - 其余工具是原始参数 JSON，解析成功会格式化成两空格缩进；
  - 展示时最多 2000 字符、超出滚动；和 `summary` 相同或为空时不显示；
- 底部一行说明后果：允许后继续本轮，拒绝跳过这次调用；「始终允许」按工作目录记住相同的规则，可在设置 → 权限里清除。

## 决策与规则

- 「允许」= `allow`，只放行这一次；
- 「始终允许」= `always`，放行这一次并把规则记进 `.agent/permissions.json`（按工作目录共享，重启后仍然生效），后续相同调用不再弹卡片：
  - `bash` 以完整命令为规则（`bash:<command>`），换个命令仍会询问；
  - 写类工具以目标目录为规则（`write_file:<目录>`，项目根为 `.`），同目录的其他文件不再询问；
  - 没有可用规则的调用（如无参数的写工具归到 `工具名:*`）只在本次放行。
- 规则只放宽审批，不覆盖安全边界：`approval.mode = deny` 与「拒绝」策略仍然优先，命中规则也只跳过询问，不会让本应被拒的调用通过。
- 落盘失败（磁盘满、无权限）时本次调用照常放行，但规则不会记住，也不影响本轮。
- 服务端 `POST /api/sessions/<id>/approve` 接受 `allow` / `deny` / `always`；事件里 `approval-decision.remembered = true` 表示这次记住了规则，CLI 会提示「已记住，下次不再询问」。
- 被「始终允许」覆盖的调用不会再发 `approval-request`，直接以 `approval-decision`（`allowed: true`）继续。
- 设置面板「权限」板块列出全部已记住的规则（每行可单独移除，也可两次点击清空全部）；CLI 复用同一份规则，因此在 Web 里放行的命令在终端也不会再问。

## 交互与状态

- 「允许」是强调色主按钮，「拒绝」与「始终允许」是中性次按钮；三者都有 hover / active / `:focus-visible` 状态。
- 点击后立即收起卡片并提交决策；失败时在对话里补一条错误提示。
- 卡片出现时带 160ms 的淡入上移动画，`prefers-reduced-motion` 下关闭。
- 卡片带 `aria-live="polite"`，出现时读屏会播报；折叠块用原生 `<details>`，键盘可操作。
- 窄屏（≤560px）下按钮换到下一行并右对齐，正文与参数块保持可读，不横向溢出。

## 同时只有一个审批

Web 只有一张卡片、CLI 只有一条 readline，所以「发 `approval-request` → 等决定」这段由一把 1 槽 `Semaphore`（`core/semaphore.ts` 的 `approvalLock`）串起来：父 agent 创建，子 agent 在 `spawnSubagent` 里继承同一个实例。并发委派因此不会同时抛出两个审批，也不会出现「一张卡片对应两条请求、答案给错对象」。规则命中（`precheck` 直接放行）不占锁；diff 预览的计算也在锁外，只有真正等人回答的那一段排队。

## 停止本轮

审批等待期间点输入框发送键上的「停止」会：
1. 把挂起的审批与提问统一解除（审批记拒绝、提问记跳过）；
2. abort 当前请求与工具执行；
3. 补齐未执行工具调用的结果，保证 transcript 不留悬挂的 `tool_call`。

## 代码位置

- 样式：`src/web/public/index.html:267` 起。
- 结构：`src/web/public/index.html:963` 起（含 `#approve-always`，`:978`）。
- 内容填充：`src/web/public/index.html:2153`（`formatApprovalDetail`）与 `:2163`（`showApproval`）。
- 决策提交：`src/web/public/index.html:2195`（`decide`）。
- diff 生成：`src/core/diff.ts`（`describeToolChange`）。
- 规则记忆：`src/core/approval.ts`（`RuleApprovalGate` / `ruleApproval`）与 `src/core/rules.ts`（`PermissionRules`、`.agent/permissions.json` 读写）。
- 规则键与事件：`src/core/agent.ts`（`approvalRuleKey`）。
- 设置面板：`src/web/public/index.html` 的「权限」板块（`#pane-permissions`），接口 `GET /api/settings` 携带 `rules`、`DELETE /api/settings/rules` 移除或清空。

## 验证

1. 触发一次 `write_file` / `bash` 审批，确认标题、工具胶囊、正文与折叠块；
2. 写类工具展开「查看变更 / 参数」，确认是 diff 而不是原始 JSON；
3. `bash` 选「始终允许」后再发同一条命令，确认不再弹卡片；换一条命令仍弹；
4. 重启服务或新开会话，同一条命令仍直接放行（规则已落盘）；设置 → 权限里能看到它；
5. 设置 → 权限中移除该规则后，下一条相同命令重新弹卡片；清空全部需二次点击；
6. 允许 / 拒绝后卡片收起，下一个事件恢复对话；
7. 等待审批时点「停止」，确认卡片消失、会话可继续提交；
8. 浅色 / 深色、520px 宽度下按钮换行且无横向滚动。
