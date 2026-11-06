# EmptyState

列表或页面没有数据时的占位：图标框 + 标题 + 说明 + 一个主操作。

- **结构**（EmptyState.vue）：`div.empty-state`（居中、`space-12` 纵向内边距）→ 80px `bg-muted` `radius-2xl` 图标框，内放 40px `empty-state-icon`（`gray-300` / 暗色 `dark-600`，默认是收件箱图形）→ `h3.empty-state-title` → `p.empty-state-description`（最宽 384px，`text-muted`）→ 可选 `btn btn-primary` 操作（带 `plus` 图标）。
- 属性：`title`、`description`、`icon`、`actionText`、`actionTo` / `action` 事件、`actionIcon`、`message`。
- 说明写「下一步可以做什么」，不写「暂无数据」这类重复标题的话。
