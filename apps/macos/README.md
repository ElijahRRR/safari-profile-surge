# macOS 原生部分（apps/macos）

宿主 App（菜单栏）、Safari Web Extension 原生桥、sfe-keychain 钥匙串小工具，以及让 LaunchAgent 启动本机服务的 sfe-service-launcher。实现规格见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §2、§7.2、§10。

本目录在 Linux 开发容器中写成，**没有编译过**。Swift 编译、签名、钥匙串、Safari 行为都只能在测试 Mac 上验证；离线测试通过不代表网络验收通过。代码中凡依赖测试 Mac 实测的地方都标有 `// P0:`。

## 组成

| 目标 | 产物 | 职责 |
|---|---|---|
| `SafariProfileSurge` | `SafariProfileSurge.app`（菜单栏，LSUIElement，不沙盒） | 打开管理后台、打开环境（受控入口）、服务状态、注册/停止后台服务、打开 Safari 扩展设置；启动时准备原生桥令牌与 `install.json` |
| `SafariProfileSurgeExtension` | `Contents/PlugIns/SafariProfileSurgeExtension.appex`（沙盒） | `SafariWebExtensionHandler`：读取 `SFExtensionProfileKey`，经回环 TCP 与服务做双向 HMAC 握手后转发（令牌不上线路，服务不能证明持有令牌时不发送请求内容），10 秒超时；登录填充时自己读取钥匙串中的密码 |
| `sfe-keychain` | `Contents/Helpers/sfe-keychain` | 服务调用的钥匙串工具：argv 只有 `--stdin-json`，stdin 一行 JSON，stdout 一行 JSON；账号密码只能写入与删除 |
| `sfe-service-launcher` | `Contents/Helpers/sfe-service-launcher` | LaunchAgent 的 BundleProgram：按自身位置找到打包的 `node` 与 `service.mjs` 后 `execv` |
| `SafariProfileSurgeTests` | XCTest | 纯 Swift 逻辑：信封校验、原生桥握手（与服务共用的已知答案、不持有令牌的假服务）、原生桥版本格式、NDJSON 帧、钥匙串状态映射、填充应答改写、sfe-keychain 策略、维护套接字协议、安装配置合并、0600 文件写入、App Group 容器读取失败分类（拒绝访问与找不到配置分开）、包内路径、后台服务设置页名称 |

App 包内布局：

```
SafariProfileSurge.app/Contents/
  MacOS/SafariProfileSurge
  Helpers/sfe-keychain
  Helpers/sfe-service-launcher
  Helpers/node                                                      ← 固定版本 Node（Mach-O，与 App 同团队重新签名）
  PlugIns/SafariProfileSurgeExtension.appex/Contents/Resources/   ← extension/dist 平铺复制（manifest.json 等）
  Resources/service/{service.mjs, sfe.mjs, web/}                    ← service/dist
  Library/LaunchAgents/com.sfe.service.plist
```

Node 是可执行代码，按 Apple「Placing content in a bundle」与其他辅助工具一样放在 `Contents/Helpers`（“help app, helper tool | macOS | `Contents/MacOS/`, `Contents/Helpers/`”；“Resources are everything that’s not code.”；放错位置 “may encounter hard-to-debug code signing and distribution problems”，https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle）。Apple 的 SMAppService 迁移指南举例用了 `Contents/Resources`（“such as in `Contents/Resources`”，https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos），两份文档不一致，这里按专门讲包内布局的那一份。构建后用 `codesign --verify --deep --strict /Applications/SafariProfileSurge.app` 检查（见下方 P0）。

## 前提

- macOS 14 或更高，Safari 17.6 或更高。`SFExtensionProfileKey` 自 macOS 14 / Safari 17 起提供；Safari 17.6 发行说明列出 “Fixed an issue where Safari Web Extension background pages would stop responding after about 30 seconds.”（https://developer.apple.com/documentation/safari-release-notes/safari-17_6-release-notes），扩展依赖非持久后台页与原生消息，所以 17.0–17.5 不支持。
- Xcode 16 或更高。
- XcodeGen：`brew install xcodegen`。
- 固定版本的 Node 二进制（22.13 或更高，服务依赖 `node:sqlite`）：从 nodejs.org 下载对应架构的 macOS 压缩包，解压到仓库之外的固定位置。构建只复制这个文件并用 `node --version` 核对版本，从不下载。
- 一个 Apple ID（免费即可）。

## 签名：免费 Apple ID（Personal Team）

