# bench/transcripts

由 `node bench/run.ts --provider <kind> --record` 生成：每个任务一个 JSON，记录该任务里模型每次流式调用的请求指纹和事件。

- 可以提交进仓库，作为 CI 的确定性回归用例（`node bench/run.ts --replay`，不联网、不需要 key）。
- 修改任务的 fixture / prompt / 工具集后，请求指纹会变，回放会报 `replay drift`，重新录制即可。
