# AppLayout

完整的应用外壳，展示 Sidebar、AppHeader 与主内容区如何组合。

- **结构**（AppLayout.vue）：根元素 `min-h-screen bg-page`，其上固定铺一层 `gradient-mesh`（`pointer-events-none`）；`Sidebar` 固定在左；主区域 `relative min-h-screen`，≥1024px 时左边距 256px（折叠时 72px），内含 `AppHeader` 与 `main`（内边距 `space-4` / `space-6` / `space-8`）。
- 主内容的常见顺序：PageHeader → StatCard 网格（`gap-4`）→ 卡片或表格（区块间 `space-6`）。
- 这是组合示例，不是独立组件：实际使用时由路由页面填充 `main` 的内容。
