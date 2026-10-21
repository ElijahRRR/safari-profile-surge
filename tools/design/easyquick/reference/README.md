EasyQuick UI 是一套面向数据密集型后台（订单、商品、库存、报表）的界面语言：青绿主色配深蓝灰暗色，大圆角、轻投影、局部毛玻璃，浅色与深色两套主题等价可用。视觉取自开源项目 sub2api 的前端（Vue 3 + Tailwind CSS 3），组件以 CSS 类的形式提供。

## 内容基调

- 界面文字以简体中文为主，专有名词与技术词保留英文：API、SKU、Webhook、WFS、OAuth。中英文之间留一个半角空格（`API 密钥`、`Walmart 美国站`）。
- 短句、陈述语气，先说结果再说条件。设置项的说明写清「作用 + 默认值」，源码原文示例：「向已登录用户展示他们能访问的渠道、模型和定价聚合视图。默认关闭。」
- 确认弹窗用「确定要……吗？」：「确定要删除此服务商吗？」危险操作的确认按钮用 `btn-danger`。
- 失败提示写「动作 + 失败」，必要时补原因：「保存面板接口限流配置失败」「同步失败：Walmart 接口返回 429，请稍后重试。」
- 不用感叹号、不用 emoji、不用口号。数字带单位与千分位（`$48,210`、`1,284 笔`），范围用短横（`5–1440 分钟`）。
- 按钮文案用动词：新建、保存、导出、同步、删除；取消按钮永远叫「取消」。

## 颜色

- 颜色分两层。**语义层**（`bg-*`、`text-*`、`border-*`、`brand*`、`success*` 等）随主题切换，新界面优先用它；**色阶层**（`primary-*`、`gray-*`、`dark-*` 及状态色阶）与源码 Tailwind 类名一一对应，`bg-gray-50`、`dark:bg-dark-950` 这样的写法直接映射到同名 token。语义层是本系统根据 `style.css` 的基础规则整理出的别名，源码本身只有色阶。
- 页面底用 `bg-page`；卡片、输入框、弹窗、下拉用 `bg-surface`；标签页轨道、行内代码、空状态图标框用 `bg-muted`；侧边栏用 `bg-sidebar`。
- 文字分四级：标题与关键数字 `text-strong`，正文 `text-default`，表格与表单 `text-body`，说明与提示 `text-muted`。占位符 `text-placeholder` 只用于占位符。
- 品牌色 `brand`（`primary-500`）只做填充：主按钮、开关开启、进度条、聚焦边框。品牌色文字用 `brand-text`，浅底用 `brand-soft`（当前导航项）。
- 主按钮是 `gradient-btn-primary`（`primary-500` → `primary-600` 从左到右），配 `shadow-btn-primary` 的青绿投影；危险、成功、警告按钮同样是本色 500 → 600 的横向渐变加同色 25% 投影。
- 状态色：成功 `success` / `success-soft`（emerald），警告 `warning` / `warning-soft`（amber），危险 `danger` / `danger-soft`（red）。徽章用「soft 底 + 700 字」，暗色下变成「900 的 30% 底 + 400 字」。状态点与 Toast 另用 `green-500`、`yellow-500`、`red-500`、`blue-500`。状态永远同时带文字或图标，不只靠颜色区分。
- 深色模式不是反相：表面换成 `dark-*` 色阶（页面 `dark-950`、侧边栏 `dark-900`、表面 `dark-800`、边框 `dark-700`/`dark-600`），品牌与状态文字提亮到 400 阶，浅底换成 900 阶的 20%–30% 透明色。
- 对比度（源码原值，保留不改）：浅色下 `brand-text`（`primary-600`）对白底约 3.7:1，白字对 `primary-500` 约 2.5:1，`text-placeholder` 约 2.5:1，`border-control` 约 1.2:1，均低于 WCAG 建议。小号品牌色文字需要达标时改用 `primary-700`（约 5.5:1）；`text-strong`、`text-body`、`text-muted` 在两套主题的 `bg-page`、`bg-surface` 上都 ≥ 4.6:1。

## 字体

- 只用系统字体栈 `sans`（system-ui → PingFang SC → 微软雅黑），代码与编号用 `mono`。没有自带字体文件。
- 界面主体是 14px：正文 `body`，按钮、标签、导航用 `label`（字重 500）。12px 只给 `caption`（提示、副标题）、`badge`（徽章、趋势值）和 `overline`（侧边栏分组标题，全大写、`0.05em` 字距；表头同款但字重 500）。
- 标题只有三档：页面标题 `page-title`（24px 粗体），弹窗与顶栏标题 `section-title`（18px 半粗），空状态标题 `empty-title`（18px 中粗）。统计数值 `stat-value` 与页面标题同尺寸，单行截断。
- 订单号、SKU、密钥用 `code`：`.code` 是 `bg-muted` 上的 `brand-text` 等宽小块。

## 间距与布局

- 应用外壳：固定侧边栏 256px（折叠 72px）+ 粘性毛玻璃顶栏 64px（`space-16`）+ 主内容区，主内容内边距随断点 `space-4` → `space-6` → `space-8`。外壳背景是 `bg-page` 上叠一层固定的 `gradient-mesh`。
- 控件内边距：按钮与输入框 `space-4` × `space-2.5`，小号按钮 `space-3` × `space-1.5`，大号按钮 `space-6` × `space-3`。
- 容器：卡片内容 `space-6`，统计卡 `space-5`，卡片头脚 `space-6` × `space-4`。卡片之间 `space-4`（统计卡网格）或 `space-6`（区块之间）。页面标题下留 `space-6`。
- 表格按列数自动收紧单元格横向内边距：≤4 列 24px，5–6 列 `space-4`，7–9 列 `space-3`，≥10 列 `space-2`。

