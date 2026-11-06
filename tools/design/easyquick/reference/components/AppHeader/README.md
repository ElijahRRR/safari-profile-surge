# AppHeader

内容区顶部的毛玻璃顶栏：左侧页面标题，右侧全局工具。

- **结构**（AppHeader.vue）：`header.glass`（表面 80% + `blur-xl`）粘在顶部、64px 高、底部半透明 `border-default`；左侧 `section-title` 页面标题 + 12px `text-muted` 副标题（≥1024px 显示，窄屏换成 `btn-ghost btn-icon` 菜单按钮）；右侧依次是文字链接（16px 图标 + 14px 字、`radius-lg`、悬停 `gray-100`）、余额胶囊（`brand-soft` 底、`brand-text` 金额、可选 amber 冻结标签）、用户按钮（32px 渐变头像 + 姓名 + 角色 + `chevronDown`）。
- **使用方提供**：页面标题与说明、链接、余额等用户数据、用户菜单。
- 顶栏只放全局性的东西；页面自己的操作按钮放在 PageHeader 里。
