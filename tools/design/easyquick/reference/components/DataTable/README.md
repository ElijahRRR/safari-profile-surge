# DataTable

列表页的主表格：浅灰表头、整行分隔线、行悬停高亮、可选勾选列与行内操作。

- **结构**（DataTable.vue 桌面版）：外层 `card overflow-hidden` → `table-wrapper`（横向滚动）→ `table.w-full.min-w-max.divide-y` → `thead.bg-gray-50`（暗色 `dark-800`）里的 `th`：12px 字重 500、全大写、`0.05em` 字距、`text-muted`；`tbody.bg-white`（暗色 `dark-900`）里的 `td`：14px `text-default`、`py-4`、不换行。
- 单元格横向内边距随列数收紧：≤4 列 24px，5–6 列 16px，7–9 列 12px，≥10 列 8px。
- 行悬停 `gray-50`（暗色 `dark-800`）；勾选行 `primary-50` 40%（暗色 `primary-900` 10%）。可排序列的表头悬停变 `gray-100` 并显示上下箭头。
- 属性：`columns`（key、label、sortable、formatter、class）、`data`、`loading`（显示骨架行）、`selectable`、`rowKey`、`defaultSortKey` / `defaultSortOrder`、`sortStorageKey`；插槽 `cell-{key}` 自定义单元格、`empty` 自定义空状态。
- 编号类单元格用 `code`，状态用 Badge，操作用 `btn-ghost btn-sm` 的图标按钮（带 `aria-label`）。移动端源码改为卡片列表，本预览只示范桌面版。
