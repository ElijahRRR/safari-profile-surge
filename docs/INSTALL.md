# 安装、首次运行、卸载与回退

日期：2026-10-22。适用：macOS 14 或更高、Safari 17.6 或更高（见 1.1）、Surge for Mac 6.10.0（构建 12500）或更高（Controller 协议 ≥ 22；不支持 6.5）。低于最低版本、读不到版本或运行中的版本与 `surge-cli --raw version` 不一致时，发布、激活与维护写入都被拒绝，只有进入普通模式可用。本文件只描述步骤；网络能力是否成立以 docs/P0-RUNBOOK.md 的实测与网页后台确认为准，未确认的能力对应的动作会被拒绝。2026-10-31 起节点由本机回环资源服务提供（用户决定 D10，docs/ARCHITECTURE.md §0）。

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

- 签名方式为自动签名（Apple Development）。App Group 为 `<Team ID>.sfe`。本应用不使用钥匙串，App 与扩展都不声明钥匙串访问组（`keychain-access-groups`）。
- **描述文件与重签**：Personal Team 的描述文件 7 天过期（Apple：“Provisioning profiles that enable apps to be installed on a device will expire 7 days from issuance.”，https://developer.apple.com/help/account/basics/about-your-developer-account）。但 macOS 运行第三方代码不要求描述文件（TN3125：“Unlike Apple’s other platforms, macOS doesn’t require a provisioning profile to run third-party code.” “A Mac app that uses no restricted entitlements doesn’t need a provisioning profile.”，https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles）。App 与扩展只用无限制权限（App 沙盒设置、`application-groups`、`network.client`），可能根本不嵌入描述文件。Xcode 自动签名是否仍嵌入（`Contents/embedded.provisionprofile`）、它的 `ExpirationDate`、7 天后是否有任何功能失效（App 无法启动、扩展被停用、原生桥失败），Apple 没有写，由 P0 的 `extension_install_persistence` 实测记录。在此之前稳妥起见，每 7 天内在 Xcode 中重新构建运行一次（或重新 `xcodebuild` 并替换 App）——这是保守做法，不是已证实的要求。
- **影响**：本应用不使用钥匙串，重新签名不会引起钥匙串授权提示。场景 ID 在重签后是否变化由 `native_profile_id` 记录，扩展是否保持启用由 `extension_install_persistence` 记录。
- **未决**：Personal Team 是否满足“正式产品需正常打包签名”尚未验证（ARCHITECTURE 冲突 2 与 §0.1 第 1 条：Apple 文档中在 App Store 之外分发扩展只有 Developer ID 签名加公证一条路，免费账号没有）。「允许未签名扩展」（Safari 17 起在 Safari →「设置」→「开发者」标签中；Safari 16 及更早在「开发」菜单中；Apple：“In Safari 17 or later, use the Developer tab in Settings”，https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension）不是正常安装路径，它在退出 Safari 时自动复位；如果只能依赖它，交付物视为不满足约束，会在验收报告中写明。

## 2. 安装

1. 把构建出的 `SafariProfileSurge.app` 放到 `/Applications` 并打开。菜单栏出现图标。App 每次启动都会幂等地：
   - 创建数据目录 `~/Library/Application Support/SafariProfileSurge`（0700），写入原生桥传输令牌副本 `bridge.token`（0600）；
   - 在 App Group 容器写入扩展使用的 `bridge.json` 与 `bridge.token`；
   - 合并写入 `install.json`（0600）：Surge CLI 路径（只在 `/Applications/Surge.app/Contents/Applications/surge-cli` 存在时）、Node 版本、桥接端口、网页目录，以及首次创建时全部为 `unavailable` 的 `adapterMechanism`（由 P0 填写，App 从不覆盖）。`install.json` 不含任何秘密。本机资源服务的端口与读取令牌都不在 `install.json` 中：服务首次启动时在 20000–39999 中随机选一个空闲端口存入自己的数据库（之后不变，只有「重新合并」的「更换资源地址」会换），读取令牌是数据库中的系统秘密。合并从不删除字段：旧版本写入的钥匙串工具路径 `keychainHelperPath` 原样保留（本版本的服务读取时忽略它，不报错；装回旧版本时旧服务需要它，见 §7 第 1 步）。