## 圆角、边框与投影

- 圆角分三档：控件 `radius-xl`（按钮、输入框、导航链接、下拉、统计图标框），容器 `radius-2xl`（卡片、弹窗、大号按钮），胶囊 `radius-full`（徽章、开关、进度条、状态点）。小号按钮、标签页、Toast 用 `radius-lg`。
- 边框一律 1px：卡片 `border-subtle`，控件 `border-control`，其余 `border-default`。暗色卡片用 `dark-800` 50% 底配 `dark-700` 50% 边。
- 投影很轻：卡片静止 `shadow-card`，可点击卡片悬停 `shadow-card-hover` 并上移 2px；浮层（下拉、Toast）`shadow-lg`，弹窗 `shadow-2xl`。品牌光晕 `shadow-glow` 只给侧边栏 Logo 框这类单点。
- 毛玻璃只用于叠在内容或渐变之上的层：顶栏（`.glass`：表面 80% + `blur-xl`）、`glass-card`（表面 70% + `blur-xl` + `shadow-glass`）、模态遮罩（黑 50% + `blur-sm`）。

## 动效与状态

- 过渡统一 200ms ease-out（`transition-all duration-200`），卡片 300ms；弹窗进入 250ms、退出 200ms，从 95% 缩放淡入；Toast 从右侧滑入。尊重「减少动态效果」：弹窗动画缩短到 1ms 且不缩放。
- 按下：按钮 `active:scale-[0.98]`。悬停：次要按钮与表格行变 `gray-50`（暗色 `dark-700`/`dark-800`），幽灵按钮与下拉项变 `gray-100`。
- 聚焦：按钮是 2px `focus-ring`（`primary-500` 50%）加 2px 页面色间隙；输入框边框变 `primary-500` 并加 2px 30% 光环。
- 禁用：透明度 50%、`cursor-not-allowed`、取消缩放；禁用输入框底色 `gray-100`（暗色 `dark-900`）。
- 错误：输入框边框 `red-500` 加 `red-500` 20% 光环，下方 12px `red-500` 提示文字。

## 图标

- 图标是 Heroicons outline 风格：24×24 网格、`stroke-width` 1.5、圆角端点，用 `currentColor` 继承文字色。来源是 sub2api 的 `Icon.vue`，共 82 个，按原名收在 Icons 组。
- 尺寸五档：xs 12px（趋势箭头）、sm 16px（顶栏链接、关闭按钮）、md 20px（按钮内、导航、表单前缀，默认）、lg 24px（统计卡图标）、xl 32px。
- 资源库里的 SVG 把描边固定成 `#64748b`（`dark-500`），只为在 `<img>` 中能显示；写进界面时用内联 SVG + `currentColor`，颜色跟随所在文字。
- 不用 emoji 或彩色插画替代图标。空状态用 40px 图标放进 80px 的 `bg-muted` 圆角框。

## Logo

- EasyQuick 还没有自己的标志。侧边栏 Logo 位是 36px、`radius-xl`、带 `shadow-glow` 的方框，预览里暂用 `gradient-primary` 底 + 白色 `cube` 图标占位；有了正式标志后替换进去，并放进 Logos 组。
- Logos 组里的 `sub2api-logo.svg` 是来源项目 Sub2API 的标志，只作参考，不要当作 EasyQuick 的标志使用。

## 如何使用

- 组件是 CSS 类，不是 React 组件。在页面里先加载 `tokens.css`（本系统生成）再加载 `components/bundle.css`，然后按各组件说明写 HTML 并加类名：`btn btn-primary`、`input`、`card`、`badge badge-success`……主题切换给 `<html>` 设 `data-theme="dark"`。
- `bundle.css` 由源码 `style.css` 经 Tailwind 3.4 编译而来，颜色、间距、圆角、渐变、模糊都读取 `tokens.css` 的变量，所以在本页修改 token 会同步影响所有预览。它同时包含预览用到的 Tailwind 工具类（`flex`、`gap-3`、`text-sm` 等）。
- 如果新项目本身用 Tailwind 3：直接沿用 sub2api 的 `tailwind.config.js`（`primary`、`accent`、`dark` 色阶与自定义阴影、渐变），再复制 `style.css` 的 `@layer components`，类名与本系统完全一致；`darkMode` 用 `class` 时，暗色写法是 `dark:`。
- 预览中的商品、订单等内容是示例数据，只示范排版，不是规范的一部分。

## 未同步

- 没有字体文件：源码只用系统字体栈。
- 组件没有打包成可交互的 React 组件：源码是 Vue 3 单文件组件，这里走「只读」路线——用源码样式表编译出的 `bundle.css` 加静态 HTML 还原外观，不含交互逻辑。
- 只还原了所选的四组组件；源码中未收录的有：Select 下拉面板、DateRangePicker、HelpTooltip、ImageUpload、AnnouncementPopup、GroupSelector 等业务组件，以及 `.dropdown`、`.dialog-*`、`.code-block`、`.tour-*` 等样式类（已在 `bundle.css` 中，可直接使用，但没有单独的预览卡）。
- 支付品牌按钮 `.btn-stripe`、`.btn-alipay`、`.btn-wxpay`、`.btn-airwallex` 保留在 `bundle.css` 中，但没有导入对应的第三方品牌图标。
- `bundle.css` 对源码作了三处适配：暗色选择器从 `.dark` 改为 `[data-theme="dark"]`；AppSidebar.vue 与 Select.vue 的 scoped 样式并入（`:deep(svg)` 改为 `svg`）；色值改为读取 CSS 变量。
