# Toggle

开/关二元设置的开关，用在设置列表的行尾。

- **结构**（Toggle.vue）：`button[role=switch][aria-checked]`，44×24、`radius-full`；开启 `bg-primary-600` 且滑块 `translate-x-5`，关闭 `bg-gray-200`（暗色 `dark-600`）。滑块是 20px 白色圆点加 `shadow`。
- 另有 `.switch` / `.switch-active` / `.switch-thumb` 三个样式类，开启色为 `primary-500`，效果相同，适合非按钮元素。
- **使用方提供**：当前布尔值、点击切换逻辑、左侧的标题（14px `label`）与一行 12px `text-muted` 说明。
- 开关立即生效；需要「保存」才生效的选项用复选框，不用开关。
