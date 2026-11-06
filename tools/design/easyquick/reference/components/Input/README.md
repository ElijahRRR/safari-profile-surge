# Input

单行文本输入框，`input` 类加 `input-label` 标签和 `input-hint` / `input-error-text` 说明，含 Select 触发器的同款外观。

- **结构**：`label.input-label`（必填项在标签后加 `text-red-500` 的 `*`）→ `input.input` → `p.input-hint mt-1.5` 或错误时 `p.input-error-text mt-1.5`。
- **状态**：聚焦时边框 `primary-500` + 30% 光环（浏览器自动）；错误加 `input-error ring-2 ring-red-500/20`；禁用加 `disabled` 属性与 `opacity-60`。
- **前后缀**（Input.vue 的 `prefix` / `suffix` 插槽）：外层 `relative`，图标容器 `absolute inset-y-0 left-0 pl-3.5`（后缀 `right-0 pr-3`），输入框相应加 `pl-11` / `pr-11`。搜索框（SearchInput.vue）是前缀 `pl-3` + 输入框 `pl-10`。
- **Select**：`button.select-trigger` 内放 `span.select-value` 与 `span.select-icon`（16px `chevronDown`），展开时加 `select-trigger-open`。下拉面板不在本系统内。
- Input.vue 属性：`modelValue`、`type`、`label`、`placeholder`、`disabled`、`required`、`readonly`、`error`、`hint`、`autocomplete`。
- 不要省略标签只留占位符：`text-placeholder` 对比度不足，不能承担说明作用。
