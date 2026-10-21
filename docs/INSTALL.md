# 安装、首次运行、卸载与回退

日期：2026-10-21。适用：macOS 14（Safari 17）或更高、Surge for Mac（开发调研时为 6.5.0，以本机实测为准）。本文件只描述步骤；网络能力是否成立以 docs/P0-RUNBOOK.md 的实测与网页后台确认为准，未确认的能力对应的动作会被拒绝。

## 1. 构建

### 1.1 前提

| 项目 | 要求 |
|---|---|
| macOS | 14 或更高 |
| Xcode | 16 或更高 |
| XcodeGen | `brew install xcodegen` |
| Node | 22.13 或更高（仓库开发与构建）；另需一个固定版本的 Node 二进制随 App 打包（见 1.3） |
| Apple ID | 免费即可（Personal Team）；见 1.4 的限制 |

### 1.2 服务、网页与扩展

在仓库根目录：

```sh
npm ci
npm run build      # 生成 service/dist（service.mjs、sfe.mjs、web/）与 extension/dist
npm run check      # 类型检查、离线测试、构建与仓库秘密扫描
```

离线测试通过只代表代码逻辑，不代表网络验收通过。

### 1.3 生成 Xcode 工程并构建

1. 复制 `apps/macos/Local.xcconfig.example` 为 `apps/macos/Local.xcconfig`（已被 .gitignore 排除，不提交），填写：
   - `DEVELOPMENT_TEAM`：Xcode → Settings → Accounts 中个人团队的 Team ID（10 位）；
   - `SFE_NODE_BINARY`：固定版本 Node 二进制的绝对路径（从 nodejs.org 下载 macOS 压缩包解压到仓库之外）；
   - `SFE_NODE_VERSION`：该二进制的版本号（构建时运行 `node --version` 核对，不一致即失败，从不下载）。
2. 生成工程并构建：

   ```sh
   cd apps/macos
   xcodegen generate
   xcodebuild -scheme SafariProfileSurge -configuration Debug build
   xcodebuild -scheme SafariProfileSurge test
   ```

   也可以 `open SafariProfileSurge.xcodeproj` 后在 Xcode 中 Product → Run。生成的 `.xcodeproj` 不提交。

### 1.4 免费 Apple ID（Personal Team）签名

- 签名方式为自动签名（Apple Development）。App Group 为 `<Team ID>.sfe`，扩展的钥匙串访问组为 `<Team ID>.com.sfe.shared`（只用于备选钥匙串方案）。
- **重签频率**：免费描述文件约 7 天过期。过期前需要在 Xcode 中重新构建运行（或重新 `xcodebuild` 并替换 App）。过期后的表现（App 无法启动、扩展被停用、原生桥失败）由 P0 的 `extension_install_persistence` 实测记录。
- **影响**：每次重新签名都可能改变钥匙串访问控制对“受信任应用”的识别，导致读取账号密码时再次弹出钥匙串授权提示；提示次数由 `bridge_keychain_access` 记录。场景 ID 在重签后是否变化由 `native_profile_id` 记录。
- **未决**：Personal Team 是否满足“正式产品需正常打包签名”尚未验证（ARCHITECTURE 冲突 2）。「开发」菜单中的「允许未签名扩展」不是正常安装路径；如果只能依赖它，交付物视为不满足约束，会在验收报告中写明。

## 2. 安装

1. 把构建出的 `SafariProfileSurge.app` 放到 `/Applications` 并打开。菜单栏出现图标。App 每次启动都会幂等地：
   - 创建数据目录 `~/Library/Application Support/SafariProfileSurge`（0700），写入原生桥传输令牌副本 `bridge.token`（0600）；
   - 在 App Group 容器写入扩展使用的 `bridge.json` 与 `bridge.token`；
   - 合并写入 `install.json`（0600）：Surge CLI 路径（只在 `/Applications/Surge.app/Contents/Applications/surge-cli` 存在时）、钥匙串工具路径、Node 版本、桥接端口、网页目录，以及首次创建时全部为 `unavailable` 的 `adapterMechanism`（由 P0 填写，App 从不覆盖）。
