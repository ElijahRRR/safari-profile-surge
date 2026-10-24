# Pagination

表格底部的分页条：左侧条数信息与每页条数，右侧页码组。

- **结构**（Pagination.vue 桌面版）：白底（暗色 `dark-800`）、顶部 `border-default` 分隔、`space-4` / `space-6` × `space-3`；页码是一组相连的 `radius-md` 描边按钮，当前页 `primary-500` 边 + `primary-50` 底 + `primary-600` 字，省略号不可点击，首尾是 20px 的 `chevronLeft` / `chevronRight`。
- 每页条数用 80px 宽的 Select 触发器，选项默认 10 / 20 / 50 / 100；可选「跳转到」输入框 + `btn-ghost btn-sm`。
- 属性：`total`、`page`（从 1 开始）、`pageSize`、`pageSizeOptions`、`showPageSizeSelector`、`showJump`；事件 `update:page`、`update:pageSize`。
- 窄屏源码切换为「上一页 / 第 x 页，共 y 页 / 下一页」三段式。
