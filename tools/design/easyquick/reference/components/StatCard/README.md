# StatCard

仪表盘上的单个指标：图标框 + 标签 + 大数字 + 可选趋势。

- **结构**（StatCard.vue）：`div.stat-card`（卡片 + `space-5` 内边距 + 横排 `space-4`）→ `div.stat-icon stat-icon-{primary|success|warning|danger}`（48px、`radius-xl`、soft 底 + 600 阶图标，24px 图标）→ 文字列：`p.stat-label`、`p.stat-value`（24px 粗体，单行截断）、`span.stat-trend stat-trend-up|down`（12px 箭头 + 百分比；持平用 `text-muted` 且不带箭头）。
- 属性：`title`、`value`、`icon`、`iconVariant`（默认 primary）、`change`、`changeType`（up / down / neutral）、`formatValue`。
- 四张一行（`grid-cols-4 gap-4`），窄屏两张一行。图标颜色表达指标性质，趋势颜色表达好坏：退货率上升应该用 `stat-trend-down` 的红色，由使用方判断。
