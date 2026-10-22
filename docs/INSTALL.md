# 安装、首次运行、卸载与回退

日期：2026-10-22。适用：macOS 14 或更高、Safari 17.6 或更高（见 1.1）、Surge for Mac 6.10.0（构建 12500）或更高（Controller 协议 ≥ 22；不支持 6.5）。低于最低版本、读不到版本或运行中的版本与 `surge-cli --raw version` 不一致时，发布、激活与维护写入都被拒绝，只有进入普通模式可用。本文件只描述步骤；网络能力是否成立以 docs/P0-RUNBOOK.md 的实测与网页后台确认为准，未确认的能力对应的动作会被拒绝。

## 1. 构建

### 1.1 前提

| 项目 | 要求 |
|---|---|
| macOS | 14 或更高 |
| Safari | 17.6 或更高（在 Safari 菜单「关于 Safari」中查看）。`SFExtensionProfileKey` 自 Safari 17 起提供；Safari 17.6 发行说明列出 “Fixed an issue where Safari Web Extension background pages would stop responding after about 30 seconds.”，本应用依赖非持久后台页与原生消息，所以 17.0–17.5 不支持；扩展的 manifest 以 `strict_min_version` 声明最低 17.6（更早的 Safari 如何呈现，Apple 没有写明） |
| Xcode | 16 或更高 |
| XcodeGen | `brew install xcodegen` |
| Node | 22.13 或更高（仓库开发与构建）；另需一个固定版本的 Node 二进制随 App 打包（见 1.3） |
| Apple ID | 免费即可（Personal Team）；见 1.4 的限制 |

### 1.2 服务、网页与扩展

在仓库根目录：

