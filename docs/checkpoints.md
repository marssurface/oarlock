# 工作区快照与文件回滚

目标：分叉对话时，可以选择把**工作区文件**也退回到那条用户消息之前的状态。行业做法（Claude Code 的 rewind、Cursor 的 checkpoint）都是每轮自动快照，让「说错了话」可以连代码一起撤销。

## 为什么用 shadow git

不引入数据库、不碰用户仓库：

- `git init --bare <cwd>/.agent/checkpoints`，再把 `core.bare` 改成 `false`，配合 `--git-dir` + `--work-tree` 直接对工作区提交。
- 用户的 `.git` 完全不被读写；`.agent/` 本身已在项目 `.gitignore` 里。
- git 是可选外部依赖，和 rg 一样：缺失或失败就静默降级，回合照常跑。

## 快照时机与内容

每个**主 agent** 回合开始、写入用户消息之前调用 `CheckpointManager.begin()`：

1. `git add -A -- .` 暂存除排除项外的全部文件；
2. 工作区没变化时复用当前 HEAD（空仓库的第一次仍会做一次空提交，作为可回滚的锚点）；
3. 否则 `commit --allow-empty`，并把 `main` 分支指向新提交。

提交 hash 写进 `turn-start.checkpoint` 事件；轨迹是 JSONL 持久化的，所以重启后仍能按会话历史找到快照。

排除项在 `.agent/checkpoints/info/exclude` 中：`.agent/`、`node_modules/`、`dist/`、`build/`、`coverage/`、`.next/`、`.nuxt/`、`target/`、`__pycache__/`、`.venv/`、`venv/`、`.idea/`、`.cache/`、`*.log`、`.DS_Store`，并追加工作区根 `.gitignore` 的内容。子 agent（depth > 0）不拍快照。

## 回滚

恢复入口有两处：

- Web：用户消息旁「回滚文件并分支」——第一次点击只 toast 提示，按钮进入 armed 态，3 秒内第二次点击才执行；
- CLI：`/fork <keep> --restore`。

执行顺序（`CheckpointManager.restore()`）：

1. 校验快照存在（`cat-file -e`），未知 hash 直接拒绝，不动文件；
2. 先对**当前**工作区做一次安全快照；
3. `diff --name-only` 统计将要变化的文件数；
4. `git checkout -f <hash>`，把工作区切成快照时的状态（含删除快照之后新建的文件）；
5. `main` 移到目标快照，安全快照存到 `pre-restore` 分支——回滚错了可以再回滚到 `pre-restore`（或再次调用 `restore(result.safety)`）。

恢复完成后再 fork 会话，响应里带 `restored`、`checkpoint`、`filesChanged`，失败原因放 `warning`。找不到快照时（旧会话、或上下文压缩把该轮从轨迹里裁掉）仍会创建分支，只复制对话，并明确提示文件未回滚。

## 从会话消息定位快照

`checkpointForUserMessage(records, messages, keep)`：

- 只取 depth 0 的 `turn-start`；
- 把轨迹里的回合起点与当前转录里的 user 消息按**后缀**对齐（压缩只可能删掉旧轮次，前缀对不齐）；
- 再校验 `turn-start.input === textOf(messages[keep].content)`，不一致（轨迹过期、消息被编辑过）就返回 `undefined`，宁可没有快照，也不回滚到错误的点。

## 边界与开关

| 场景 | 行为 |
| --- | --- |
| 未安装 git / 初始化失败 / 命令超时（30 秒） | `begin` 返回 `undefined`，该轮无快照，对话不受影响 |
| `AGENT_CHECKPOINT=0` 或 `false` | 整个能力关闭，`restore` 直接拒绝 |
| `AGENT_GIT_PATH` | 指定 git 二进制（测试或非 PATH 环境） |
| 空工作区第一轮 | 做一次空提交，回滚会删掉本轮新建的文件 |
| `node_modules` 等排除目录 | 不参与快照与恢复，恢复后原样保留 |
| 多会话并发 | 同一工作目录共享一个 `CheckpointManager`，git 操作串行排队 |
| 运行中的会话 | fork 返回 409，不会在流式回合中途回滚 |

## 验证

`test/checkpoint.test.ts` 覆盖：快照/恢复往返（修改、新增、删除、安全快照可撤销）、排除目录不动、空工作区、未知快照拒绝、无 git 与开关关闭降级、agent 每主轮恰好一次且子 agent 不拍、`checkpointForUserMessage` 对齐与压缩后缀、`fork restoreFiles` 端到端（含 400 校验和缺快照回退），以及 Web 两次点击确认的交互。
