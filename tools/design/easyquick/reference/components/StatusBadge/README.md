# StatusBadge

「彩色圆点 + 文字」的运行状态指示，比 Badge 更轻，适合列表中的启用/停用。

- **结构**（StatusBadge.vue）：`flex items-center gap-1.5` 内一个 8px `radius-full` 圆点和一段 14px `text-body` 文字。
- **状态映射**：`active` / `success` → `green-500`；`disabled` / `inactive` / `warning` → `yellow-500`；`error` / `danger` → `red-500`；其他 → `gray-400`。
- **使用方提供**：`status`（决定颜色）和 `label`（显示文字）。文字必填——圆点颜色不能单独表达状态。
