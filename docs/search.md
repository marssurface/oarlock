# 大仓检索：grep_files 优先 ripgrep

`grep_files` 原来是全量 walk + 逐文件 JS regex：8000 条目上限内逐个读文件、判断二进制、逐行匹配，大仓下又慢又占内存。本轮加了一层 ripgrep 加速（`tools/ripgrep.ts`），**rg 是优化不是依赖**：没有 rg、rg 出错或模式不兼容，都回退原有 JS walk，工具行为不变。

## 后端选择

1. `AGENT_NO_RG=1` → 直接 JS walk（运维/测试开关，每次调用都读）。
2. `AGENT_RG_PATH=<path>` → 用指定二进制（不校验存在性，spawn 失败自然回退）。
3. 否则进程内探测一次 `rg --version`（3s 超时），结果缓存；PATH 上有 rg 就用它。

## 语义对齐

rg 的输出要长得和 JS walk 一模一样，测试里用同一 fixture 断言两者逐字节一致：

| 维度 | JS walk | rg 参数 |
| --- | --- | --- |
| 跳过目录 | `IGNORED_DIRS`（node_modules/.git/dist…） | 每个目录名一条 `--glob '!name'`（任意深度按名匹配） |
| 隐藏文件 | 包含（除跳过目录） | `--hidden` |
| .gitignore | 不理会 | `--no-ignore` |
| 文件大小 | > 2MB 跳过 | `--max-filesize=2M` |
| 二进制 | NUL 探测跳过 | rg 默认跳过二进制 |
| 顺序 | 目录内按名排序 | `--sort=path`（单线程确定序） |
| include glob | 无 `/` 匹配 basename，有 `/` 匹配相对路径 | `--glob <include>`（gitignore 语义近似，常用模式一致） |
| 行格式 | `rel:line: text.trim().slice(0,300)` | `-n --with-filename --no-heading` 输出同格式解析，路径重新挂回工具 cwd 前缀 |
| 结果上限 | 全局 max_results 停 | `--max-count=<max_results>`（每文件上限不会丢掉全局前 N 条）+ 解析时截断，尾部同样标 `… (stopped at N matches)` |

另加 `--no-config`（不读用户 rg 配置）、`--no-messages`（吞权限警告）、`--color=never`。

## 回退条件

`grepWithRg` 返回 `undefined` 时调用方走 JS walk：

- rg 不存在 / spawn 失败 / `AGENT_NO_RG=1`；
- **退出码 2**：rg 拒绝模式。工具契约仍是 *JavaScript* 正则——lookahead、反向引用这类 Rust regex 不支持的语法，rg 报错后由 JS walk 兜底，用户无感；
- 20s 超时、abort 信号、原始 stdout 超过 4MB（宁可回退也不拿半截输出猜结果）。

进入 rg 之前先照旧用 `new RegExp` 校验：非法 JS 正则直接报 `invalid regular expression`，两种后端行为一致。无匹配时 rg 路径返回 `no matches for <pattern> (ripgrep)`（JS 路径附扫描文件数）。

## 边界

- include 的 glob 语义在边缘模式（如字符类 `[a-z]`）上 rg 与自研转换不完全等价；常用 `*.ts`、`src/**` 一致。
- rg 路径不报告扫描文件数；需要精确审计用 JS 后端（`AGENT_NO_RG=1`）。
- 探测缓存进程级：PATH 变化需重启；两个 env 开关每次调用即时生效。

## 验证

`test/ripgrep.test.ts`：

- 假 rg 脚本（记录 argv）：参数映射（`-e`/`--ignore-case`/glob 对/`--sort=path`/`--max-count`）、输出重根与裁剪、max_results 截断尾注；
- 退出码 2 与坏路径 → JS walk 回退（lookahead 模式仍可用）；
- `AGENT_NO_RG` / `AGENT_RG_PATH` 开关；
- 真 rg（未安装则 skip）：隐藏文件包含、跳过目录排除、include + 忽略大小写、无匹配提示，以及同一查询两种后端输出逐字节一致。