# Tabs

同一数据集的视图切换（全部 / 待发货 / 已发货），分段控件样式。

- **结构**：`div.tabs`（`bg-muted` 轨道、`radius-xl`、`space-1` 内边距与间距）里放若干 `button.tab`，当前项加 `tab-active`（`bg-surface` 白底 + `shadow-sm`，暗色 `dark-700`）。
- 轨道默认撑满一行，放在筛选栏里时加 `w-fit`。
- **使用方提供**：选项文案（2–4 个字最佳）、当前项、`role="tablist"` / `role="tab"` / `aria-selected`。
- 选项超过 6 个改用 Select；不要用 Tabs 做页面级导航（那是侧边栏的事）。
