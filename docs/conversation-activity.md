# 对话活动折叠（思考 / 工具执行）

记录 Web 对话视图里「思考中 / 执行工具」的展示、合并与折叠规则。实现全部在
`src/web/public/index.html`（单文件、原生 JS/CSS，无框架），事件来自 runtime 的 SSE 流。

## 设计目标

- **默认收起**：活动和正文分开，正文永远是视觉主体。
- **连续合并**：一轮里成串的思考/工具合成一个摘要，不逐个刷屏。
- **收起也有信息**：能看到当前在做什么、做了多久、一共几次、有没有失败。
- **渐进展开**：组 → 行 → 详情，三层按需打开。
- **实时与历史同构**：刷新页面回放历史时走同一套渲染，规则不变。

## 信息从哪来

| 内容 | 来源 |
| --- | --- |
| 思考正文 | `reasoning-delta` 事件的文本（模型产出） |
| 工具名 / 参数 / 结果 / 是否失败 | `tool-call`、`tool-result` 事件（运行时产出） |
| 「思考中」「执行中」「执行过程」「已思考」「读取文件」等措辞 | **界面生成**，不来自模型 |
| 用时、条数、失败数 | 界面用 `performance.now()` 和事件计数算出 |
| 底部「琢磨中… / 执行中…」 | **界面生成**：阶段判断 + 定时轮换词库 |

> 结论：底部状态行不是 agent 自行输入的文案，模型只提供思考文本和工具调用/结果。

## 结构

```text
.act-group                      ← 连续 ≥2 条活动时出现，默认收起
├── .act-head                   ← 执行中 / 执行过程 + 当前动作或统计 + 总时长
└── .act-group-body (hidden)
    ├── .act.act-think          ← 单条活动，默认收起，可独立展开
    │   └── .act-body → 思考正文
    ├── .act.act-tool
    │   └── .act-body → 参数 / 结果
    └── ...

.working                        ← 底部状态行，始终钉在内容末尾
```

单条活动也能独立存在（不套组），结构同上，只是没有 `.act-group` 外壳。

## 折叠规则

### 1. 单条折叠

每个思考或工具调用是一行 `.act`，默认 `data-open="false"`。
头部常显四项：

- 状态图标（运行中 spinner / 完成勾 / 失败叉）
- 动词：`思考中`、`已思考`、`读取文件`、`运行命令`…
- 对象 chip：文件名、命令、pattern、任务描述
- 右侧：实时用时 + 展开箭头

点开才显示正文（思考）或「参数 / 结果」两节（工具）。头部点击切换
`aria-expanded` 和 `data-open`。

### 2. 连续合并

同一轮内，连续出现的第 2 条活动会把前一条一起收进 `.act-group`：

- 只有 1 条活动 → 保持单行，不套组（避免只有一层壳的冗余）。
- ≥2 条连续活动 → 合成一个「执行过程」组，组默认收起。
- 组内每一条仍保留自己的折叠状态，可以单独展开。

### 3. 分组边界

以下情况立即给当前组封口，之后的新活动重新开组，从而保持时间顺序：

- 助手正文开始输出（`text-delta`）
- 用户消息
- 系统提示（压缩、重试、错误）
- 轮次结束（`turn-end`）或流结束 / 请求失败

### 4. 运行中的组头

- 有活动在跑：图标转圈，动词「执行中」；
  - 当前是工具 → 副标题为「动词 + 对象」，如 `运行命令 npm test`
  - 当前是思考 → 副标题为思考内容的实时尾部预览
  - 右侧秒表每 500ms 刷新
- 全部结束：动词变「执行过程」，副标题为统计，如
  `2 次思考 · 3 个工具`，有失败时追加 `· N 个失败`；
  图标换成勾（全成功）或叉（有失败），并冻结总时长。

### 5. 底部状态行

`.working` 是界面自己发的「心跳」，不是模型输出：

- 有工具在运行 → 固定显示 `执行中…`
- 没有工具运行 → 每 2.4s 从词库轮换：
  `琢磨中 / 推敲中 / 寻思中 / 梳理中 / 酝酿中`
- 三个点做跳动动画；`prefers-reduced-motion` 下改为静态
- `turn-end`、请求失败、切换/重渲染会话时移除
- 新消息、通知、活动挂载时都会把它重新钉到末尾，保证它永远在内容最后

## 文案映射

工具动词由界面维护：