```sh
npm ci
npm run build      # 生成 service/dist（service.mjs、sfe.mjs、web/）、extension/dist 与 extension/dist-harness（仅演示用，不打包）
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
- **描述文件与重签**：Personal Team 的描述文件 7 天过期（Apple：“Provisioning profiles that enable apps to be installed on a device will expire 7 days from issuance.”，https://developer.apple.com/help/account/basics/about-your-developer-account）。但 macOS 运行第三方代码不要求描述文件（TN3125：“Unlike Apple’s other platforms, macOS doesn’t require a provisioning profile to run third-party code.” “A Mac app that uses no restricted entitlements doesn’t need a provisioning profile.”，https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles）。默认构建的 App 与扩展只用无限制权限（App 沙盒、`application-groups`、`network.client`），可能根本不嵌入描述文件。Xcode 自动签名是否仍嵌入（`Contents/embedded.provisionprofile`）、它的 `ExpirationDate`、7 天后是否有任何功能失效（App 无法启动、扩展被停用、原生桥失败），Apple 没有写，由 P0 的 `extension_install_persistence` 实测记录。在此之前稳妥起见，每 7 天内在 Xcode 中重新构建运行一次（或重新 `xcodebuild` 并替换 App）——这是保守做法，不是已证实的要求。备选钥匙串方案需要 `keychain-access-groups`，它一定要描述文件授权（TN3125：“the `keychain-access-groups` entitlement must be authorized by a profile”），所以一定受 7 天有效期影响。
- **影响**：每次重新签名都可能改变钥匙串访问控制对“受信任应用”的识别，导致读取账号密码时再次弹出钥匙串授权提示；提示次数由 `bridge_keychain_access` 记录。场景 ID 在重签后是否变化由 `native_profile_id` 记录。
- **未决**：Personal Team 是否满足“正式产品需正常打包签名”尚未验证（ARCHITECTURE 冲突 2 与 §0.1 第 1 条：Apple 文档中在 App Store 之外分发扩展只有 Developer ID 签名加公证一条路，免费账号没有）。「允许未签名扩展」（Safari 17 起在 Safari →「设置」→「开发者」标签中；Safari 16 及更早在「开发」菜单中；Apple：“In Safari 17 or later, use the Developer tab in Settings”，https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension）不是正常安装路径，它在退出 Safari 时自动复位；如果只能依赖它，交付物视为不满足约束，会在验收报告中写明。

## 2. 安装

1. 把构建出的 `SafariProfileSurge.app` 放到 `/Applications` 并打开。菜单栏出现图标。App 每次启动都会幂等地：
   - 创建数据目录 `~/Library/Application Support/SafariProfileSurge`（0700），写入原生桥传输令牌副本 `bridge.token`（0600）；
   - 在 App Group 容器写入扩展使用的 `bridge.json` 与 `bridge.token`；
   - 合并写入 `install.json`（0600）：Surge CLI 路径（只在 `/Applications/Surge.app/Contents/Applications/surge-cli` 存在时）、钥匙串工具路径、Node 版本、桥接端口、网页目录，以及首次创建时全部为 `unavailable` 的 `adapterMechanism`（由 P0 填写，App 从不覆盖）。
2. 菜单「注册后台服务」：以 SMAppService 注册内置的 LaunchAgent。系统可能要求在「系统设置 → 通用 → 登录项与扩展」（macOS 14 为「登录项」）中允许。服务不带演示参数，不含任何秘密。
   - **macOS 26 或更高：退出 App 时的提示。** 后台服务运行中从菜单「退出」App 时，系统会询问是否允许后台任务继续运行（Apple：“On Mac computers with macOS 26 or later, if background tasks are started by an app and remain active after a user quits the app, the user is prompted to allow or not allow the background tasks to remain active.”，https://support.apple.com/guide/deployment/manage-login-items-background-tasks-mac-depdca572563/web）。请选「允许」：扩展、网页与对账都依赖这个服务。
   - 选「不允许」之后会怎样，Apple 没有写明（由 P0 `native_bridge_ipc` 实测记录）。如果服务因此停止：Surge 中本应用的入口规则与 SFE-ROUTE 选择保持原样（与「停止后台服务」相同），对账也随之停止；扩展弹窗显示「无法连接本机服务：后台服务未运行或未注册」，依赖服务的动作（包括进入普通模式）都无法发起。这时重新打开 App 查看后台服务状态，按提示在「登录项与扩展」中允许或重新「注册后台服务」。
   - 日常不需要退出 App。确实要停用本应用时，先进入普通模式，再用菜单「停止后台服务」，最后退出 App。
3. 在 Safari →「设置」→「扩展」中勾选 SafariProfileSurge（菜单「Safari 扩展设置」可直接打开）。这个标签管理的是默认场景的扩展；默认场景可能拿不到场景 ID，环境只关联在已命名的场景中（见 §3 第 7 步）。
4. **每一个**需要绑定的已命名场景都要单独启用扩展：Safari →「设置」→「描述文件」（Profiles）→ 选择该场景 →「扩展」，勾选扩展。新建的场景默认关闭所有扩展（Apple：“By default, extensions are turned off for each new profile.”，https://support.apple.com/en-us/105100），所以以后每新建一个场景都要做这一步。
   - **网站授权只需一次**：在扩展的网站权限中把 `www.amazon.com` 设为「允许」。Safari 17 起这次授权对所有场景、无痕浏览和不使用场景的浏览都生效（Apple：“In Safari 17 and later, when you grant access to an extension for a specific web site, that grants the extension access to the site across all profiles, private browsing, and browsing without a profile.”，https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions），新建场景后不需要重新授权。
   - 扩展只申请 `www.amazon.com` 与固定的检测服务主机 `api.ipify.org`、`api64.ipify.org`（准备页用它们检测实际出口）。Safari 18.4 起扩展页面的跨域请求受网站授权约束（“Fixed CORS for Web Extension pages to respect granted per-site permissions.”），这两个检测主机是否也需要你授权由 P0 实测确认；需要时同样只授权一次。
5. 菜单顶部会提示「Safari 扩展未启用」或「原生桥无法连接」；按提示处理。「原生桥无法连接」（扩展弹窗中为「无法连接本机服务」）的常见原因：后台服务没有注册，或没有在「登录项与扩展」中允许；macOS 26 起退出 App 时选了「不允许」（见第 2 步）。另一种原因是系统拒绝扩展访问 App Group 容器：这时系统**不会弹出任何提示**（macOS 15 发行说明：“in that case the system won’t prompt the user for consent but will instead just deny the access.”），弹窗写明「系统拒绝扩展访问 App Group 容器」，与「找不到原生桥配置」（App 还没有打开过）分开显示；检查 App 与扩展是否用同一 Team ID 签名，重新构建安装。

## 3. 首次运行

顺序固定，前一步没有完成不要做下一步。

1. **P0 实测**：按 docs/P0-RUNBOOK.md 在测试配置上完成实测（只用空白测试场景与本机测试代理），测完**手动**切回原配置、删除测试文件。
2. **原语映射**：把 P0 确认的映射写入 `install.json` 的 `adapterMechanism`（保持 0600），重启后台服务（菜单「停止后台服务」→「注册后台服务」）。`getVersion` 必须映射为 `cli`：服务用 `surge-cli --raw version` 与运行中的 Surge 交叉核对版本，没有映射时版本按读不到处理（依赖版本的动作被拒绝）。`matchRule` 也必须映射为 `cli`（`surge-cli --raw rule match …`，Mac 6.9.0+；HTTP API 没有对应接口）：两种入口策略的每一步与每次读回都用它确认 Surge 的实际规则求值（ruleset_resource 的见证、Safari 与 Chrome 探测），没有映射时激活被拒绝（`runtime_entry_modes` 的验证上下文包含它），进入普通模式只能按退路完成并标为“入口规则未能读回确认”。`getCurrentProfile` 必须映射为 `cli`（`surge-cli --raw status` 的 `profile-path`）：服务只按完整路径判断 Surge 是否在固定工作配置上，HTTP 不提供路径，映射为 `http` 时始终视为不在工作配置上（依赖它的动作被拒绝）。早先安装生成的 `install.json` 不会自动补上新原语（App 从不覆盖已有映射，缺少的键按 `unavailable` 处理）：升级后按 P0 重新确认并写入 `matchRule`。`updateExternalResource` 即使映射了也从不用于刷新本应用的本地文件（Surge 跳过本地资源）：节点发布依赖 Surge 自动重新读取 `sfe-nodes.list`，P0 的 policy_path_reread 未确认之前新节点保持“已保存，待部署”。
3. **确认能力**：菜单「打开管理后台」（或 `sfe open`），在「能力门槛」页逐条核对 P0 提交的提议（上下文、脱敏摘要、逐协议覆盖、进程路径、入口策略）并确认。确认新的进程路径或入口策略要求入口为 NORMAL。
4. **初始化工作配置**：在「发布与 Surge」页运行初始化向导：
   - 预览只读：备份当前活动配置、它引用的本地文件与可读的运行开关到数据目录 `backups/`（0700/0600）；检测远端托管头与远端来源、配置目录是否在 iCloud/同步位置（默认拒绝）、名称与文件冲突、http-api 绑定、自动重载与接管状态；构造候选并 `--check`。
   - 确认后写入新文件「日常-Safari环境.conf」与占位资源文件（目标文件必须不存在）。
   - **由你在 Surge 菜单「配置」中手动切换一次**到「日常-Safari环境」。此后日常不再切换配置；工具从不调用 switch-profile。
   - 选择 ruleset_resource 入口策略时，工作配置中的四条入口 RULE-SET 由初始化写入；之后改用其他策略需要 `remerge`。
5. **登记默认前置**：在「发布与 Surge」页（或 `sfe admin front add <Surge 中已有的固定节点名> --default`）登记一个你已有的固定代理节点作为默认前置。只接受用户代理节点，不接受组、DIRECT/REJECT 或 SFE- 节点。
6. **导入环境**：在「导入」页上传 CSV/XLSX/JSON（模板在页面中下载，或 `sfe import <文件>` 预览、`--commit` 提交）。秘密只经页面表单或标准输入传递，从不出现在命令行参数中。导入只保存期望数据；节点发布受发布门槛约束。
7. **关联场景**：在每个已启用扩展的**已命名** Safari 场景中打开扩展弹窗，按「关联已有环境」选择对应环境（或使用网页的关联向导）。不要按场景名自动猜测。默认场景可能拿不到场景 ID：Apple 的示例代码把没有场景 ID 当作普通浏览（`… else { // Perform normal browsing tasks. }`，https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension），默认场景是否提供由 P0 `native_profile_id` 记录。拿不到时弹窗显示「未识别当前场景」，只能查看状态，不能关联、切换或修改环境，也不能在这里进入普通模式（用网页后台或已命名场景的弹窗）；它的窗口仍计入激活时的旧窗口确认。这时请新建一个场景使用。

## 4. 日常使用

- **打开环境**：菜单「打开环境」→ 选择环境（受控入口），或在已绑定场景的扩展弹窗中「使用此环境」。切换前会询问旧窗口处理方式（已关闭 / 不关闭直接继续），两者的后果都会写明；随后在目标场景完成 Safari 实测，成功后才显示为使用中。
- **订单页**：路由“受控”时才打开或定位订单页；已登录直接显示订单页，只有页面实际出现登录字段时才按设置填充，从不自动提交。
- **修改代理**：在网页或弹窗中编辑；保存后显示“已保存，正在同步”，发布与读回完成、Safari 实测通过后才显示新出口已生效。
- **普通模式**：任何时候都可以在弹窗或网页中「进入普通模式」，撤销本应用的入口，Safari 继续使用 Surge 原规则（可能直连）；不会把 SFE-ROUTE 改为 DIRECT。
- **警告**：路由卡片上的警告（例如接管关闭、外部修改、实测过期、入口未验证）出现时，自动打开订单与登录填充会暂停，按提示重新激活或重测。
- **菜单栏 App**：后台服务独立于菜单栏 App 运行，日常不需要退出 App。macOS 26 起退出 App 会出现后台任务提示，选「允许」（见 §2 第 2 步）。
- **新建场景**：新场景默认关闭扩展，按 §2 第 4 步在该场景中启用；网站授权已对所有场景生效，不需要重新授权。

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

- 账号密码只存在钥匙串（首选：登录钥匙串，条目的受信任应用只有 sfe-keychain 与签名扩展）。服务从不返回账号密码，只给出一次性钥匙串引用，由签名的原生桥自己读取。其他进程拿到引用后读取该项时，系统会弹出钥匙串授权提示（需要输入钥匙串密码），只有你拒绝时才读不到；选「允许」或「始终允许」后它就能读到（Apple：“Otherwise, the system prompts the user for confirmation. The user may choose to Deny, Allow, or Always Allow the access.”，https://developer.apple.com/documentation/security/access-control-lists）。**看到不认识的程序请求访问 SafariProfileSurge 条目时，请拒绝**；只有请求方是本应用自己的扩展（App 重新构建或重签后可能再次请求，次数由 `bridge_keychain_access` 记录）时才允许。
- 代理凭据、账号密码、Surge http-api 密钥、会话令牌、登录码、传输令牌不进 SQLite、日志、命令行参数、事件流、HTTP 列表接口或 Git。
- 网页只监听 127.0.0.1，检查 Host 与 Origin，用一次性登录码换取会话令牌（不用 Cookie），会话 12 小时绝对、2 小时空闲过期。
- 数据目录 0700、文件 0600；数据目录在 Git 工作树、iCloud/云盘同步位置或文稿/桌面/下载时服务拒绝启动。

**同一用户的本机进程可以读取的内容**（信任边界是同一用户的本机进程）：

- `sfe-nodes.list`（Surge 语法要求明文代理凭据）、工作配置与原配置备份（含你自己节点的凭据、http-api 密钥、MITM 证书口令）、`<数据目录>/tmp` 下用后即删的 `--check` 候选副本。
- 原生桥传输令牌：同用户进程可读。能读到它的进程可以伪造原生桥消息，做 agent 能做的事，并能拿到明文登录账号与一次性钥匙串引用；用引用读取账号密码时会触发上面的钥匙串授权提示，你拒绝就读不到。
- `maintenance.sock`：能连接它的进程可以拿到网页登录码。`agent.sock` 是给导入工具的最小权限通道，不是对抗恶意同用户进程的安全边界。
- P0 原始证据目录（含合成测试凭据与 Surge 输出）。

因此请只在自己控制的账户中运行本工具，不要在共享账户或安装了不可信软件的 Mac 上使用。
