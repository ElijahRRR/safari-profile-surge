# safari场景-surge

Safari 用户场景驱动的 Surge 出口控制。目标是在使用一个已绑定场景时，让 Safari 使用该环境的代理链，减少手动调整 Surge 的步骤，并保持其他浏览器使用原规则。

**当前状态（2026-10-31）：已有第一版实现（本机服务、网页后台、Safari 扩展、macOS 原生宿主与 P0 实测工具），离线测试通过；测试 Mac 上只做过部分 P0 实测，还没有任何一项能力门槛在网页后台确认，真实网络验收尚未进行。节点发布按用户决定 D10（2026-10-31）改为本机回环资源服务，回环资源四项能力还没有在测试 Mac 上用产品代码测过。**所有依赖网络能力的动作都受能力门槛约束：P0 实测通过并在网页后台确认之前会被拒绝。离线测试、语法检查与旧实验结果不能替代真实网络验收。

测试 Mac 上已有的实测（[2026-10-24 记录](docs/verification/2026-10-24-mac-p0-increment.md)，macOS 27.0.1、Safari 27.0.1、Surge 6.10.0 (12500)）：Swift XCTest 132 项通过；P0 `instance` 通过；`takeover_state_readable` 的 P0 结果通过（尚未在网页确认）；`rule match` 与临时规则的添加、按完整文本撤销可用；扩展在 Safari 退出重开后仍启用、弹窗读到同一场景。**`safari_process_attribution`（Safari 精确进程归属）目前阻塞**：Safari 与独立 WKWebView 的对照还不能给出稳定的 Safari 专属进程路径，而入口规则的前提正是它。其余能力的证据状态见该记录的矩阵。[2026-10-24 固定配置实测](docs/verification/2026-10-24-fixed-profile-live.md)表明自动重载关闭时本地节点文件不被 Surge 重新读取，原来的本地文件发布路线在日常条件下不成立；[2026-10-25 回环资源补测](docs/verification/2026-10-25-loopback-main-witness-matrix.md)（原型夹具、合成节点）观察到对 127.0.0.1 资源的单 key 更新不加载磁盘上未加载的主配置，但下载失败时命令仍退出 0，坏节点会被静默丢弃——这是 D10 的依据，也是它必须严格读回的原因。

GitHub 仓库标识使用 `safari-profile-surge`，项目中文名称保留为 `safari场景-surge`。

## 从这里开始

1. [Claude 开发入口](CLAUDE.md)：阅读顺序、不可改变的约束与第一步任务。
2. [产品与场景控制设计](design/方案1-场景驱动Safari代理设计.md)：用户工作流程、场景绑定、订单页和条件填充。
3. [固定配置、命名与更新机制](design/固定工作配置-命名与更新机制.md)：日常配置不切换、节点命名、发布门槛。
4. [插件—网页后台—Surge 实时同步](design/插件-网页后台-Surge实时同步设计.md)：接口、状态、并发、读回和回滚。
5. [开发实施与验收](docs/DEVELOPMENT.md)：组件拆分、任务顺序、交付和测试清单。

实现相关文档：

- [实现规格](docs/ARCHITECTURE.md)：设计文档落地后的数据模型、事务、接口与已知冲突（第 0 节）。
- [安装与回退](docs/INSTALL.md)：构建、免费 Apple ID 签名、首次运行、卸载。
- [P0 实测手册](docs/P0-RUNBOOK.md) 与 [验收报告模板](docs/ACCEPTANCE.md)：在测试 Mac 上逐项验证能力门槛。
- [测试 Mac 执行清单](docs/P0-CHECKLIST.md)：当前真机状态、开始前要用户决定的事项、P0 的执行顺序与停止条件。
- [实测记录](docs/verification/)：测试 Mac 上每轮实测的脱敏结果与证据边界（目前有 [2026-10-24 增量](docs/verification/2026-10-24-mac-p0-increment.md)、[2026-10-24 固定配置](docs/verification/2026-10-24-fixed-profile-live.md)、[2026-10-25 资源错误分类](docs/verification/2026-10-25-resource-error-classification.md)、[2026-10-25 回环资源补测](docs/verification/2026-10-25-loopback-main-witness-matrix.md)）。

## 代码结构与本地演示

