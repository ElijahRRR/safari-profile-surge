# Safari 扩展（extension）

Safari Web Extension（MV3）：后台消息路由、弹窗、准备页、登录页内容脚本。实现规格见 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) §6.10、§7.2、§9。离线测试通过不代表 Safari 中的行为已验证，网络与 Safari 行为以测试 Mac 上的 P0 结果为准。

## 构建

在仓库根目录安装依赖后：

| 命令（在 `extension/` 下） | 输出 | 用途 |
|---|---|---|
| `npm run build`（即 `vite build`） | `dist/` | 可放进宿主 App 的扩展目录：`popup.html`、`prepare.html`、`assets/`、`background.js`（ES module，自包含）、`content.js`（IIFE，运行时无 import）、`manifest.json`、`icons/` |
| `npx vite build --mode harness` | `dist-harness/` | 演示页：只含弹窗与准备页，由本机服务在 `/dev/extension/` 下提供 |
| `npx vue-tsc -p tsconfig.json --noEmit` | — | 类型检查 |
| `npx vitest run --project extension`（在仓库根目录） | — | 单元与组件测试（happy-dom，模拟 `browser`） |

页面由 Vite 多入口构建；后台与内容脚本在页面构建结束后由 `build/plugin.ts` 用 esbuild 单独打包，`manifest.json` 由 `src/manifest.ts` 生成，是权限与匹配规则的唯一来源。

`dist/` 是给 `apps/macos` 的 App Extension 打包用的资源目录。开发时可以用 Safari「开发」菜单临时加载，但临时扩展退出 Safari 就会移除，也不带原生桥，不是交付方式。

## 组成

| 目录 | 职责 |
|---|---|
| `src/background/` | 唯一调用 `runtime.sendNativeMessage` 的地方。扩展页面可转发原生请求（`requestLoginFill` 除外）；内容脚本只能发 `requestLoginFill`，后台丢弃它自报的地址、框架与路由序号，改用 `sender` 与一次新的 `getCurrentState` 重建。任何生命周期、窗口、标签页、焦点事件都只会触发 `reportProfileState` 提示上报，从不激活或进入普通模式 |
| `src/popup/` | 弹窗（380px，EasyQuick UI）：当前场景状态、关联与创建、使用此环境、打开或定位订单页、重新检测、编辑、进入普通模式、旧窗口确认、等待中的验证与取消 |
| `src/prepare/` | 准备页 `prepare.html?op=<operation_id>`：表示场景到达、请求固定检测服务、提交结果、等待操作结束；成功前从不导航到 Amazon |
| `src/content/` | 登录页条件填充：只请求页面上实际出现的字段，写入前重读 `form.action`，每页每字段最多一次，从不提交或点击；识别不到时显示「可手动填充」 |
| `src/harness/` | 演示模式替身，只进入 `--mode harness` 构建（正式构建中被常量折叠移除） |
| `build/` | 构建插件与占位图标生成 |

## 秘密与存储

- 代理用户名/密码、登录密码只在编辑表单组件的内存中，按 `SecretChange`（保留 / 替换 / 清除）发送；提交或关闭时清空，不保存草稿。
- 扩展不写 `localStorage`、`sessionStorage` 或 `storage.*`。`storage` 权限只为以后的界面偏好保留，从不存凭据。
- 后台、页面、内容脚本都不向控制台打印请求或应答。登录填充值只在内容脚本写入输入框的瞬间存在。

## 演示模式

`dist-harness/` 中的页面把原生传输换成 `POST /dev/native`，请求体 `{ profileId, envelope }`，`profileId` 来自页面地址的 `?profile=`（缺省为未识别场景），请求头 `Authorization: Bearer <localStorage 'sfe.session'>`（与网页后台同源登录后即有）。应答体按原生应答 `{ ok, data | error }` 解析。

演示模式不打开或导航到任何外部站点；准备页不请求检测服务，返回合成出口 `192.0.2.10`（可用 `?demo_ip=` 覆盖）。页面顶部常驻 DEMO 标识。

## 占位图标

`icons/` 是构建时生成的青绿圆角方块（EasyQuick `gradient-primary`），只是占位。正式标志尚未设计，有了之后替换 `build/png.ts` 的生成逻辑或直接提供 PNG。

## 需要在测试 Mac 上确认

manifest.json 不能写注释，这些待确认项记录在这里：

- **后台形式**：当前用 `"background": { "scripts": ["background.js"], "type": "module", "persistent": false }`。需要确认 Safari（macOS 14 / Safari 17 起）对非持久 module 后台的支持，以及是否应改为 `service_worker`；两种形式下都要验证后台休眠后被 `sendMessage` 唤醒仍能完成原生往返（并入 `native_bridge_ipc`）。
- **不申请 `tabs` 权限**时，`tabs.query({ url: [...] })` 在站点权限下是否返回匹配的标签页与 URL（决定 `amazon_tabs_open` 与订单页定位）。
- 内容脚本消息的 `sender.id`、`sender.frameId`、`sender.tab.url` 是否都由 Safari 提供；缺任何一项时填充直接拒绝。
- `runtime.onMessage` 用 `sendResponse` + `return true` 的异步应答，以及 `sendNativeMessage` 返回 Promise。
- 扩展页面 CSP（`connect-src` 只允许检测服务）在 Safari 中的生效情况；准备页请求检测服务时按 Safari 进程路径归属（`extension_page_fetch` 协议覆盖）。
- 场景未启用扩展、站点权限未授予时弹窗的提示是否与实际一致。