2. 菜单「注册后台服务」：以 SMAppService 注册内置的 LaunchAgent。系统可能要求在「系统设置 → 通用 → 登录项与扩展」（macOS 14 为「登录项」）中允许。服务不带演示参数，不含任何秘密。
   - **macOS 26 或更高：退出 App 时的提示。** 后台服务运行中从菜单「退出」App 时，系统会询问是否允许后台任务继续运行（Apple：“On Mac computers with macOS 26 or later, if background tasks are started by an app and remain active after a user quits the app, the user is prompted to allow or not allow the background tasks to remain active.”，https://support.apple.com/guide/deployment/manage-login-items-background-tasks-mac-depdca572563/web）。请选「允许」：扩展、网页与对账都依赖这个服务。
   - 选「不允许」之后会怎样，Apple 没有写明（由 P0 `native_bridge_ipc` 实测记录）。如果服务因此停止：Surge 中本应用的入口规则与 SFE-ROUTE 选择保持原样（与「停止后台服务」相同），对账也随之停止；本机资源服务也随之停止，Surge 保留已下载的节点、已选中的节点继续工作，Surge 对节点资源的更新与定时刷新报告无法连接；这期间资源端口可能被其他程序（含 Mac 上的其他用户）占用并收到读取令牌。服务恢复后只能发现 Surge 状态中仍留着的痕迹（载入了不是本服务提供的列表，或本服务没有产生的资源错误，包括服务没有在监听期间的请求超时），不能阻止，也不保证每次占用都能发现：占用者离开后 Surge 的下一次下载得到“无法连接”，可能改写之前的错误。发现时网页显示「节点资源未确认」，需要按 §3 第 4 步「更换资源地址」；服务停止了较长时间之后，即使没有任何提示，也应把读取令牌当作可能已泄露，同样可以更换资源地址；扩展弹窗显示「无法连接本机服务：后台服务未运行或未注册」，依赖服务的动作（包括进入普通模式）都无法发起。这时重新打开 App 查看后台服务状态，按提示在「登录项与扩展」中允许或重新「注册后台服务」。
   - 日常不需要退出 App。确实要停用本应用时，先进入普通模式，再用菜单「停止后台服务」，最后退出 App。
3. 在 Safari →「设置」→「扩展」中勾选 SafariProfileSurge（菜单「Safari 扩展设置」可直接打开）。这个标签管理的是默认场景的扩展；默认场景可能拿不到场景 ID，环境只关联在已命名的场景中（见 §3 第 7 步）。
4. **每一个**需要绑定的已命名场景都要单独启用扩展：Safari →「设置」→「描述文件」（Profiles）→ 选择该场景 →「扩展」，勾选扩展。新建的场景默认关闭所有扩展（Apple：“By default, extensions are turned off for each new profile.”，https://support.apple.com/en-us/105100），所以以后每新建一个场景都要做这一步。
   - **网站授权只需一次**：在扩展的网站权限中把 `www.amazon.com` 设为「允许」。Safari 17 起这次授权对所有场景、无痕浏览和不使用场景的浏览都生效（Apple：“In Safari 17 and later, when you grant access to an extension for a specific web site, that grants the extension access to the site across all profiles, private browsing, and browsing without a profile.”，https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions），新建场景后不需要重新授权。
   - 扩展只申请 `www.amazon.com` 与固定的检测服务主机 `api.ipify.org`、`api64.ipify.org`（准备页用它们检测实际出口）。Safari 18.4 起扩展页面的跨域请求受网站授权约束（“Fixed CORS for Web Extension pages to respect granted per-site permissions.”），这两个检测主机是否也需要你授权由 P0 实测确认；需要时同样只授权一次。
5. 菜单顶部会提示「Safari 扩展未启用」或「原生桥无法连接」；按提示处理。「原生桥无法连接」（扩展弹窗中为「无法连接本机服务」）的常见原因：后台服务没有注册，或没有在「登录项与扩展」中允许；macOS 26 起退出 App 时选了「不允许」（见第 2 步）。另一种原因是系统拒绝扩展访问 App Group 容器：这时系统**不会弹出任何提示**（macOS 15 发行说明：“in that case the system won’t prompt the user for consent but will instead just deny the access.”），弹窗写明「系统拒绝扩展访问 App Group 容器」，与「找不到原生桥配置」（App 还没有打开过）分开显示；检查 App 与扩展是否用同一 Team ID 签名，重新构建安装。

## 3. 首次运行

顺序固定，前一步没有完成不要做下一步。

