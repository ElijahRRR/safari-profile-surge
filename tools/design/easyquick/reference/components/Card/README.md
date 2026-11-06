# Card

内容分组的基本容器：白底（暗色 `dark-800` 50%）、`radius-2xl`、`border-subtle`、`shadow-card`。

- **结构**：`div.card` 内可选 `card-header`（`space-6` × `space-4`，底部分隔线）→ `card-body`（`space-6`）→ `card-footer`（顶部分隔线，常放右对齐按钮）。
- **变体**：`card-hover` 给可点击卡片（悬停上移 2px、`shadow-card-hover`）；`glass-card` / `card-glass` 是 70% 表面 + `blur-xl` + `shadow-glass` 的毛玻璃卡，只放在有渐变或内容可透出的背景上。
- 表格放进卡片时给卡片加 `overflow-hidden`，让表头贴合圆角。
- 不要卡片套卡片；需要再分层时用 `card-header` 分隔或 `bg-muted` 区块。