| 工具 | 动词 |
| --- | --- |
| `read_file` | 读取文件 |
| `write_file` | 写入文件 |
| `edit_file` | 编辑文件 |
| `list_files` | 查看目录 |
| `glob_files` | 查找文件 |
| `grep_files` | 搜索内容 |
| `bash` | 运行命令 |
| `task` | 子任务 |
| 其他 | 执行工具 |

- 对象按 `path → pattern → command → description` 依次取第一个非空值。
- chip 优先用路径的 basename；`.` 显示为「当前目录」；没有路径时用对象本身。
- 头部对象和预览会截断并省略，完整对象放在 `title` 里。
- 结束时预览取工具结果的前 90 字；失败时动词变 `动词 + 失败`，中断时变 `动词 + 中断`。
- 宽度 ≤520px 时隐藏行内预览副标题，只保留动词和 chip；组头统计仍然显示。

## 状态与计时

| 计时器 | 周期 | 生命周期 |
| --- | --- | --- |
| 单条活动用时 | 500ms | `mountActivity` 时启动，`settleReasoning` / `fillToolCard` / 中断时清除 |
| 组头总时长 | 500ms | 组内还有活动在跑时启动，`closeActivityGroup` 时清除 |
| 底部状态词 | 2400ms | 发送后启动，`setStreaming(false)` / `resetTurn` / `renderHistory` 时清除 |

组关闭只表示「不欢迎新活动进来了」，已渲染的行和展开状态保持不变。

## 历史回放

`renderHistory` 复用同一套构建函数：

- 思考 → `addReasoningCard`（已完成的单行，无实时计时）
- 工具 → `addToolCard(..., history = true)`，结果由 `tool` 消息回填
- 没有保存结果的工具显示「X中断」，不伪造成成功
- 渲染结束统一 `closeActivityGroup()`，避免下一次实时活动接进历史组

## 事件接线

`handleEvent` 中与本设计相关的分支：

| 事件 | 行为 |
| --- | --- |
| `step-start` | 流式状态下开始一条思考行 |
| `reasoning-delta` | 追加思考正文，更新行内预览 |
| `tool-call` | 结束当前思考行，新增工具行（运行中） |
| `tool-result` | 回填结果，行变完成/失败，刷新组头和底部状态 |
| `text-delta` | 结束思考行、封口当前组，再写助手正文 |
| `turn-end` | 结束思考行、封口当前组、移除底部状态行 |

## 可访问性

- 行头和组头都是原生 `<button>`，带 `aria-expanded`。
- 焦点环使用 `:focus-visible`，不依赖 hover。
- 展开箭头随状态旋转 90°，状态颜色同时配合图标（勾/叉）而非只靠颜色。
- 底部跳动点在 `prefers-reduced-motion` 下停止动画。

## 代码位置

均在 `src/web/public/index.html`：

- 样式：`.act` / `.act-group` / `.working`（约 137–230 行）
- 图标与词库：`ACT_ICONS`、`WORK_WORDS`（约 983–992 行）
- 底部状态：`refreshWorking` / `startWorking` / `stopWorking` / `pinWorking`（约 994 行起）
- 工具文案：`TOOL_VERBS` / `basenameOf` / `toolDescriptor`（约 1030 行起）
- 活动行与组：`createActivity` / `createActivityGroup` / `refreshActivityGroup` /
  `mountActivity` / `unmountActivity` / `closeActivityGroup`（约 1062–1218 行）
- 思考与工具：`startReasoning` / `appendReasoning` / `settleReasoning` /
  `addReasoningCard` / `addToolCard` / `fillToolCard` / `settleActivity`（约 1219–1360 行）
- 事件与历史：`handleEvent` / `renderHistory`（约 1412 / 1459 行）

## 验证方式

- 单元测试：`cd agent && npm test`（UI 测试不依赖活动区 DOM，但会覆盖设置与轨迹）。
- 类型与构建：`npm run typecheck`、`npm run build`，构建会同步到 `dist/web/public`。
- 浏览器实测：本地起 `node src/web/server.ts --port 4173`，用无头 Chrome 注入
  合成事件（`handleEvent`）后截图，检查：
  - 收起组头 / 展开后的嵌套行
  - 运行中「执行中 + 当前动作 + 秒表」
  - 完成态「执行过程 N 次思考 · N 个工具」与勾/叉
  - 底部状态词轮换与 `turn-end` 后消失
  - 明暗两套主题；1440px 与 520px 两种宽度