1. **P0 实测**：按 docs/P0-RUNBOOK.md 在测试配置上完成实测（只用空白测试场景与本机测试代理），测完**手动**切回原配置、删除测试文件。
2. **原语映射**：把 P0 确认的映射写入 `install.json` 的 `adapterMechanism`（保持 0600），重启后台服务（菜单「停止后台服务」→「注册后台服务」）。`getVersion` 必须映射为 `cli`：服务用 `surge-cli --raw version` 与运行中的 Surge 交叉核对版本，没有映射时版本按读不到处理（依赖版本的动作被拒绝）。`matchRule` 也必须映射为 `cli`（`surge-cli --raw rule match …`，Mac 6.9.0+；HTTP API 没有对应接口）：两种入口策略的每一步与每次读回都用它确认 Surge 的实际规则求值（ruleset_resource 的见证、Safari 与 Chrome 探测），没有映射时激活被拒绝（`runtime_entry_modes` 的验证上下文包含它），进入普通模式只能按退路完成并标为“入口规则未能读回确认”。`getCurrentProfile` 必须映射为 `cli`（`surge-cli --raw status` 的 `profile-path`）：服务只按完整路径判断 Surge 是否在固定工作配置上，HTTP 不提供路径，映射为 `http` 时始终视为不在工作配置上（依赖它的动作被拒绝）。早先安装生成的 `install.json` 不会自动补上新原语（App 从不覆盖已有映射，缺少的键按 `unavailable` 处理）：升级后按 P0 重新确认并写入 `matchRule`。`updateExternalResource` 是节点发布的唯一机制（用户决定 D10）：服务只对本应用的回环节点资源执行一次单 key 更新，从不 update all，也从不对本地入口规则集调用。它只能在 P0 记录的资源 key 是 32 位小写十六进制、不含读取令牌时映射为 `cli`，否则必须映射为 `http`（需要工作配置中只监听回环地址的 http-api），读取令牌不能出现在命令行参数中；不满足时新节点保持“已保存，待部署”。发布另需 P0 的 `loopback_resource_update`、`loopback_resource_auth`、`loopback_resource_restart`、`loopback_publish_crash`、`external_node_underlying_proxy`、`connection_continuity` 在网页确认，在此之前新节点保持“已保存，待部署”；前三项确认之前资源服务只向 Surge 提供不含任何买家节点的占位内容。
3. **确认能力**：菜单「打开管理后台」（或 `sfe open`），在「能力门槛」页逐条核对 P0 提交的提议（上下文、脱敏摘要、逐协议覆盖、进程路径、入口策略）并确认。确认新的进程路径或入口策略要求路由是空闲的普通模式，且没有正在切换出口、检测或进入普通模式的操作。
4. **初始化工作配置**：在「发布与 Surge」页运行初始化向导：
   - 预览只读：备份当前活动配置、它引用的本地文件与可读的运行开关到数据目录 `backups/`（0700/0600）；检测远端托管头与远端来源、配置目录是否在 iCloud/同步位置（默认拒绝）、名称与文件冲突、http-api 绑定、自动重载与接管状态；构造候选并 `--check`。
   - 初始化要求后台服务正在运行且本机资源服务已在它的端口上监听（否则提示「本机资源服务不可用」）。工作配置中的 SFE-ROUTE 写成 `policy-path=http://127.0.0.1:<资源端口>/<读取令牌>/sfe-nodes.list`：这一行含读取令牌，工作配置及其备份因此是敏感文件（§6）；预览中的地址显示为 `http://127.0.0.1:<端口>/***`。
   - 确认后写入新文件「日常-Safari环境.conf」（目标文件必须不存在；不再创建 `sfe-nodes.list`）。
   - **由你在 Surge 菜单「配置」中手动切换一次**到「日常-Safari环境」。切换后 Surge 应从本机资源服务下载节点列表（最初只有占位行 `SFE-EMPTY = reject`），预期 SFE-ROUTE 的成员为 REJECT 与 SFE-EMPTY；切换时是否下载、只含占位行的列表是否被接受，都由 P0 `loopback_resource_update` 记录（TODO(P0)，尚无实测）。如果成员只有 REJECT，或资源显示尚未就绪、无法解析，这不是安装错误：任何买家节点都不受影响，发布保持「已保存，待部署」，直到 P0 确认。此后日常不再切换配置；工具从不调用 switch-profile。
   - **D10 之前初始化的工作配置**（SFE-ROUTE 写的是 `policy-path=sfe-nodes.list`）：升级后发布会停下并提示「需要重新合并以改用本机资源服务」。在「发布与 Surge」页做一次「重新合并」（维护写入并重载同一配置，由你选择时间并确认）：回环资源前三项 P0 确认之前它保持原行不变；确认之后改为回环地址，重载后读回确认 Surge 已改用本机资源服务，再删除旧的 `sfe-nodes.list`（内容与本应用的记录一致时；读回没有确认时这次不删除，之后的「重新合并」再试，内容不一致时从不删除、由你按 §5 处理）。
   - 读取令牌可能已泄露时（服务发现资源端口曾被其他程序占用、Surge 载入了不是本服务提供的列表或出现了本服务没有产生的资源错误；网页显示「节点资源未确认」。服务长时间没有在监听之后，没有提示也可能已泄露，见 §2 第 2 步），只有「重新合并」中的「更换资源地址」能恢复：它生成新的读取令牌与端口、改写这一行并重载同一配置，旧令牌从此只得到 404。
   - 选择 ruleset_resource 入口策略时，工作配置中的四条入口 RULE-SET 由初始化写入；之后改用其他策略需要 `remerge`。
5. **登记默认前置**：在「发布与 Surge」页（或 `sfe admin front add <Surge 中已有的固定节点名> --default`）登记一个你已有的固定代理节点作为默认前置。只接受用户代理节点，不接受组、DIRECT/REJECT 或 SFE- 节点。
6. **导入环境**：在「导入」页上传 CSV/XLSX/JSON（模板在页面中下载，或 `sfe import <文件>` 预览、`--commit` 提交）。秘密只经页面表单或标准输入传递，从不出现在命令行参数中。导入的代理凭据与账号密码以明文保存在数据目录的 `sfe.sqlite` 中（不使用钥匙串，见 §6）；服务只解析导入文件、不保存原文件，原文件由你自己保管。导入只保存期望数据；节点发布受发布门槛约束。
7. **关联场景**：在每个已启用扩展的**已命名** Safari 场景中打开扩展弹窗，按「关联已有环境」选择对应环境（或使用网页的关联向导）。不要按场景名自动猜测。默认场景可能拿不到场景 ID：Apple 的示例代码把没有场景 ID 当作普通浏览（`… else { // Perform normal browsing tasks. }`，https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension），默认场景是否提供由 P0 `native_profile_id` 记录。拿不到时弹窗显示「未识别当前场景」，只能查看状态，不能关联、切换或修改环境，也不能在这里进入普通模式（用网页后台或已命名场景的弹窗）；它的窗口仍计入激活时的旧窗口确认。这时请新建一个场景使用。