1. Xcode → Settings → Accounts，添加 Apple ID，得到个人团队（Personal Team）。
2. 记下 Team ID（10 位字母数字；可在 Accounts 的团队详情或任一已签名 App 的 `codesign -dv` 输出中看到）。
3. 复制 `Local.xcconfig.example` 为 `Local.xcconfig`（已被 `.gitignore` 排除，不提交），填写：
   - `DEVELOPMENT_TEAM`：Team ID；
   - `SFE_NODE_BINARY`：Node 二进制的绝对路径；
   - `SFE_NODE_VERSION`：该二进制的版本号，例如 `22.13.1`。
4. 签名方式为自动签名（`Apple Development`）。App Group 为 `<Team ID>.sfe`。默认构建的扩展**不**声明 `keychain-access-groups`（受限权限，声明后扩展要靠描述文件授权）；只有备选钥匙串方案使用访问组 `<Team ID>.com.sfe.shared`，见「钥匙串方案」。

免费团队的描述文件 7 天过期（“Provisioning profiles that enable apps to be installed on a device will expire 7 days from issuance.”，https://developer.apple.com/help/account/basics/about-your-developer-account）。但 macOS 不要求描述文件才能运行第三方代码（TN3125：“Unlike Apple’s other platforms, macOS doesn’t require a provisioning profile to run third-party code.” “A Mac app that uses no restricted entitlements doesn’t need a provisioning profile.”，https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles）：默认的 `Config/App.entitlements` 与 `Config/Extension.entitlements` 只含无限制权限（App 沙盒、`application-groups`、`network.client`），构建可能根本不嵌入描述文件。Xcode 自动签名是否仍嵌入 `Contents/embedded.provisionprofile`、它的 `ExpirationDate`、7 天后是否有任何功能失效，由下方 P0 项 `extension_install_persistence` 实测；在此之前稳妥起见每 7 天内重新构建运行一次（保守做法，不是已证实的要求）。Personal Team 能否长期满足「正式产品需正常打包签名」尚未验证（ARCHITECTURE 冲突 2 与 §0.1 第 1 条）。备选钥匙串方案的 `keychain-access-groups` 是受限权限，一定要描述文件授权（TN3125），所以一定受 7 天有效期影响；打开备选方案后如果 Personal Team 不允许该权限导致签名失败，先记录现象。

## 生成与构建

顺序固定：

```sh
# 1. 仓库根目录：构建服务、网页与扩展
npm ci
npm run build          # 生成 service/dist（service.mjs、sfe.mjs、web/）与 extension/dist

# 2. 生成 Xcode 工程（SafariProfileSurge.xcodeproj 不提交）
cd apps/macos
xcodegen generate

# 3. 构建
open SafariProfileSurge.xcodeproj   # 选择 SafariProfileSurge 方案，Product → Run
# 或命令行：
xcodebuild -scheme SafariProfileSurge -configuration Debug build
xcodebuild -scheme SafariProfileSurge test     # 运行 XCTest
```

构建脚本（`Scripts/`）在缺少任何输入时让构建失败并说明原因：

- `embed-runtime.sh`：检查 `SFE_NODE_BINARY` 存在、版本等于 `SFE_NODE_VERSION`（且 ≥ 22.13），检查 `service/dist/service.mjs`、`sfe.mjs`、`web/`，把 Node 复制到 `Contents/Helpers/node`、`service/dist` 复制到 `Contents/Resources/service`（同时删除旧构建留在 `Contents/Resources/node` 的副本），并在 App 签名之前用 App 的签名身份重新签名 Node。
- `embed-extension-resources.sh`：检查扩展的 `CODE_SIGN_ENTITLEMENTS` 与 `SFE_DATA_PROTECTION_KEYCHAIN` 编译标志一致（见「钥匙串方案」），检查 `extension/dist/manifest.json` 等文件，平铺复制进 `.appex/Contents/Resources`（Safari 从扩展包的资源目录读取 `manifest.json`，不能多一层目录）。工程中把 `extension/dist` 作为名为 `Resources` 的文件夹引用显示，但实际复制由这个脚本完成。

## 首次运行

