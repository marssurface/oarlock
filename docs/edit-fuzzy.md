# edit_file 的受控模糊匹配

`edit_file` 只做精确字符串替换时，最常见的失败不是「模型不知道要改什么」，而是它把 `old_string` 的缩进或行尾空白写歪了——读文件时行号前缀、上下文的相对缩进、CRLF 文件，都会让本来正确的片段匹配不上，模型于是反复微调重试，一轮白花几次调用。行业做法（Claude Code / Codex 的 patch 应用）都是在精确匹配失败后做一次**受控的**模糊匹配：只在规则内放宽，放宽不了就报错，绝不猜。

## 匹配顺序

`core/edit-match.ts` 的 `resolveEdit(text, old_string)` 返回一个 `EditPlan`：

1. **精确匹配永远优先**。`text.includes(old_string)` 命中就按精确结果走，哪怕别处还有一个「模糊相同」的片段——精确命中不会被判成歧义。
2. 精确找不到才进模糊回退，且必须同时满足：
   - `old_string` 去掉首尾空白后至少 10 个字符（太短的片段极易撞车，只做精确匹配）；
   - 按行对齐：每行只规范化**行首缩进（空格/制表符）**、**行尾空白**和**行尾符**，行内空白差异不算相等（`const  x = 1` 与 `const x = 1` 不同）；
   - 匹配区间必须是**整行**，起点在行首、终点在该行有效内容末尾，所以短片段不可能匹配到某行中间；
   - 规范化后的候选**唯一**。两个候选就报 `appears N times after whitespace normalization`，要求补上下文，不选第一个。
3. 结果里 `fuzzy: true` 表示这次走了回退；工具返回值会追加 `(whitespace-tolerant match)`，模型和人都看得见。

## 替换怎么落地

模糊匹配成功后，替换区间是文件里的真实行范围，`new_string` 还要按匹配到的缩进差做一次重映射，否则「模型少缩进 4 格」会直接把文件改成阶梯状：

- 逐行计算 `old_string` 每行与文件对应行的缩进差（`add` / `remove`，前缀关系才算得出差；tab 与空格互不包含时视为无差，交给 `new_string` 自己决定）；
- `new_string` 行数与片段行数一致时**按行应用各自的差**——片段里 2 空格缩进的行落在文件里 8 空格的位置，替换后仍是 8 空格，文件的缩进结构不因这次编辑漂移；
- 行数不一致（增删了行）时退回**统一差**（第一个非空行的差），不做逐行猜测；
- 空行不动；
- 匹配区间里出现过 CRLF 就记 `eol: '\r\n'`，替换文本的行尾符统一还原成 CRLF，不会把半截文件改成 LF。

## 预览与执行一致

审批卡片的 diff 由 `core/diff.ts` 的 `describeToolChange()` 生成，它对 `edit_file` 走的是**同一个** `resolveEdit` + `replacePlan`：预览里就写明「未找到」「规范化后出现 N 次」，成功时在 diff 末尾追加 `(whitespace-tolerant match: indentation / trailing whitespace normalized)`。也就是说，用户在卡片上看到的就是实际会写进文件的内容，不存在「预览是精确匹配失败、执行却模糊命中」的偏差。

`replace_all` 与模糊匹配互斥：回退匹配只保证单点唯一，`replace_all: true` 时若走了模糊路径就只替换这一处，并在结果里说明。

## 代码位置

- 匹配与替换：`src/core/edit-match.ts:164`（`resolveEdit`）、`:69`（`fuzzyFind` 回退规则）、`:213`（`replacePlan`）、`:185`（`shiftIndent`）。
- 工具执行：`src/tools/fs.ts:195`（`edit_file`，返回文案里的 `whitespace-tolerant match`）。
- 审批预览：`src/core/diff.ts:55`（`describeToolChange`）。
- 测试：`test/edit-match.test.ts`（匹配规则、缩进重映射、CRLF、歧义、tab-vs-space）、`test/tools.test.ts`（端到端替换与报错文案）、`test/agent.test.ts`（预览与执行一致）。

## 验证

1. 缩进写歪的片段能改对，返回值带 `(whitespace-tolerant match)`，文件缩进结构不变；
2. 精确命中优先：文件里同时存在精确与模糊相同的两处，只改精确那一处；
3. 模糊后仍有两个候选 → 报错并给出次数；
4. 短片段（去掉首尾空白不足 10 字符）只做精确匹配，报 `too short for whitespace-tolerant matching`；
5. CRLF 文件模糊替换后仍是 CRLF；
6. 行内空格差异不被当成相等；
7. 审批卡片的 diff 与实际写入内容一致。