## 4. 日常使用

- **打开环境**：菜单「打开环境」→ 选择环境（受控入口），或在已绑定场景的扩展弹窗中「使用此环境」。切换前会询问旧窗口处理方式（已关闭 / 不关闭直接继续），两者的后果都会写明；随后在目标场景完成 Safari 实测，成功后才显示为使用中。
- **订单页**：路由“受控”时才打开或定位订单页；已登录直接显示订单页，只有页面实际出现登录字段时才按设置填充，从不自动提交。
- **修改代理**：在网页或弹窗中编辑；保存后弹窗显示「已保存；是否已发布到 Surge 以「Surge 同步」一栏为准」，网页显示「修改已保存，正在处理；结果见状态列」。是否已发布以「Surge 同步」一栏（网页的部署状态）为准：回环资源四项（以及前置链路、连接连续性）在网页确认之前，或本机资源服务不满足发布前提时，新版本显示「已保存，待部署」；发布与读回完成、Safari 实测通过后才显示新出口已生效。已部署的节点是否继续工作取决于缺的是哪一项：只缺前置链路或连接连续性、资源服务照常提供时，已部署的节点照常使用；回环资源的记录过期或被重置时，资源服务停止提供已提交的节点（答复 503），读取令牌可疑时答复 404。Surge 持续运行期间保留它已下载的节点（2026-10-25 实测）；Surge 或 Mac 重启之后是否保留尚待 P0 `loopback_resource_restart` 实测。
- **普通模式**：任何时候都可以在弹窗或网页中「进入普通模式」，撤销本应用的入口，Safari 继续使用 Surge 原规则（可能直连）；不会把 SFE-ROUTE 改为 DIRECT。
- **警告**：路由卡片上的警告（例如接管关闭、外部修改、实测过期、入口未验证）出现时，自动打开订单与登录填充会暂停，按提示重新激活或重测。
- **菜单栏 App**：后台服务独立于菜单栏 App 运行，日常不需要退出 App。macOS 26 起退出 App 会出现后台任务提示，选「允许」（见 §2 第 2 步）。
- **新建场景**：新场景默认关闭扩展，按 §2 第 4 步在该场景中启用；网站授权已对所有场景生效，不需要重新授权。

## 5. 卸载与回退

顺序固定：

1. **先进入普通模式**（弹窗、网页或 `sfe normal`），确认入口读回为 NORMAL。
2. **受管理段不需要逐段移除**：受管理段（`# SFE-BEGIN` … `# SFE-END`）只存在于初始化新建的工作配置「日常-Safari环境.conf」中，初始化从不改动你的原配置（原配置、它引用的本地文件与运行开关另有副本在 `backups/` 中）。本应用**没有**「移除受管理段」的功能：「重新合并」（`remerge`）只补回或恢复受管理段与本应用文件，从不移除它们。所以卸载按第 3 步切回原配置、第 5 步删除工作配置与本应用文件即可。如果你想继续使用这份工作配置（例如保留之后在受管理段之外做的修改），需要自己用文本编辑器删除其中的两个受管理段（`# SFE-BEGIN group v1` 到 `# SFE-END group`、`# SFE-BEGIN entry v1` 到 `# SFE-END entry`，含边界注释行）：先在 Surge 中切到其他配置（例如原配置）再编辑，保存后再切回；工具不代你编辑，也不代你切换。
3. **在 Surge 菜单「配置」中手动切回原配置**（工具从不切换）。确认增强模式、系统代理与出站模式与初始化预览中记录的一致。
4. **停止后台服务**：菜单「停止后台服务」（只注销 LaunchAgent，不改变入口或 SFE-ROUTE 选择）。
5. **删除本应用数据**：
   - 数据目录 `~/Library/Application Support/SafariProfileSurge`（数据库 `sfe.sqlite` 及其 `-wal`/`-shm`——其中有明文保存的代理凭据、账号密码与本机资源服务的读取令牌——、日志、`backups/`、`tmp/`、`install.json`、`bridge.token`、P0 证据目录 `p0/`）。时间机器等备份或其他副本中的数据目录同样含有这些明文，按需一并删除；
   - App Group 容器 `~/Library/Group Containers/<Team ID>.sfe`（其中的 `bridge.json`、`bridge.token`）；
   - 本应用不使用钥匙串。只有曾经装过使用钥匙串的旧版本时，钥匙串中才会有服务名为 `com.sfe.proxy`、`com.sfe.account`、`com.sfe.system` 的旧条目，按 §7 第 7 步删除；
   - Surge 配置目录中本应用的文件：「日常-Safari环境.conf」（其中 SFE-ROUTE 的地址含读取令牌）、`sfe-entry-*.list`、旧版本留下的 `sfe-nodes.list`（D10 之前初始化、还没有经「重新合并」改用本机资源服务时才有；含明文代理凭据），以及它们的写入临时文件 `.<这些文件名>.sfe-tmp-<16 位十六进制>`（点开头，Finder 默认隐藏，用 `ls -a` 查看；服务正常运行时不会留下，只在写入时进程被强制终止、断电后遗留，可能含明文代理凭据，服务启动时会删除）（只删这些；确认 Surge 已不使用该配置）；
   - **Surge 自己的资源缓存**：Surge 下载本机资源服务的节点列表后会自己保存一份，其中有已部署代理的明文用户名与密码，本应用无法删除。它的位置与保存方式待测试 Mac 实测（TODO(P0)，P0-RUNBOOK 3.11 记录后补在这里）；切回原配置之后按记录的位置手动删除；
   - `/Applications/SafariProfileSurge.app`。