1. 把构建出的 `SafariProfileSurge.app` 放到 `/Applications`（或直接从 Xcode 运行）并打开。菜单栏出现网络图标。
2. App 每次启动都会（幂等地）：
   - 在 App Group 容器（`~/Library/Group Containers/<Team ID>.sfe/`）写入 `bridge.json`（`{"port":61848,"transport":"tcp"}`）与 `bridge.token`（32 字节随机数的 base64url，0600），已有且有效时沿用。macOS 上即使 App Group 无效 `containerURL` 也会返回 URL（“In macOS, a URL of the expected form is always returned, even if the app group is invalid, so be sure to test that you can access the underlying directory before attempting to use it.”，https://developer.apple.com/documentation/foundation/filemanager/containerurl(forsecurityapplicationgroupidentifier:)），所以写入前先打开容器目录、写入后按扩展的读取方式读回；目录不存在与系统拒绝访问分开提示，不自行创建容器目录；
   - 创建数据目录 `~/Library/Application Support/SafariProfileSurge`（0700），写入令牌副本 `bridge.token`（0600），服务从这里读取（每个连接重新检查，App 改写令牌后无需重启服务），从不访问 App Group 容器；
   - 合并写入 `install.json`（0600）：`surgeCliPath`（只有 `/Applications/Surge.app/Contents/Applications/surge-cli` 存在时）、`keychainHelperPath`（`Contents/Helpers/sfe-keychain`）、`nodeVersionPin`、`bridge`、`webRoot`（App 内的 `service/web`），以及首次创建时全部为 `unavailable` 的 `adapterMechanism`（之后由 P0 填写，App 从不覆盖）。
3. 菜单「注册后台服务」：以 `SMAppService.agent(plistName: "com.sfe.service.plist")` 注册。系统可能要求在「系统设置 → 通用 → 登录项与扩展」（macOS 14 为「登录项」）中允许；菜单会显示状态并提供「打开登录项与扩展设置」（macOS 14 为「打开登录项设置」，按运行中的系统版本显示）。服务不带演示参数，不含任何秘密。
   - macOS 26 或更高：后台服务运行中从菜单「退出」App 时，系统会询问是否允许后台任务继续运行（“On Mac computers with macOS 26 or later, if background tasks are started by an app and remain active after a user quits the app, the user is prompted to allow or not allow the background tasks to remain active.”，https://support.apple.com/guide/deployment/manage-login-items-background-tasks-mac-depdca572563/web）。选「允许」服务才会继续运行。选「不允许」后服务与 `SMAppService.status` 如何变化，Apple 没有写明，由 P0 `native_bridge_ipc` 记录（`sfltool dumpbtm` 查看）；菜单「退出」目前不额外提示（`App/SafariProfileSurgeApp.swift`）。服务停止时入口规则与 SFE-ROUTE 选择保持原样，见 docs/INSTALL.md §2 第 2 步。
4. 「停止后台服务」只注销 LaunchAgent，**不改变** Surge 中的入口规则或 SFE-ROUTE 选择；要撤销本应用的规则，先进入普通模式，再按 docs/INSTALL.md 移除受管理段。

## 启用扩展并授权 www.amazon.com

1. 打开 Safari → 设置 → 扩展（菜单「Safari 扩展设置」可直接打开），勾选 SafariProfileSurge。这个标签管理默认场景的扩展（https://support.apple.com/en-us/105100）。
2. 每个需要绑定的已命名场景都要单独启用扩展：Safari → 设置 →「描述文件」（Profiles）→ 选择场景 →「扩展」，勾选扩展。新场景默认关闭所有扩展（“By default, extensions are turned off for each new profile.”，同上），以后每新建一个场景都要做这一步；不能替用户在未来的场景中自动启用。
3. 在扩展的网站权限中，把 `www.amazon.com` 设为「允许」，**只需一次**：Safari 17 起网站授权对所有场景、无痕浏览和不使用场景的浏览都生效（“In Safari 17 and later, when you grant access to an extension for a specific web site, that grants the extension access to the site across all profiles, private browsing, and browsing without a profile.”，https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions），新建场景后不需要重新授权。扩展只申请这个站点与固定的检测服务主机（`api.ipify.org`、`api64.ipify.org`），不申请所有网站；检测主机是否也需要授权（Safari 18.4 起扩展页面的跨域请求受网站授权约束）由 P0 实测。
4. 环境只关联在已命名的场景中：默认场景可能拿不到 `SFExtensionProfileKey`（Apple 示例代码把没有这个键当作普通浏览，默认场景是否提供由 P0 `native_profile_id` 记录），这时弹窗显示「未识别当前场景」，只能查看状态。
5. 菜单顶部会提示「Safari 扩展未启用」或「原生桥无法连接」。宿主 App 读不到 App Group 容器时单独说明原因（系统拒绝访问、找不到配置）；扩展被系统拒绝访问容器时**不会弹出任何提示**（macOS 15：“This restriction also applies to app extensions, although in that case the system won’t prompt the user for consent but will instead just deny the access.”，https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes），只在扩展弹窗显示「无法连接本机服务：系统拒绝扩展访问 App Group 容器……」，而不是「找不到原生桥配置」。