| 目录 | 内容 |
|---|---|
| `packages/contract` | 服务、网页、扩展与 P0 工具共用的类型、阶段、错误码与能力门槛定义 |
| `packages/easyquick` | EasyQuick UI 设计系统（色板、组件类、图标）的本地实现 |
| `service` | 本机后台（唯一写入者）：SQLite、Surge 适配层、执行器、HTTP/套接字接口、`sfe` 命令行 |
| `apps/web` | 网页后台（Vue 3） |
| `extension` | Safari Web Extension：弹窗、准备页、登录填充 |
| `apps/macos` | 宿主 App、扩展原生桥与 LaunchAgent（XcodeGen 工程，需在 Mac 上编译） |
| `tools/p0` | P0 能力实测工具与测试服务器 |

```sh
npm ci
npm run check    # 类型检查、离线测试、构建与仓库秘密扫描
npm run demo     # 演示模式：模拟 Surge 与合成数据，不读写真实 Surge 配置
```

演示模式启动后会打印临时数据目录。登录网页后台需另开终端执行 `node service/dist/sfe.mjs open --data-dir <该目录>`（一次性登录链接，60 秒内有效）；登录后可在 `http://127.0.0.1:61847/dev/extension/popup.html?profile=demo-profile-0002` 体验扩展弹窗。演示界面上的“已生效”不代表任何网络事实。

## 已确定的产品边界

- 同一时刻整个 Safari 共用一个环境出口，不要求多个场景并发走不同代理。
- 环境关联 Safari 场景、代理链、Amazon 站点和可选买家号信息；未配置场景在普通模式下继续原 Surge 规则。
- 代理一般是 SOCKS5，必须配置前置；不把代理连接地址当作实际出口。
- 一份由本机原配置复制的固定工作配置长期用于日常上网，不按环境切换配置文件。
- 插件与类似 Sub-Store 的本机网页共用本机后台；后台是配置唯一写入者。
- 已登录直接打开订单页；只在实际登录页按需要填充，不自动提交或处理验证码。
- 不新增 Amazon MITM，不用通用 WebKit 进程名冒充 Safari 专属归属。
- 不承诺完整流量防泄漏、指纹隔离或账号关联风险保证。
- 不使用 macOS 钥匙串（用户决定）：代理凭据与亚马逊账号密码以明文保存在本机后台自己的数据库中，只靠文件权限保护（仅本机这个用户可读）；网页、日志与命令行从不显示。后果与旧版本数据目录的处理见 docs/ARCHITECTURE.md §0 与 docs/INSTALL.md §6、§7。

## 本次交接范围

仓库只包含源码、文档与合成测试数据；未包含本机 Surge 配置、代理凭据、证书、买家账号、浏览器资料、原始请求日志及此前请求头标记实验的安装包。开发先用空白测试场景和合成数据；真实网络测试在用户指定的测试 Mac 本地完成。

最低支持 Surge for Mac 6.10.0（构建 ≥ 12500、Controller 协议 ≥ 22，用户决定；不兼容 6.5）。design 中以 6.5.0 (10960) 为测试版本的调研只作历史记录；开发与 P0 都按 6.10 官方文档使用命令，文档没有写明的行为标为待验证（TODO(P0)）并失败即关闭。低于最低版本或读不到版本时依赖版本的动作被拒绝，进入普通模式仍可用（低于 6.9 时入口撤销无法用 `rule match` 确认，见 docs/ARCHITECTURE.md §0）。节点发布（用户决定 D10，2026-10-31）：SFE-ROUTE 的 policy-path 指向本机回环资源服务（只监听 127.0.0.1，路径带随机读取令牌）；发布时服务提供新版本，只对这一项资源执行一次 `external-resource update`（从不 update all），再严格读回并与服务记录的下载核对。回环资源四项 P0 补测（单 key 更新、认证与端口占用、重启后的缓存与恢复、并发与崩溃）在网页确认之前新节点保持“已保存，待部署”，其中前三项确认之前资源服务只提供不含买家节点的占位内容。与 design 的偏离（含固定工作配置设计第 81、83 行）记录在 docs/ARCHITECTURE.md §0。

## 开发优先级

先验证 Safari 精确归属、无主配置切换的运行时控制、经本机回环资源服务的节点资源单 key 更新（及其认证与端口占用、重启缓存、并发与崩溃补测）和其他应用连接连续性；通过后再完成导入、界面、场景绑定、订单和填充。能力门槛不过时先记录限制，不用扩大 MITM、全局改代理或频繁重载掩盖问题。