6. **不做的事**：不批量删除证书、描述文件、你自己的 Surge 规则、模块、节点或临时规则；不删除 Safari 场景、Cookie 或登录资料。

## 6. 安全说明

**受保护的内容**：

- **本应用不使用 macOS 钥匙串**（你的决定，2026-10-23）：任何组件都不读写钥匙串，不会出现钥匙串授权提示。代理凭据、亚马逊账号密码与内部密钥 pepper 由本机服务以**明文**保存在自己的资料中——数据目录的数据库 `sfe.sqlite`（`secret_values` 表，以及数据库旁边的 `-wal`/`-shm` 文件），只靠文件权限保护：数据目录 0700、文件 0600，只有你这个 macOS 用户能读。服务每次启动都会收紧它们的权限；数据目录、数据库或数据库旁边的文件是符号链接或不属于你时拒绝启动。
- 登录填充：只有在路由“受控”、请求来自绑定当前使用中环境的场景、页面是该站点的顶层登录页、表单目标同源 HTTPS、环境开启了填充、所需能力已通过时，服务才读出账号密码，经原生桥原样交给扩展；扩展只在内存中短暂持有、填入页面，从不保存，也从不自动提交。
- 代理凭据与账号密码只进数据库的 `secret_values` 表；它们与 Surge http-api 密钥、会话令牌、登录码、传输令牌都不进数据库的其他表（会话令牌与登录码只存哈希）、日志、命令行参数、事件流、HTTP 响应、命令行输出、错误信息、操作记录或 Git。
- 网页只监听 127.0.0.1，检查 Host 与 Origin，用一次性登录码换取会话令牌（不用 Cookie），会话 12 小时绝对、2 小时空闲过期。
- 本机资源服务（D10）另开一个只监听 127.0.0.1 的端口，只回答带正确读取令牌（256 位随机数，在请求路径中）的 `GET /<读取令牌>/sfe-nodes.list`；令牌错误、带浏览器请求头或其他方法的请求一律得到同样的 404，网页读不到它。买家节点只在回环资源前三项 P0 确认之后才会被提供。
- 数据目录 0700、文件 0600；数据目录在 Git 工作树、iCloud/云盘同步位置或文稿/桌面/下载时服务拒绝启动。

**同一用户的本机进程可以读取的内容**（信任边界是同一用户的本机进程）：

