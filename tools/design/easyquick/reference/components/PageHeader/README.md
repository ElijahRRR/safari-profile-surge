# PageHeader

页面内容的开头：大标题、一句说明、右侧页面级操作，下面通常紧跟筛选栏。

- **结构**：`div.page-header`（下边距 `space-6`）内左侧 `h1.page-title`（24px 粗体 `text-strong`）+ `p.page-description`（14px `text-muted`，上边距 4px），右侧 `btn-secondary` 次要操作 + `btn-primary` 主操作。
- 筛选栏：SearchInput（约 288px）+ Tabs（`w-fit`）横排，间距 `space-3`。
- 说明写当前数据的状态（数量、最近同步时间），不写功能介绍。
