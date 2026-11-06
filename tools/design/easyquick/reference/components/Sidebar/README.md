# Sidebar

应用的主导航：固定在左侧，可折叠，分为品牌区、导航区、底部工具区。

- **结构**（AppSidebar.vue）：`aside.sidebar`（固定、256px、`bg-sidebar`、右侧 `border-default`）→ `sidebar-header`（64px：36px Logo 框 `radius-xl` + `shadow-glow`，品牌名 18px 粗体，下方版本徽章）→ `sidebar-nav`（滚动、`space-3` 内边距）由若干 `sidebar-section` 组成，分组标题 `sidebar-section-title`（12px 半粗、全大写，`gray-400` / 暗色 `dark-500`）→ 底部 `border-subtle` 分隔的主题切换与折叠按钮。
- **导航项**：`sidebar-link`（20px 图标 + 14px 字重 500、`radius-xl`、悬停 `gray-100`）；当前项加 `sidebar-link-active`（`brand-soft` 底 + `brand-text` 字）。带子项的分组右侧是 16px `chevronDown`，展开后子项缩进 16px 并有左侧竖线，子项图标 16px。
- **折叠态**：宽 72px，加 `sidebar-header-collapsed`、`sidebar-link-collapsed`、`sidebar-label-collapsed` 等类隐藏文字，分组标题变成一条横线，导航项靠 `title` 提示名称。
- **使用方提供**：Logo、品牌名、导航数据（label、path、icon、children）、当前路由、折叠状态。