- **`<数据目录>/sfe.sqlite`（及 `-wal`/`-shm`）：全部代理凭据、亚马逊账号密码与 pepper 的明文。** 以你的用户身份运行的任何程序都能直接读取，不需要任何授权，也没有任何提示。数据目录的任何副本——时间机器等备份、迁移到新 Mac、手动复制或同步——同样包含这些明文；需要时把数据目录排除在备份之外，或只使用加密的备份磁盘。旧值什么时候从表中删除，取决于它是哪一种：
  - **账号密码**：修改、清除密码或删除环境后，旧值在下一次清理时（服务启动时与之后每小时）删除。
  - **代理用户名与密码**：旧值属于旧的代理版本，要等这个版本“退役”（retired）之后的下一次清理才删除。版本只在发布结算时退役，而且要满足：已经不在节点资源中，不再是该环境已部署、最近验证通过或使用中的版本，不在最近一次完整读回一致（verified）的发布中（发布读回不一致时要回滚到它），没有被选择，也没有进行中的操作引用它。所以修改之后要依次等到：新版本部署（发布停在“已保存，待部署”时什么都不退役）；旧版本曾经验证通过时，该环境用新版本验证通过；之后又一次发布（下一次有新版本要发布时）把旧节点移出资源——部署新版本的那次发布仍保留旧节点。删除环境后，它的代理版本在之后的发布把节点移出资源时退役；最近一次 verified 的发布仍含它时，要等之后又一次 verified 的发布。在此之前，旧值一直留在 `secret_values` 中，通常也仍在本机资源服务提供的节点列表与 Surge 自己的资源缓存中（D10 之前的安装是 `sfe-nodes.list`），没有期限。

  删除时：数据库开启了 SQLite 的 `secure_delete`（删除的内容在数据库页中用零覆盖），每删除一个值（清理与导入一次删除一批时，在这一批结束时）就把 `-wal` 写回数据库并截断为 0 字节，所以此后数据目录的副本中不再有这个旧值；数据库里也没有能用来离线核对猜测旧值的摘要（请求的幂等摘要不依赖密码，旧代理版本退役时清除它的指纹与含它的旧发布摘要；初始化与「重新合并」的操作记录不保存预览摘要，备份记录不含本应用生成文件的摘要；发布记录不保存工作配置的摘要（工作配置含你自己节点的凭据、http-api 密钥与 MITM 证书口令：你在 Surge 中改过的这些值不能用发布记录加 `backups/` 中的配置副本离线核对）；D10 之前的版本中，节点资源文件的归属记录只保留当前文件内容的摘要（发布回滚之后 Surge 读回失败、删除环境时也一样，服务启动时清除之前的版本留下的；升级到 D10 时迁移删除其余的，旧文件的记录在「重新合并」删除该文件后清除），D10 起本机资源服务的版本指针与下载记录只有代数、序号与时间；仍保存的指纹只对应数据库里本来就有明文的当前值；升级时迁移改写或删除之前记下的这些摘要）。有其他程序正在读取数据库（例如数据库浏览器或 `sqlite3` 中开着的读事务）时，服务不等待它：这次截断不做，推迟到之后的删除、下一次清理（服务启动时与之后每小时）或服务停止（没有其他程序打开数据库时）；其间服务重新启动（升级、菜单停止再启动、崩溃）也一样，启动时的清理总会截断一次，读取的程序还开着时之后每小时再试。在此之前 `-wal` 中仍可能有旧值；用完数据库浏览器请关闭它。初始化与「重新合并」的配置备份（`backups/`）不复制本应用生成的 `sfe-nodes.list` 与 `sfe-entry-*.list`（它们由数据库重新生成），所以旧的代理凭据不会因备份留在数据目录中；本版本之前做的「重新合并」备份（`backups/remerge-*`）可能含有当时的 `sfe-nodes.list`，按需删除这些目录中的 `sfe-nodes.list`（从使用钥匙串的旧版本升级时，改名保存的旧数据目录中同样可能有，按 §7 第 4 步删除）。删除之前做的备份或副本仍然含有它；文件系统层面的残留（APFS 快照、磁盘上尚未覆盖的旧数据块）本应用无法清除。
- **本机资源服务的读取令牌与它提供的节点列表**（用户决定 D10）：令牌在 `sfe.sqlite` 中，也写在工作配置 SFE-ROUTE 的地址里，所以工作配置及其备份、Surge 界面与日志中显示的资源地址都含有它；知道令牌并能连接 127.0.0.1 的任何程序（包括 Mac 上的其他用户）都能下载节点列表，其中是已部署代理的明文用户名与密码（Surge 语法要求明文）。资源服务没有在监听时，占用它端口的程序会收到 Surge 发出的令牌；能在本机回环接口抓包的用户（root 或有 BPF 权限）能看到令牌与列表。服务把令牌只当作对网页与其他用户的保护，不当作对同一用户进程的保护。
- **Surge 自己的资源缓存**（位置待实测，见 §5 第 5 步）：已部署代理的明文用户名与密码，本应用无法删除。
- 旧版本留下的 `sfe-nodes.list`（Surge 语法要求明文代理凭据；只在 D10 之前初始化、尚未「重新合并」时存在）、工作配置与原配置备份（含你自己节点的凭据、http-api 密钥、MITM 证书口令，以及读取令牌；不含本应用生成的 `sfe-nodes.list` 与 `sfe-entry-*.list`）、`<数据目录>/tmp` 下用后即删的 `--check` 候选副本（进程在 `--check` 期间被强制终止时遗留的副本在下次启动时删除）、Surge 配置目录中原子写入的临时文件 `.<文件名>.sfe-tmp-<16 位十六进制>`（写入后立即改名为正式文件；进程在写入与改名之间被强制终止、断电时遗留，`sfe-nodes.list` 的临时文件含当时全部已发布的明文代理凭据，工作配置的含你自己节点的凭据——下次启动、开始执行任何操作之前删除；之前做的备份或副本中仍可能有）。
- 原生桥传输令牌：同用户进程可读。能读到它的进程可以伪造原生桥消息，做 agent 能做的事，并能拿到明文登录账号；在路由“受控”、环境开启填充、所需能力已通过时，伪造的填充请求还能直接拿到明文账号密码（这与直接读取 `sfe.sqlite` 相比没有多暴露什么）。
- `maintenance.sock`：能连接它的进程可以拿到网页登录码。`agent.sock` 是给导入工具的最小权限通道，不是对抗恶意同用户进程的安全边界。
- P0 原始证据目录（含合成测试凭据与 Surge 输出）。

