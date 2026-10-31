# Progress

配额、同步、上传这类已知总量的进度。

- **结构**：`div.progress`（8px 高、`radius-full`、`gray-200` / 暗色 `dark-700` 轨道）内放 `div.progress-bar`，宽度用行内 `style="width:72%"`；进度条是 `primary-500` → `primary-400` 的横向渐变，宽度变化有 300ms 过渡。
- **使用方提供**：百分比，以及上方一行 14px 的名称与数值（`justify-between`）。
- 未知时长的等待用 Loading 里的 spinner，不用不动的进度条。
