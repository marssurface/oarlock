# 多模态输入（图片附件）

用户消息不再只接受字符串：一条消息可以是「文本 + 最多 4 张图片」的 content parts。模型侧按 OpenAI 兼容的 `image_url` 协议发送，会话按原样持久化，Web 输入框支持选择 / 粘贴 / 拖入，历史与轨迹都能还原附件。

范围：**图片输入**。音频、PDF、视频不在本轮；模型生成图片也不在——这里只把图片当作 user 消息的一部分送进模型。

## 数据模型

`src/providers/types.ts`：

```ts
export interface TextPart { type: 'text'; text: string }
export interface ImagePart { type: 'image'; mimeType: string; data: string } // 裸 base64，不带前缀
export type ContentPart = TextPart | ImagePart
export type MessageContent = string | ContentPart[]
```

`ChatMessage.content` 的类型是 `MessageContent`。**只有 user 消息会使用 parts**；assistant、tool、system 仍写普通字符串。这样旧转录、工具结果和摘要 prompt 不需要任何迁移。

`src/providers/content.ts` 提供读取助手，避免调用方到处 `typeof content === 'string'`：

| 函数 | 作用 |
| --- | --- |
| `textOf(content)` | 取全部文本片段，用换行拼接；字符串原样返回 |
| `imagesOf(content)` | 取全部图片片段；字符串返回 `[]` |
| `isMultiPart(content)` | 类型守卫：是否为 parts 数组 |
| `imageDataUrl(part)` | `data:<mime>;base64,<data>`，provider 与浏览器共用同一个格式 |
| `messageContent(text, images?)` | 组装 parts；没有图片时退化成字符串，保持旧消息形态 |

设计约束：**没有附件时消息仍是字符串**。只有 `images.length > 0` 才产生数组，所以不涉及图片的路径行为完全不变。

## Provider 线格式

`src/providers/openai-compatible.ts` 的 `toWireContent`：

- 字符串 → 原样发给网关。
- parts → `text` 映射为 `{ type: 'text', text }`，`image` 映射为
  `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,<data>' } }`。
- assistant 的 content 与 tool 结果用 `textOf` 压平（二者本来就只有文本）。

DeepSeek、OpenAI、Ollama 以及大多数 OpenAI 兼容网关都接受这个结构。图片是否真正可用取决于模型；不支持图片的网关会返回 400，界面侧通过模型能力提前禁用附件入口。

## Agent 与事件

```ts
agent.run(input: string, signal?: AbortSignal, images: ImagePart[] = [])
```

- 用户消息写成 `messageContent(input, images)`：有图片时是 `[{type:'text'}, …images]`，纯图片时只有图片片段。
- `turn-start` 事件新增可选字段 `attachments: number`，仅在有图片时出现。事件协议保持向后兼容，旧轨迹没有该字段也能正常回放。
- CLI 的 `run()` 不传图片，行为不变。

## 上下文与压缩

- `ContextManager.estimate()` 每张图片按 **1200 token** 计。这是常见网关对高细节图片的保守估计；没有尺寸信息时不做动态换算。
- 生成摘要时图片只序列化成 `[image: <mime>]` **占位符**，绝不把 base64 塞进摘要请求——否则一张图就会撑爆摘要预算，也会把二进制内容重复上传。
- 压缩后的替换消息仍是纯文本摘要，不影响会话继续。

## 会话持久化

- user 消息的 parts 原样写入 `.agent/sessions/<id>.jsonl`，恢复后仍是 parts。
- 纯图片消息没有文本可作标题，`SessionStore` 回退为 `[N 张图片]`。
- 图片是内联 base64 存储：转录自包含、可重放，不依赖外部文件；代价是会话文件会随图片变大，这也是服务端限制单图大小的原因。

## Web 输入管道

### API

`POST /api/sessions/:id/messages`

```json
{
  "text": "看看这张报错截图",
  "images": [{ "mimeType": "image/png", "data": "<base64 或 data URL>" }]
}
```

- `text` 可为空，只要至少有一张图片。
- `images` 可省略；出现时必须是数组。
- 单条消息最多 **4** 张；单图解码后最大 **4MB**；请求体最大 **24MB**（base64 约为原大小的 4/3）。
- 允许的 MIME：`image/png`、`image/jpeg`、`image/webp`、`image/gif`。
- `data` 接受裸 base64，也接受完整 `data:` URL（浏览器 `FileReader` 的产出）。
- 非法输入统一 400：非数组、类型不支持、base64 格式错误、图片过大、数组超限、既无文本也无图片。`readJson` 的超限返回 413。
- `GET /api/config` 新增 `imageInput: boolean`：当前启用模型声明了 `input` 且不含 `image` 时为 `false`；没有显式声明时按「可以尝试」处理，返回 `true`。

服务端只做校验与透传，图片经过 `Agent.run` 进入会话与模型请求。

### 前端（`src/web/public/index.html`）

- 发送框左侧的回形针按钮打开文件选择；同一入口支持**粘贴**图片和**拖放**到输入框。
- 选中后先在浏览器内缩放：最长边超过 1600px 的图片用 canvas 转成 JPEG（质量 0.85，白底填充）；GIF 与本身较小的图片保留原格式，避免破坏动画或二次压缩。仍超过 4MB 的会提示并拒绝。
- 附件以缩略图条显示在输入框上方，可逐张移除；上限 4 张。
- 纯图片也可以发送：提交条件从「文本非空」改为「文本或附件非空」。
- 当前模型不支持图片时，回形针禁用并显示提示「当前模型未启用图片输入，可在设置 → 模型中勾选「图片」」；此时发送带图消息也会被拦下。
- 历史消息把 parts 还原为文本气泡 + 缩略图网格，点击在新标签页打开原图。
- 轨迹里的 user 行显示 ` · N 张图片`，检查器追加 `[N 张图片]`，不展示 base64。

## 模型能力声明

设置面板里每个已启用模型可以勾选「图片」输入。该声明写入 `.agent/settings.json` 的 `enabled[].input`，既用于 `/api/config.imageInput`，也用于运行时向模型发送图片前的界面门控。`input` 未声明时不做限制（兼容旧配置）。

## 边界

- 只接入 OpenAI 兼容的 `image_url` data URL 形式；没有实现各家专有的文件上传 / file id 流程。
- 图片只出现在 user 消息里：工具结果、子 agent 的 `task` 参数、摘要都不携带图片。
- 会话中的图片不压缩、不去重；同一张图在多轮里重复出现就会重复计费与占空间。
- 没有把图片交给视觉专用模型做预处理，也没有 OCR 兜底。
- 模型不支持图片时，真正的失败仍由网关返回；界面门控只覆盖已声明的模型。

## 验证

```bash
pnpm typecheck
node --test test/multimodal.test.ts   # content helpers / wire 映射 / 上下文 / 会话 / HTTP
node --test test/ui.test.ts           # 历史渲染 + 附件按钮门控
node --test test/*.test.ts
npm run build
node bench/run.ts
```

`test/multimodal.test.ts` 覆盖：文本与图片读取不丢内容、OpenAI 线格式映射、`Agent.run` 写入 parts 与 `turn-start.attachments`、无图片时保持字符串、图片估算与摘要占位符、会话持久化与纯图片标题、图片-only 的实时 SSE 回合、以及 400 校验矩阵。