因此请只在自己控制的账户中运行本工具，不要在共享账户或安装了不可信软件的 Mac 上使用。

## 7. 从使用钥匙串的旧版本升级

旧版本把代理凭据、账号密码与 pepper 存在钥匙串里（服务名 `com.sfe.proxy`、`com.sfe.account`、`com.sfe.system`），数据库中只有引用。本版本不读取钥匙串，也不迁移旧值，所以旧版本创建的数据目录不能沿用：服务启动时发现数据库中有已提交的秘密引用却没有对应的值，或记录过 pepper 却找不到它，就拒绝启动（`SECRET_STORE_FAILED`，`details.reason = legacy_keychain_data`）。它不会读取钥匙串，也不会重新生成 pepper（重新生成会让全部旧指纹失效）。检查在数据库迁移之前进行，拒绝时数据库原样保留（仍是旧版本的结构）；新版本 App 启动时改写 `install.json` 中由 App 负责的字段，但保留旧版本的钥匙串工具路径 `keychainHelperPath`，所以装回旧版本仍能打开这个数据目录。表现为：后台服务启动即退出（launchd 大约每 30 秒重新启动一次，仍然失败），菜单栏与扩展弹窗显示无法连接本机服务；后台服务的标准错误输出被 launchd 丢弃，说明只写在数据目录的 `service.log` 中——其中有一条 `"msg":"secrets.legacy_keychain_data"`，`message` 字段是完整的中文说明（“启动失败：数据目录由使用钥匙串的旧版本创建……”），另有缺失数量，不含引用或值。查看：`grep legacy_keychain_data "$HOME/Library/Application Support/SafariProfileSurge/service.log"`。

处理方式是换用新的数据目录，重新初始化并重新导入。顺序固定：

1. **最好在升级之前**用旧版本进入普通模式（弹窗、网页或 `sfe normal`），确认入口读回为 NORMAL。已经升级时，新版本拒绝启动时没有改动数据库，新版本 App 也保留了旧服务需要的 `keychainHelperPath`，可以装回旧版本进入普通模式后再升级：把旧版本 App 放回 `/Applications` 的同一位置，**打开一次旧版本 App**（它把 `install.json` 中由 App 负责的字段——Node 版本等——写回旧版本的值；后台服务仍在失败重启时，最迟在下一次重启、约 30 秒后以旧版本运行），已经在新版本中「停止后台服务」时在旧版本菜单中「注册后台服务」；然后进入普通模式并确认读回为 NORMAL。旧服务进入普通模式需要钥匙串中的 pepper：如果仍报「读取钥匙串失败」，在旧版本菜单中「停止后台服务」再「注册后台服务」（后台服务只在启动时读取 `install.json`）。也可以跳过这一步，由第 2、3 步撤销旧版本在 Surge 中的入口。**然后先在旧版本的菜单中「停止后台服务」，再安装新版本 App**：替换 App 不会停止或重新启动已在运行的后台服务（App 启动时不重新注册它，launchd 只在它异常退出时重新启动它），旧服务会继续应答新版本的扩展。已经替换了 App 时，立即在菜单中「停止后台服务」（与第 4 步相同）。在此之前，旧服务仍应答新扩展的登录填充：只请求账号的页面（例如亚马逊登录的第一步只有邮箱或手机号）照常填入账号（页面照常显示「已填充账号」，看不出旧服务仍在运行）；页面请求密码时旧服务的密码项只有钥匙串引用、没有值，新扩展拒绝整份应答，登录页显示「本机服务的填充应答格式不符……」，这一页一个字段也不填。所以替换 App 之后，不要等看到这条提示才停止旧服务。
2. **在 Surge 菜单「配置」中手动切回原配置**（初始化时被复制成「日常-Safari环境」的那份源配置，本应用没有改动它；旧数据目录的 `backups/` 中也有初始备份）。工作配置中的受管理段（SFE-ROUTE 与 ruleset_resource 的四条入口 RULE-SET）从此不再生效。
3. 旧版本用 temp_rule 入口策略（或不确定）时，撤销它留下的临时规则，二选一：
   - 用 `/Applications/Surge.app/Contents/Applications/surge-cli --raw dump temp-rule` 列出临时规则。本应用添加的规则都含 Safari 的完整进程路径（`PROCESS-NAME,/…`），策略为 `REJECT` 或 `SFE-ROUTE`；对每一条运行 `/Applications/Surge.app/Contents/Applications/surge-cli rule temp remove '<规则原文>'`。不要用 `rule temp flush`，它会同时清掉你自己的临时规则。
   - 或者退出并重新打开 Surge 一次（文档：临时规则 “are discarded when Surge stops.”，https://manual.nssurge.com/tools/cli.html）。这会结束 Surge 当前的全部连接。
