# Button

一切可点击操作的按钮，基类 `btn` 加一个变体类。

- **变体**：`btn-primary`（每个视图最多一个主操作，青绿横向渐变 + 青绿投影）、`btn-secondary`（白底描边，导出、取消以外的次要操作）、`btn-ghost`（无底，表格行内操作、弹窗关闭、「查看全部」）、`btn-danger` / `btn-success` / `btn-warning`（删除、通过、暂停这类有明确后果的操作）。
- **尺寸**：默认 `space-4` × `space-2.5`、`radius-xl`；`btn-sm`（`radius-lg`，12px 字）、`btn-md`、`btn-lg`（`radius-2xl`，16px 字）；`btn-icon` 是只有图标的方形按钮，必须带 `aria-label`。
- **使用方提供**：`<button type="button">` 元素、文案、可选的 20px 图标（放在文字前，`gap-2` 已内置）。加载中时把图标换成 16px 白色 `spinner` 并设 `disabled`。
- 弹窗页脚顺序固定：左「取消」`btn-secondary`，右主操作 `btn-primary`（或 `btn-danger`）。
- 不要在同一行放两个 `btn-primary`；不要用 `btn-danger` 表达「重要」。