**「允许未签名扩展」不是正常安装路径。** Safari 17 起它在 Safari 设置的「开发者」标签中（Safari 16 及更早在「开发」菜单中；“In Safari 17 or later, use the Developer tab in Settings”，https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension）。它在退出 Safari 时复位（“The “Allow unsigned extensions” setting for Safari resets when you quit Safari”），只用于开发调试；验收时必须关闭，扩展必须靠正常签名保持启用。如果只能依赖它，交付物视为不满足约束，需要明确告知。

## 菜单「打开环境」

选择一个已关联场景的环境即调用 `activate`（受控入口，新的 `request_id`）。服务返回 `NEEDS_CONFIRMATION` 时弹出确认：「已关闭，继续」或「不关闭，继续」，两项都写明后果、没有默认按钮，「取消」对应 Esc；选择后用同一个 `request_id` 重发。受理后显示引导「在 Safari 切换到场景 <名称>，点击扩展图标完成验证」，不称一键完成。

## 需要在测试 Mac 上确认（P0）

| 能力 | 检查什么 | 相关代码 |
|---|---|---|
| `native_bridge_ipc` | 扩展经原生桥与服务往返成功：Safari 退出重开、系统重启、服务重启与升级后仍成功；扩展后台脚本休眠后被唤醒仍能往返；沙盒扩展连接 `127.0.0.1:61848` 无系统提示；App Group 容器在宿主（未沙盒）与扩展（沙盒）之间共享（以扩展往返成功为准：扩展被拒绝时系统不提示，「没有提示」不能证明扩展可以访问）且宿主无「访问其他 App 数据」提示；`SMAppService` 注册后服务启动；临时监听该端口的进程只收到 hello（无令牌、场景 ID 或消息）；macOS 26 或更高时退出 App 的后台任务提示，以及选「允许」「不允许」后服务与 `SMAppService.status` 的变化 | `Shared/BridgeClient.swift`、`Shared/BridgeHandshake.swift`、`Shared/BridgeConfig.swift`、`ServiceLauncher/main.swift`、`App/ServiceAgent.swift` |
| `bridge_keychain_access` | `sfe-keychain` 写入的账号密码项（受信任应用列表 = sfe-keychain + 扩展）能被签名扩展读取且无提示；App 重新构建或重签后的提示次数；钥匙串锁定、用户拒绝时的错误分类 | `KeychainTool/SecItemBackend.swift`、`Shared/KeychainAccess.swift` |
| `extension_install_persistence` | 不开启「允许未签名扩展」，扩展在 Safari 退出重开、重启、8 天以上、重新构建后保持启用；记录证书有效期，以及 App 与 appex 是否嵌入 `Contents/embedded.provisionprofile`、嵌入时的 `ExpirationDate`；`extension/dist` 平铺复制后 Safari 能加载扩展 | `Scripts/embed-extension-resources.sh`、`App/HealthChecks.swift` |
| `native_profile_id` | 各已命名场景的 `SFExtensionProfileKey` 互不相同；默认场景（与无痕浏览）是否提供只记录，提供时也须与已命名场景不同；值的实际类型（Apple 示例代码按 `UUID` 转换，参考页没有写类型）；Safari 退出重开、扩展重装、App 重签后是否不变 | `Shared/BridgeProtocol.swift`（`profileIdentifier`）、`Extension/SafariWebExtensionHandler.swift` |

另需确认：

- `$(TeamIdentifierPrefix)sfe`（entitlements）与 `$(DEVELOPMENT_TEAM).sfe`（Info.plist 中的 `SFEAppGroupIdentifier`）展开为同一个值。
- `launchd` 确实不按 App 包解析 `ProgramArguments` 中的相对路径（因此使用 `sfe-service-launcher`）；`KeepAlive`（`SuccessfulExit = false`）只在异常退出时重启。
- 打包的 Node（`Contents/Helpers/node`）重新签名后能运行；开启 Hardened Runtime 时 `Config/node.entitlements`（JIT）足够；`codesign --verify --deep --strict /Applications/SafariProfileSurge.app` 通过，`Contents/Resources` 中没有 Mach-O 文件。
- 统一日志中扩展只出现消息类型与结果码：`log show --predicate 'subsystem == "com.sfe.SafariProfileSurge.Extension"' --last 1h` 不应出现消息内容、令牌、账号或密码。

验收结果写入 docs/ACCEPTANCE.md，未测项写「未验证」。

## 钥匙串方案

