# EasyQuick UI 来源说明

本目录与 `apps/web/src/styles/easyquick.css`、`apps/web/src/styles/tokens.css` 来自项目所有者的 EasyQuick UI 设计系统（claude.ai 设计系统 Artifact，2026-10-21 版本）。

- `tokens.json`：设计 token 原文件；`apps/web/src/styles/tokens.css` 由 `tools/design/gen-tokens-css.mjs` 生成，不要手改。
- `apps/web/src/styles/easyquick.css`：设计系统的 `components/bundle.css` 原样复制。按其文件头说明，它由 Wei-Shaw/sub2api@7da09ca 的 `frontend/src/style.css` 经 Tailwind CSS 3.4.17 编译而来（Tailwind CSS 为 MIT 许可）。**sub2api 的许可条款尚未在本仓库核对**；公开分发前请确认其许可允许再分发，否则改为按 token 重写组件样式。
- `icons.json`：设计系统 Icons 组中本项目用到的 Heroicons outline 路径（Heroicons 为 MIT 许可）。
- `reference/`：设计系统的品牌手册与组件说明、预览 HTML，仅供实现时对照，不参与构建。
- `sub2api-logo.svg` 未复制：设计系统说明它只是来源参考，不能作为本项目标志。侧边栏 Logo 位按设计系统约定使用 `gradient-primary` 方框 + 白色图标占位。
