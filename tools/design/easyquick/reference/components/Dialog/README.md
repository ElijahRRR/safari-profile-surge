# Dialog

需要用户集中处理的模态弹窗：编辑表单、确认操作。

- **结构**（BaseDialog.vue）：`div.modal-overlay`（固定铺满、黑 50% + `blur-sm`、居中）→ `div.modal-content`（`bg-surface`、`radius-2xl`、`shadow-2xl`、最高 90vh）→ `modal-header`（`modal-title` + 右侧 20px `x` 关闭按钮）→ `modal-body`（可滚动）→ `modal-footer`（右对齐，按钮间距 `space-3`）。
- **宽度**（`width` 属性）：narrow `max-w-md`（确认框）、normal `max-w-lg`（默认）、wide / extra-wide / full 逐级放宽到 7xl。
- 属性：`show`、`title`、`width`、`closeOnEscape`、`closeOnClickOutside`、`showCloseButton`；插槽 `default`、`footer`；事件 `close`。进入 250ms、退出 200ms 缩放淡入淡出。
- 确认弹窗（ConfirmDialog.vue）：narrow 宽度，正文一行 14px `text-muted`（「确定要删除此服务商吗？」），危险时确认按钮为红色。
- 弹窗里不要再开弹窗；长表单改用独立页面。