2. 菜单「注册后台服务」：以 SMAppService 注册内置的 LaunchAgent。系统可能要求在「系统设置 → 通用 → 登录项」中允许。服务不带演示参数，不含任何秘密。
3. 在 Safari →「设置」→「扩展」中勾选 SafariProfileSurge（菜单「Safari 扩展设置」可直接打开）。
4. **每一个**需要绑定的 Safari 场景都要单独启用扩展：在 Safari 设置中切换到该场景，勾选扩展，并在扩展的网站权限中把 `www.amazon.com` 设为「允许」。扩展只申请这个站点与固定的检测服务主机；不能替你给以后新建的场景自动授权，新建场景后需要重复本步。
5. 菜单顶部会提示「Safari 扩展未启用」或「原生桥无法连接」；按提示处理。

## 3. 首次运行

顺序固定，前一步没有完成不要做下一步。

1. **P0 实测**：按 docs/P0-RUNBOOK.md 在测试配置上完成实测（只用空白测试场景与本机测试代理），测完**手动**切回原配置、删除测试文件。
2. **原语映射**：把 P0 确认的映射写入 `install.json` 的 `adapterMechanism`（保持 0600），重启后台服务（菜单「停止后台服务」→「注册后台服务」）。
3. **确认能力**：菜单「打开管理后台」（或 `sfe open`），在「能力门槛」页逐条核对 P0 提交的提议（上下文、脱敏摘要、逐协议覆盖、进程路径、入口策略）并确认。确认新的进程路径或入口策略要求入口为 NORMAL。
4. **初始化工作配置**：在「发布与 Surge」页运行初始化向导：
   - 预览只读：备份当前活动配置、它引用的本地文件与可读的运行开关到数据目录 `backups/`（0700/0600）；检测远端托管头与远端来源、配置目录是否在 iCloud/同步位置（默认拒绝）、名称与文件冲突、http-api 绑定、自动重载与接管状态；构造候选并 `--check`。
   - 确认后写入新文件「日常-Safari环境.conf」与占位资源文件（目标文件必须不存在）。
   - **由你在 Surge 菜单「配置」中手动切换一次**到「日常-Safari环境」。此后日常不再切换配置；工具从不调用 switch-profile。
   - 选择 ruleset_resource 入口策略时，工作配置中的四条入口 RULE-SET 由初始化写入；之后改用其他策略需要 `remerge`。
5. **登记默认前置**：在「发布与 Surge」页（或 `sfe admin front add <Surge 中已有的固定节点名> --default`）登记一个你已有的固定代理节点作为默认前置。只接受用户代理节点，不接受组、DIRECT/REJECT 或 SFE- 节点。
6. **导入环境**：在「导入」页上传 CSV/XLSX/JSON（模板在页面中下载，或 `sfe import <文件>` 预览、`--commit` 提交）。秘密只经页面表单或标准输入传递，从不出现在命令行参数中。导入只保存期望数据；节点发布受发布门槛约束。
7. **关联场景**：在每个已启用扩展的 Safari 场景中打开扩展弹窗，按「关联已有环境」选择对应环境（或使用网页的关联向导）。不要按场景名自动猜测。

## 4. 日常使用

- **打开环境**：菜单「打开环境」→ 选择环境（受控入口），或在已绑定场景的扩展弹窗中「使用此环境」。切换前会询问旧窗口处理方式（已关闭 / 不关闭直接继续），两者的后果都会写明；随后在目标场景完成 Safari 实测，成功后才显示为使用中。
- **订单页**：路由“受控”时才打开或定位订单页；已登录直接显示订单页，只有页面实际出现登录字段时才按设置填充，从不自动提交。
- **修改代理**：在网页或弹窗中编辑；保存后显示“已保存，正在同步”，发布与读回完成、Safari 实测通过后才显示新出口已生效。
- **普通模式**：任何时候都可以在弹窗或网页中「进入普通模式」，撤销本应用的入口，Safari 继续使用 Surge 原规则（可能直连）；不会把 SFE-ROUTE 改为 DIRECT。
- **警告**：路由卡片上的警告（例如接管关闭、外部修改、实测过期、入口未验证）出现时，自动打开订单与登录填充会暂停，按提示重新激活或重测。