4. 菜单「停止后台服务」，再选菜单「退出」**退出 App**（App 只在启动时准备数据目录、`install.json` 与 `bridge.token`；不退出时第 6 步打开 App 只会切到已运行的 App，什么也不创建）。然后**把旧数据目录改名保存**，不要直接删除（其中有初始备份 `backups/`、P0 原始证据 `p0/`，以及 `install.json` 中 P0 确认的原语映射）：

   ```sh
   mv "$HOME/Library/Application Support/SafariProfileSurge" "$HOME/Library/Application Support/SafariProfileSurge.keychain-old"
   ```

   **改名之后立即删除其中的明文买家代理凭据。** 旧版本的秘密在钥匙串里，但旧数据目录中仍可能有明文代理凭据，而新版本从不在这个目录上启动，不会替你清除（§6 说的启动时清理只作用于新的数据目录）：旧版本的「重新合并」备份（`backups/remerge-*/`）复制过当时的 `sfe-nodes.list`，其中是全部已发布代理的明文用户名与密码；旧服务在 `--check` 期间被强制终止时，`tmp/` 下可能遗留候选副本（`tmp/candidate-*`，其中的 `sfe-nodes.list` 同样是明文）。只删除这两类，初始备份、`p0/` 与 `install.json` 保留（`sfe-entry-*.list` 只有规则、不含凭据）：

   ```sh
   OLD="$HOME/Library/Application Support/SafariProfileSurge.keychain-old"
   find "$OLD/backups" -name 'sfe-nodes.list' -type f -print -delete
   rm -rf "$OLD/tmp"
   ```

   删除之前做的备份或副本（时间机器等）中仍然有它们。

5. **删除 Surge 配置目录中旧版本的文件**：「日常-Safari环境.conf」、`sfe-nodes.list`、`sfe-entry-*.list`，以及它们遗留的写入临时文件 `.<这些文件名>.sfe-tmp-<16 位十六进制>`（点开头，用 `ls -a` 查看；可能含明文代理凭据）（只删这些；先确认 Surge 已不使用该配置）。新的初始化要求目标文件不存在，并把不在本应用记录中的 `SFE-` 对象当作名称冲突拒绝。
6. **重新开始**：重新打开 App（第 4 步已退出，这是一次新的启动，它会重新创建数据目录、`install.json` 与 `bridge.token`），确认新数据目录中已有这两个文件，把旧 `install.json` 中 P0 确认的 `adapterMechanism` 照抄到新文件（保持 0600），菜单「注册后台服务」，然后按 §3 从头完成首次运行：能力记录在旧数据库中，需要重新提议并在网页确认。已有的 P0 测量可以沿用，不必全部重测：P0 工具默认在新数据目录的 `p0/` 下找运行记录，第 4 步之后那里是空的（`propose` 会报「还没有运行记录」或「运行目录不存在」），所以给 `propose` 加上旧的证据目录，例如

   ```sh
   npx tsx tools/p0/src/cli.ts propose <能力> supported --run <运行编号> --raw-dir "$HOME/Library/Application Support/SafariProfileSurge.keychain-old/p0" --dry-run
   ```

   （省略 `--run` 时用该目录中最近一次运行；确认预览后去掉 `--dry-run` 发送；P0-RUNBOOK §5 的其他选项照旧；也可以把旧的 `p0/` 原样复制到新数据目录，保持 0700/0600）。`propose` 会重新测量当前上下文，与测量时不一致（例如 Surge、macOS 或 Safari 版本、原语映射、签名身份变了）就拒绝，这时按 P0-RUNBOOK 重测这一项。其余照 §3：初始化工作配置并在 Surge 中手动切换；登记默认前置；从你自己保管的原始资料重新导入代理与账号；重新关联场景。如果新数据目录中没有 `install.json` 时就注册了后台服务（表现为所有原语都显示不可用、扩展显示“原生桥认证失败”、网页打不开），在菜单中「退出」App 再重新打开它（它会补上 `install.json` 并用 App Group 中的令牌覆盖 `bridge.token`），照抄 `adapterMechanism` 后在菜单中「停止后台服务」再「注册后台服务」：后台服务只在启动时读取 `install.json`。
7. **删除旧的钥匙串项**（本版本从不读取或删除它们，留着也不会被使用）。在终端运行：

   ```sh
   for s in com.sfe.proxy com.sfe.account com.sfe.system; do
     while security delete-generic-password -s "$s" >/dev/null; do :; done
   done
   ```

   `security delete-generic-password` 每次只删除一个匹配的项，所以对每个服务名循环到找不到为止（每个服务名最后打印一次 “The specified item could not be found in the keychain.”，这是正常的）。系统可能为删除弹出钥匙串授权提示：这是你自己发起的删除，可以允许；拒绝时循环停止，该项保留。也可以在「钥匙串访问」中按名称搜索「SafariProfileSurge」逐条删除。检查是否还有剩余：`security find-generic-password -s com.sfe.account >/dev/null` 返回非零即没有（不要加 `-w`，它会打印密码）。
8. 确认新的数据目录工作正常后，按需删除改名保存的旧数据目录（以及备份中的副本）。第 4 步之后它仍有 `backups/` 中的配置副本（初始备份的原配置与「重新合并」备份的工作配置，含你自己节点的凭据、http-api 密钥与 MITM 证书口令）；第 4 步之前做的备份或副本中还可能有那一步删除的明文代理凭据。