- **首选**：登录钥匙串（文件型）。`sfe-keychain` 用 `SecItemAdd` 写入 `kSecClassGenericPassword`，service 为 `com.sfe.proxy` / `com.sfe.account` / `com.sfe.system`，account 为引用；账号密码条目带 `SecAccess`，受信任应用只有 sfe-keychain 与扩展（路径按 sfe-keychain 在 App 包内的位置推算）。`get` 账号密码被拒绝（`reason: acl`），由扩展自己读取。同名引用已存在时不覆盖（`reason: other`）。
  - `SecAccessCreate`、`SecTrustedApplicationCreateFromPath` 自 macOS 10.10 标为过时（“SecKeychain is deprecated”，https://developer.apple.com/documentation/security/secaccesscreate(_:_:_:)），编译有警告；TN3137：“The file-based keychain is on the road to deprecation. It’s not officially deprecated, but some of the APIs surrounding it are.”（https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains）。在当前 macOS 上沙盒扩展能否按这份受信任应用列表免提示读取，Apple 没有写明，由 P0 `bridge_keychain_access` 确认。
  - `SecItemAdd` 默认写入什么分区列表、同团队的扩展能否通过，也待实测：security(1) 只说分区列表 “limits access to the item based on an application's code signature”，是限制而不是放行。
  - 不在受信任列表中的进程读取时，系统弹出授权提示（macOS 10.13.1 起要求输入钥匙串密码），用户选「允许」或「始终允许」后就能读到（“Otherwise, the system prompts the user for confirmation. The user may choose to Deny, Allow, or Always Allow the access.”，https://developer.apple.com/documentation/security/access-control-lists）。所以文档只能说“用户拒绝时读不到”，不能说“其他进程读不到”。
- **备选**：数据保护钥匙串 + 共享访问组 `<Team ID>.com.sfe.shared`。扩展读取路径已实现，打开时扩展目标的两项设置必须同时改：`SWIFT_ACTIVE_COMPILATION_CONDITIONS` 加 `SFE_DATA_PROTECTION_KEYCHAIN`，`CODE_SIGN_ENTITLEMENTS` 改为 `Config/Extension-DataProtection.entitlements`（只有这份声明 `keychain-access-groups`；两项不一致时 `embed-extension-resources.sh` 让构建失败）；写入方需要带描述文件与 `keychain-access-groups` 权限，裸命令行工具无法内嵌描述文件，因此要改由宿主 App 写入。只在 `extension_install_persistence` 证明免费描述文件不会失效时采用。
- 两者都不行时登录填充保持不可用，并在 INSTALL/ACCEPTANCE 中写明。

错误分类：`errSecAuthFailed`/`errSecUserCanceled` → `denied`（用户拒绝），`errSecInteractionNotAllowed` → `locked`（Apple 只定义为 “Interaction with the Security Server is not allowed.”：可能是钥匙串已锁，也可能是当前无法显示授权提示；各情形实际返回哪个码由 P0 `bridge_keychain_access` 记录；扩展弹窗显示为「钥匙串需要用户交互但当前不允许（可能已锁定，或无法显示授权提示）」），`errSecMissingEntitlement`/`errSecInvalidOwnerEdit` → `acl`（访问控制不匹配），`errSecItemNotFound` → `not_found`，其余 → `other`。

## 秘密与日志

- 传输令牌、代理凭据、账号密码从不进入日志、命令行参数、环境变量或错误信息。传输令牌也从不上线路：原生桥与服务只交换随机数与 HMAC 证明（docs/ARCHITECTURE.md §7.2）。扩展日志只有消息类型与结果码（Xcode 模板中打印消息的 `os_log` 已去掉）。
- sfe-keychain 从不写 stderr；只有 `get`（代理/系统）的应答含值。
- 管理后台登录地址只交给 `NSWorkspace.shared.open`，从不传给子进程或写入日志。
- 不提交 `Local.xcconfig`、生成的 `.xcodeproj`、证书或描述文件。

## 卸载

1. 先在插件或网页中进入普通模式（撤销本应用的入口）。
2. 菜单「停止后台服务」。
3. 删除 `SafariProfileSurge.app`；按需删除 `~/Library/Application Support/SafariProfileSurge`（含数据库、备份与令牌副本）与 `~/Library/Group Containers/<Team ID>.sfe`。
4. 在「钥匙串访问」中删除名称以「SafariProfileSurge」开头的项（服务为 `com.sfe.proxy`、`com.sfe.account`、`com.sfe.system`）。
5. 按 docs/INSTALL.md 移除 Surge 工作配置中的受管理段。