## 5. 卸载与回退

顺序固定：

1. **先进入普通模式**（弹窗、网页或 `sfe normal`），确认入口读回为 NORMAL。
2. **移除受管理段**，二选一：
   - 在「发布与 Surge」页运行 `remerge` 预览，确认只移除本应用的受管理段与文件后提交（受维护写门槛约束，入口必须是 NORMAL）；或
   - 用初始化时的备份恢复：在 Surge 中手动切回备份对应的原配置（`backups/` 中的初始备份），不再使用「日常-Safari环境」。
3. **在 Surge 菜单「配置」中手动切回原配置**（工具从不切换）。确认增强模式、系统代理与出站模式与初始化预览中记录的一致。
4. **停止后台服务**：菜单「停止后台服务」（只注销 LaunchAgent，不改变入口或 SFE-ROUTE 选择）。
5. **删除本应用数据**：
   - 数据目录 `~/Library/Application Support/SafariProfileSurge`（数据库、日志、`backups/`、`tmp/`、`install.json`、`bridge.token`、P0 证据目录 `p0/`）；
   - App Group 容器 `~/Library/Group Containers/<Team ID>.sfe`（其中的 `bridge.json`、`bridge.token`）；
   - 钥匙串中服务名为 `com.sfe.proxy`、`com.sfe.account`、`com.sfe.system` 的条目（在「钥匙串访问」中按名称搜索 SafariProfileSurge 逐条删除）；
   - Surge 配置目录中本应用的文件：「日常-Safari环境.conf」、`sfe-nodes.list`、`sfe-entry-*.list`（只删这些；确认 Surge 已不使用该配置）；
   - `/Applications/SafariProfileSurge.app`。
6. **不做的事**：不批量删除证书、描述文件、你自己的 Surge 规则、模块、节点或临时规则；不删除 Safari 场景、Cookie 或登录资料。

## 6. 安全说明

**受保护的内容**：

- 账号密码只存在钥匙串（首选：登录钥匙串，条目只信任 sfe-keychain 与签名扩展）。服务从不返回账号密码，只给出一次性钥匙串引用，由签名的原生桥自己读取；没有原生桥签名身份的进程拿到引用也读不到。
- 代理凭据、账号密码、Surge http-api 密钥、会话令牌、登录码、传输令牌不进 SQLite、日志、命令行参数、事件流、HTTP 列表接口或 Git。
- 网页只监听 127.0.0.1，检查 Host 与 Origin，用一次性登录码换取会话令牌（不用 Cookie），会话 12 小时绝对、2 小时空闲过期。
- 数据目录 0700、文件 0600；数据目录在 Git 工作树、iCloud/云盘同步位置或文稿/桌面/下载时服务拒绝启动。

**同一用户的本机进程可以读取的内容**（信任边界是同一用户的本机进程）：

- `sfe-nodes.list`（Surge 语法要求明文代理凭据）、工作配置与原配置备份（含你自己节点的凭据、http-api 密钥、MITM 证书口令）、`<数据目录>/tmp` 下用后即删的 `--check` 候选副本。
- 原生桥传输令牌：同用户进程可读。能读到它的进程可以伪造原生桥消息，做 agent 能做的事，并能拿到明文登录账号与一次性钥匙串引用（但读不到账号密码）。
- `maintenance.sock`：能连接它的进程可以拿到网页登录码。`agent.sock` 是给导入工具的最小权限通道，不是对抗恶意同用户进程的安全边界。
- P0 原始证据目录（含合成测试凭据与 Surge 输出）。

因此请只在自己控制的账户中运行本工具，不要在共享账户或安装了不可信软件的 Mac 上使用。
