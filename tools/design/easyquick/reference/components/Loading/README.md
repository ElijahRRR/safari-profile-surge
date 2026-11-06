# Loading

等待中的反馈：旋转指示器和骨架屏。

- **Spinner**（LoadingSpinner.vue）：`div.spinner`——`currentColor` 圆环、顶边透明、持续旋转；尺寸 sm 16px / md 32px / lg 48px（3px 边）/ xl 64px（4px 边）；颜色 primary（`primary-500`）、secondary（`text-muted`）、gray、white。带 `role="status"` 与「加载中」读屏文字。按钮内加载用 16px 白色 spinner。
- **Skeleton**（Skeleton.vue）：`animate-pulse` 的 `gray-200`（暗色 `dark-700`）块，矩形 `radius-lg`、圆形 `radius-full`，宽高由使用方给。表格加载时 DataTable 自动渲染骨架行。
- 已知布局的首屏加载用骨架屏；局部、短时的等待用 spinner。
