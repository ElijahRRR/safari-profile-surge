# Toast

操作结果的轻量通知，从右上角滑入，自动消失。

- **结构**（Toast.vue）：固定在右上 `space-4` 处纵向堆叠（间距 `space-3`）；每条 320–448px、`bg-surface`、`radius-lg`、`shadow-lg`、左侧 4px 状态色边；内部 `space-4`：20px 状态图标 + 文字 + 16px 关闭按钮；有时长时底部 4px 进度条倒计时。
- **类型**：success → `green-500` + `checkCircle`；error → `red-500` + `xCircle`；warning → `yellow-500` + `exclamationTriangle`；info → `blue-500` + `infoCircle`。
- 有标题时：标题 14px 半粗 `text-strong`，正文 14px `leading-relaxed` 的 `gray-600`（暗色 `gray-300`）；无标题时正文用 `text-strong`。
- 只放一句话的结果；需要用户决定的事用 Dialog。
