# 实现架构

日期：2026-10-21。性质：P1–P4 的实现规格（已经过一轮对照设计文档的对抗性审查并修订）。产品行为以三份 design 文档为准；本文件把它们落到具体模块、接口、数据表和事务顺序上。凡标注「能力门槛」的路径，在 P0 实测通过、证据经用户确认之前，代码会拒绝执行，而不是降级为重载、全局改代理、DIRECT 或其他买家出口。

## 0. 用户决定、冲突与待确认事项

| 项目 | 决定 | 影响 |
|---|---|---|
| 后台语言 | TypeScript + Node（版本固定，随 App 打包，见 §10） | 后台、网页、插件共用 `packages/contract`；Swift 只做宿主 App、原生桥、Keychain 小工具 |
| Amazon 站点 | 首版只支持美国站 `www.amazon.com` | 扩展只申请该站点权限；填充只认 `https://www.amazon.com` 顶层登录页 |
| 跨环境切换（与进入普通模式）时的旧窗口 | 提示手动关闭；也允许选择「不关闭，直接继续」 | 见下方冲突 1 |
| 签名 | 只有免费 Apple ID | 本机开发签名（Personal Team）；见下方冲突 2 |

**冲突 1（已按用户选择实现）**：「不关闭旧窗口」与设计「旧环境后台及长连接不能继续错用出口」冲突。切换事务仍结束属于 Safari 的旧连接，但旧环境窗口之后的新请求会经过新环境出口（整个 Safari 同一时刻共用一个出口）；进入普通模式时则会按 Surge 原规则发出（可能直连）。实现：只能在确认弹窗中逐次显式选择，不作为默认值；路由状态持续带 `old_windows_kept_open` 或 `managed_windows_on_original_rules` 警告，网页与插件都显示，永不显示为无警告的绿色。

**冲突 2（待用户确认）**：免费 Apple ID 的 Personal Team 签名是否满足 CLAUDE.md「正式产品需正常打包签名，临时扩展不是长期交付」尚未验证。待测：不开「允许未签名扩展」时扩展能否在 Safari 退出重开、重启、8 天以上、重新构建后保持启用；描述文件/证书有效期与重签频率；App Group 与钥匙串访问组在 Personal Team 下是否可用。对应能力 `extension_install_persistence`、`native_bridge_ipc`、`bridge_keychain_access`。如必须依赖「允许未签名扩展」，交付物视为不满足约束并明确告知，不作为正常安装路径。Apple 文档对这一点没有有利依据，见本节末「Apple 官方文档核对的架构风险」第 1 条。

**待用户决定的产品选项**：`first_request_and_old_connections` 实测不通过时，跨环境切换是否要求（还是仅建议）「保存工作后退出并重开 Safari」。在决定前只建议、不强制，并持续显示限制警告。

**最低系统**：macOS 14、Safari 17.6 或更高，以 P0 实测为准。`SFExtensionProfileKey` 自 macOS 14 / Safari 17 起提供；Safari 17.6 发行说明列出 “Fixed an issue where Safari Web Extension background pages would stop responding after about 30 seconds.”（https://developer.apple.com/documentation/safari-release-notes/safari-17_6-release-notes），本项目依赖非持久后台页与原生消息，所以 17.0–17.5 不支持（发行说明没有写明哪些版本有这个问题，按都有处理）；扩展 manifest 用 `browser_specific_settings.safari.strict_min_version: "17.6"` 声明最低版本（Apple：“Provide a specific version number in strict_min_version if you have a minimum Safari version requirement.”，https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari；低于它时 Safari 如何呈现，Apple 没有写明）。P0 能力上下文记录 Safari 版本，低于 17.6 的实测结果不作为验收依据：依赖 Safari 版本的能力，测量时或提议时的版本可解析且低于 17.6 时 P0 `propose` 拒绝；读不到或无法解析时不拒绝，服务也不按 Safari 版本拒绝提议，验收时按记录的版本人工核对。

**最低 Surge（用户决定，偏离 design 中以 6.5 为测试版本的表述）**：Surge Mac 6.10.0（构建 ≥ 12500、Controller 协议 ≥ 22），不兼容 6.5。运行中的版本 = 运行实例读取（证明磁盘上的包就是运行中的那一份）与 `surge-cli --raw version` 一致的值；两者不一致记 `cli_bundle_mismatch`，读不到记 `cli_version_unreadable`，低于最低版本或命令不被支持记 `surge_version_unsupported`。任一情形版本为 null：依赖版本的动作（发布、激活与切换、维护写入）拒绝，进入普通模式不依赖版本门槛（`service/src/engine/context.ts` 的 readVersion）；但低于 6.9 时 `rule match` 不可用，普通模式的读回因此受限，见下方「进入普通模式与 `rule match`」。

**节点发布机制（用户决定，偏离 design“按资源 key 定向更新/定向刷新”的表述）**：官方文档写明外部资源更新跳过本地资源（HTTP API：“Local resources are skipped.”），而 `sfe-nodes.list` 是本地 policy-path 文件，所以发布从不调用 `external-resource update`，也从不把它当作刷新：原子写入后在有限时间内（`resourceReloadWait`，缺省 10 秒、每 0.5 秒读一次）等待 Surge 自动重新读取该文件，再读回组成员、资源状态、选择与逐节点参数；等不到按读回不一致回滚。本地 policy-path 文件是否被监视没有写入文档：在 `policy_path_reread` 的 P0 记录确认之前，发布门槛不满足，新版本停在 WAITING_DEPLOYMENT，已部署的节点不受影响（与 design“CLI 跳过本地文件时保留为已保存、待部署”一致）。不实现回环地址的远端资源替代方案。`CAPABILITY_CRITERIA` 中 `targeted_resource_refresh`（标签改为「节点资源定向重新读取」）、`policy_path_reread`、`connection_continuity`、`auto_reload_atomic_replace`、`runtime_entry_modes` 的通过条件已按文件监视机制改写（不调用 update、限定时间内自动重新读取、不发生整份配置重载或引擎重启），P0 手册与验收模板逐字引用。`CAPABILITY_PRIMITIVES`（各能力依赖哪些原语、进入验证上下文的 adapterMechanism）只列产品实际调用的原语：`updateExternalResource` 不在任何一项中（从不调用）；`runtime_entry_modes` 含 `matchRule`（入口每一步与读回都用它），`auto_reload_atomic_replace` 含 `getAutoReloadSetting` 与 `matchRule`（规则集文件监视的读回），节点资源相关能力只含读回用的 `listExternalResources`、`getGroupMembers`（与 `getGroupSelection`），`connection_continuity` 为 `selectGroupPolicy` 与 `getGroupMembers`。install.json 中这些原语的映射变化让相应记录过期，门槛在写入之前拒绝。

**入口规则（偏离实时同步设计 §7「VERIFY_ONLY 的规则顺序概念」）**：temp_rule 不再用按先后生效的四条规则。文档只写了“rule temp add <rule> Add a temporary rule with the highest priority”，多条临时规则之间的先后没有写入文档；按先后设计时，新规则排在最前就无法不经放行到达 ACTIVE（新加的 active 排在 udp 之前，Safari 的 UDP 经 SFE-ROUTE）。现在用五种条件互不相交的临时规则（§5.5），每种模式只取决于存在哪些规则；design 要求的效果（检测域名经 SFE-ROUTE、Safari 其余流量拒绝、UDP/QUIC 拒绝）不变。**需要指出的冲突（没有削弱标准）**：“每一步之后的模式都与先后无关”对拒绝↔路由的翻转不可能成立——同一类 Safari 流量从拒绝变为路由（BLOCKED→VERIFY_ONLY 的检测主机、VERIFY_ONLY→ACTIVE 的其他主机），单条增删要么先加（两条相交、策略不同的规则同时存在，结果取决于先后），要么先删（这类流量落到原规则，即放行窗口）。实现选前者，并保证这一步之后不论先后都只是允许的模式（起点、终点、BLOCKED 或 VERIFY_ONLY），四种模式本身与先后无关（穷举测试，§5.5）。ruleset_resource 的入口规则集文件改由文档写明的本地文件监视生效，从不调用 `external-resource update`（同上，本地资源被跳过）；每次写入带见证规则，用 `rule match` 确认 Surge 已加载这一版。

**本地文件的重新读取与 P0 测量（偏离 design“按资源 key 定向更新”、“定向刷新新增节点”与固定工作配置设计 §3 的实测表）**：design 把 `external-resource update <key>` 当作发布与入口规则集的生效方式；6.10 文档写明它跳过本地资源，本项目的资源都是本地文件，所以 update 从不作为刷新机制，P0 也从不据它判断文件已被读取。生效依赖 Surge 对本地文件的自动重新读取：本地 RULE-SET 有文档（“Local files are watched and reloaded automatically when they change.”）；本地 policy-path 没有文档（TODO(P0)）。P0 `refresh` 因此改为测量：原子替换规则集 canary 后用 `rule match` 有界轮询测得文件监视的延迟，原子替换节点资源后不调用 update、轮询组成员测得是否与何时被重新读取，时限内没有读取时只调用一次 update 记录 Surge 报告什么（应为跳过）；两者都检查没有整份配置重载（配置 canary）、没有引擎或 Surge 重启（引擎运行时长、进程启动时间、临时规则）、其他资源与其他应用连接不受影响。原来用作“未重载信号”的规则集 canary 在 6.10 会被文件监视读取，不再能证明重载；改为测试配置（主配置）中的一行“配置 canary”——主配置只在重载时被读取（自动重载开启时替换主配置本身会触发重载，此时配置 canary 不可用，相关检查记为不完整，产品只能在测得的自动重载设置下使用）。`chain`、`charset` 同样不调用 update，等待自动重新读取，等不到时结论为不完整或未测试，从不用重载补救。

**reload 语义（6.9.0 起，影响维护流程与 P0 的 same_profile_reload_impact）**：design 引用的“主配置 reload 不等于更新外置策略”与 6.5 的整份重载已不适用。6.10 内置帮助：“Reload the main profile and apply only the changed sections. Unaffected connections, caches and temporary rules are preserved. Automatically performs a full engine restart if a change requires one.”；`restart-engine` “All connections are closed, and all caches and temporary rules are cleared.”。文档没有写明哪些改动会触发完整重启，所以维护重载的预览写明这一风险，重载后按引擎运行时长回落报告是否升级为完整重启；P0 `continuity --reload-test` 把引擎运行时长回落记为这次重载的影响（全部连接关闭、临时规则清空），Surge 进程本身重启（退出重开）仍不算同一配置重载。6.5 上测得的 same_profile_reload_impact 不沿用（记录按版本与构建过期）。

**临时规则命令（偏离固定工作配置设计 §3“`rule temp` 不能直接用于本机 6.5”）**：那是 6.5 时的结论。6.10 文档写明 `rule temp add <rule>`（“Add a temporary rule with the highest priority”）与 `rule temp remove <rule>`（“Remove one temporary rule by its exact text”），Mac 6.9.0+、协议 ≥20；随包技能写明它们对应控制器命令 `add-temp-rule` / `del-temp-rule`，列表仍是 `dump temp-rule`。本项目按文档使用这两条，`rule temp flush` / `flush-temp-rule` / `set-policy` 不在允许清单中。多条临时规则之间的先后没有写入文档：P0 `entry` 的插入探测实测并记录，temp_rule 的五种入口规则互不相交（上一条），每个模式读回后另以 `rule match` 矩阵核对 Safari 的 TCP、UDP、QUIC（文档：“`PROTOCOL,UDP` also matches QUIC and STUN connections.”）与 Chrome 从不命中。

**进入普通模式与 `rule match`（需要指出的冲突；激活标准没有削弱）**：用户决定 1 要求低于最低版本或读不到版本时进入普通模式永远可用；而按 6.10 文档，两种入口策略的每一步与每次读回都用 `rule match`（Mac 6.9.0+、协议 ≥20，随包技能：“An older core answers `Unknown command`”）确认运行时求值。Surge 降级到 6.9 以下，或早先生成的 `install.json` 没有 `matchRule` 映射（App 从不补写已有映射，缺少的键按 `unavailable`），rule match 都不可用。处理：temp_rule——降级必须退出重开 Surge，临时规则“are discarded when Surge stops”，普通模式按 `--raw dump temp-rule` 与 `--raw dump rule`（6.5 与 6.10 的控制器命令清单都有）按事实确认、不需要写入（中间阻断从 NORMAL 出发时不写入，仍结束 Safari 连接，§6.5）；rule match 读不到时撤销入口（普通模式、回滚）按临时规则列表与有效规则顺序读回（即 6.10 之前的结构读回），刚加入的 REJECT 类规则从不因探测失败或不一致被移除，结果标为未经运行时确认。ruleset_resource——入口文件在重启后照样生效，撤销入口只能走退路：照常按从不放宽的顺序逐位写入（同样的自动重载、资源与比较并替换检查），每步写入后等满文件监视上限（`watch.timeoutMs`，TODO(P0) 按实测设定）并核对四条 RULE-SET 的顺序，结果标为未经运行时确认，路由状态带 `entry_unverified`（“入口规则未能读回确认”），操作步骤写明。**冲突**：等待不是证明——文件监视比上限慢时，后一步可能先于前一步被加载，中间可能短暂出现计划之外的组合；“进入普通模式永远可用”与“切换无放行窗口、须读回证明”在 rule match 不可用时无法同时满足，按用户决定 1 选择前者并如实标注。激活方向（VERIFY_ONLY/ACTIVE）从不使用退路，rule match 读不到即失败即关闭；超时等结果未知的读取失败也不走退路。

**最低 Surge 与 P0**：P0 与服务用同一规则核对版本：`inventory` 记录运行实例与 `surge-cli --raw version` 的交叉核对（`inventory/surge-version.json`），每次能力上下文测量都重新核对，未通过时上下文中的版本为 null，`propose` 拒绝依赖版本的能力；`instance` 读到低于 6.10.0（12500）的版本时退出 3。design 中“本机 6.5 实测”的表格与结论（固定工作配置设计 §3）只作历史记录，不作为 6.10 的证据。

### 0.1 Apple 官方文档核对的架构风险

2026-10-22 对照 Apple 官方文档逐条核对。引文均为原文；Apple 没有写明的行为一律由测试 Mac 实测决定，实测之前按失败处理（相关门槛保持关闭），不据推断放行。按影响从大到小排列。

1. **签名：Personal Team 能否作为正式交付（冲突 2）。**
   - Apple 写了什么：在 App Store 之外分发扩展的途径是 Developer ID 签名加公证（“you can sign and notarize your extension's app with a Developer ID to distribute it outside the Mac App Store”，https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension；Safari 18.4：“Added support for loading Safari Web Extensions that have been Developer ID-signed and notarized.”，https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes）。免费账号：“No cost is associated with this agreement and developers can't distribute apps.”（https://developer.apple.com/help/account/reference/supported-capabilities-macos），也没有 Mac 软件公证（https://developer.apple.com/support/compare-memberships/）；Developer ID 证书 “Required role: Account Holder.”（https://developer.apple.com/support/developer-id/）。没有任何 Apple 页面说 Safari 会长期接受 Personal Team 签名的扩展。
   - 描述文件：“Unlike Apple’s other platforms, macOS doesn’t require a provisioning profile to run third-party code.” “A Mac app that uses no restricted entitlements doesn’t need a provisioning profile.”（TN3125，https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles）。默认构建只用无限制权限（App 沙盒、`application-groups`、`network.client`），可能根本不依赖 7 天过期的描述文件；备选钥匙串方案的 `keychain-access-groups` 一定要描述文件授权，免费描述文件 “will expire 7 days from issuance”（https://developer.apple.com/help/account/basics/about-your-developer-account）。
   - 由谁决定：`extension_install_persistence`（「允许未签名扩展」关闭；Safari 退出重开、重启、8 天以上、重新构建；App 与扩展是否嵌入描述文件及其有效期）。不通过时没有技术退路：「允许未签名扩展」在退出 Safari 时复位（“The “Allow unsigned extensions” setting for Safari resets when you quit Safari”），临时扩展 “Safari removes temporary extensions after 24 hours or when you quit Safari.”（https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension），两者都不是交付方式；只能由用户决定是否加入付费计划，改用 Developer ID 签名并公证（Safari 18.4 起）。

2. **原生桥依赖 App Group 容器。**
   - Apple 写了什么：macOS 15 起群组容器受保护，标识带 Team ID 前缀即可，但 “This restriction also applies to app extensions, although in that case the system won't prompt the user for consent but will instead just deny the access.”（https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes）。另一页多了公证条件：“Your app is distributed through the Mac App Store, or notarized.”（https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox），免费账号无法满足。两页说法不一。`containerURL` 也不能证明可访问：“In macOS, a URL of the expected form is always returned, even if the app group is invalid”（https://developer.apple.com/documentation/foundation/filemanager/containerurl(forsecurityapplicationgroupidentifier:)）。
   - 由谁决定：`native_bridge_ipc`，以往返成功为准；对扩展来说“没有弹窗”不能证明容器可访问。被拒绝时候选 B（容器内套接字）与候选 C（带群组前缀的 Mach 服务名）依赖同一个群组，换传输解决不了；先记录测量结果再重新设计，不回退到无令牌传输或数据目录之外的路径。

3. **登录填充依赖已过时的钥匙串接口。**
   - Apple 写了什么：`SecAccessCreate`、`SecTrustedApplicationCreateFromPath` 自 macOS 10.10 标为过时（“SecKeychain is deprecated”，https://developer.apple.com/documentation/security/secaccesscreate(_:_:_:)）；“The file-based keychain is on the road to deprecation. It’s not officially deprecated, but some of the APIs surrounding it are.”（TN3137，https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains）。不在受信任列表中的调用方会触发授权提示而不是直接拒绝：“Otherwise, the system prompts the user for confirmation. The user may choose to Deny, Allow, or Always Allow the access.”（https://developer.apple.com/documentation/security/access-control-lists）。分区列表 “limits access to the item based on an application's code signature”（security(1)）。沙盒 appex 能否按受信任应用列表免提示读取、重签后提示几次、`SecItemAdd` 默认写入的分区列表，Apple 都没有写。
   - 由谁决定：`bridge_keychain_access`。备选方案需要 `keychain-access-groups`（受限权限，描述文件 7 天），裸命令行工具无法内嵌描述文件，只能由宿主 App 写入。两者都不行时登录填充保持不可用。安全说明已改为“其他进程读取时系统弹窗，用户拒绝才读不到”（§2、INSTALL §6）。

4. **默认场景可能拿不到场景 ID。**
   - Apple 写了什么：示例代码把没有这个键当作普通浏览（`if let profileIdentifier = userInfo[SFExtensionProfileKey] as? UUID { // Perform profile specific tasks. } else { // Perform normal browsing tasks. }`，https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension）；WWDC23：“If your extension is active in a profile, there will be a profileIdentifier value for the key SFExtensionProfileKey.”（https://developer.apple.com/videos/play/wwdc2023/10119/）；默认场景的扩展在主「扩展」标签管理，其他场景在「描述文件」（Profiles）标签各自的「扩展」中管理（https://support.apple.com/en-us/105100）。默认场景与无痕浏览有没有这个键、场景 ID 跨重启与重签是否稳定，Apple 没有写。
   - 处理与由谁决定：没有这个键时服务按未识别场景处理（只允许 `getCurrentState` 与 `reportProfileState`），环境只能关联在已命名的场景中。未识别场景的窗口上报计入旧窗口确认（`other_profiles_open`，列为「未识别场景（可能是默认场景）」）：方案 1 要求未配置场景打开时也做冲突处理，默认场景最常见，不能因为拿不到 ID 就不计入。所有未识别场景共用一条上报记录（键 `~unidentified`，不是合法的场景 ID），服务无法区分它们，按失败即关闭合并：有效期（10 分钟）内任一未识别场景上报过有窗口即计入，之后没有窗口的上报不覆盖它；代价是默认场景关闭全部窗口之后，最长到它上一次有窗口的上报过期前，激活仍要求一次旧窗口确认。仍未覆盖：没有启用本扩展、或后台没有送达上报的场景（与已命名场景相同，确认对话框写明只包含已启用扩展并上报过的场景；后台卸载后的上报由 `native_bridge_ipc` 的闹钟唤醒实测）；未识别场景发起普通模式（不受理，弹窗指向网页后台或已命名场景）。`native_profile_id` 的通过条件只要求已命名场景的 ID 互不相同且稳定（或变化已记录），默认场景只记录（有 ID 时也必须与已命名场景不同），以免默认场景没有 ID 时无谓地关闭依赖它的门槛（`fillAndAutoOpen`）。

5. **进程归属与后台安全改进（BSI）。**
   - Apple 写了什么：“After Safari has been relaunched, it uses the framework and library content from the new cryptexes. The rest of the operating system remains unaffected and doesn't make use of the new content until the system restarts.”（https://support.apple.com/guide/security/background-security-improvements-sec87fc038c2/web）；“on a Mac, applied content appears on the Preboot volume (through symbolic links in /System/Cryptexes/ )”（https://support.apple.com/guide/deployment/background-security-improvements-dep93ff7ea78/web）。Apple 的设备管理文档把补充构建号与基础构建号分开记录（`SupplementalBuildVersion`，https://developer.apple.com/documentation/devicemanagement/statusdeviceoperatingsystemsupplementalbuildversion），所以 BSI 之后 `sw_vers` 的构建号可能不变。Surge 按哪个进程路径归属 Safari 与 WebKit 的连接，Apple 文档完全没有涉及。
   - 风险：BSI 装上后、系统重启前，只有 Safari 使用新 WebKit，测到的路径看起来像“Safari 专属”，重启后却被所有 WebKit 应用共用；只按 `macosBuild` 记录的能力不会因此过期（已加入补充版本与待重启状态，见下一条）。
   - 由谁决定：`safari_process_attribution`。所需测量：在没有待重启的 BSI 时测归属（BSI 装上后、重启前测得的路径不作为证据）；每次 BSI 后与系统重启后重新测，记录 `sw_vers` 的完整输出与 Surge 记录的进程路径（同一文件可能以 `/Applications`、`/System/Cryptexes` 或 `/System/Volumes/Preboot/Cryptexes` 下的不同路径出现）。能力上下文含 BSI 补充版本 `macosVersionExtra`（`sw_vers -productVersionExtra`，空输出记为 `none`；设备管理文档的补充版本示例为 `a`，https://developer.apple.com/documentation/devicemanagement/statusdeviceoperatingsystemsupplementalextraversion）与待重启状态 `macosRestartPending`（暂存位置 `/System/Volumes/Preboot/Cryptexes/Incoming` 是否存在；Apple 只写到 “applying the Incoming Cryptex”，没有写路径，这是测试 Mac 上的观察，TODO(P0) 按 P0-RUNBOOK §1.6 核对）。`safari_process_attribution`、`safari_udp_quic_handling`、`first_request_and_old_connections` 依赖这两个字段：待重启或无法确认时一律待验证（激活前与对账按当前值判定，失败即关闭；网页说明需要重启 Mac），补充版本变化即过期；P0 的 attribution 在待重启时记为不完整，提议被拒绝。暂存位置不存在不能证明没有待重启的 BSI（核对之前测试者仍按上述条件人工核对）；`sw_vers -productVersionExtra` 在安装时还是重启后变化也未写明。通用 WebKit 路径从不当作 Safari 专属（`GENERIC_WEBKIT_PREFIXES`；暂存位置与 App 子路径 Apple 没有写明，实测前不据推断改动该列表）。

6. **随系统版本变化的行为（文档提示与 P0 记录）。**
   - Safari 17.6 才修复后台页约 30 秒后停止响应，最低版本因此为 Safari 17.6（上方「最低系统」）。
   - Safari 18.4：“Fixed CORS for Web Extension pages to respect granted per-site permissions.”（https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes）；准备页请求检测服务 `api.ipify.org`、`api64.ipify.org` 是否需要用户另外授权，由 P0 实测。
   - 网站授权自 Safari 17 起在所有场景共用（“In Safari 17 and later, when you grant access to an extension for a specific web site, that grants the extension access to the site across all profiles, private browsing, and browsing without a profile.”，https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions），扩展的开关仍按场景分开（“By default, extensions are turned off for each new profile.”，https://support.apple.com/en-us/105100）。
   - macOS 26 起退出 App 时，系统会询问是否让 App 启动的后台任务继续运行（“On Mac computers with macOS 26 or later, if background tasks are started by an app and remain active after a user quits the app, the user is prompted to allow or not allow the background tasks to remain active.”，https://support.apple.com/guide/deployment/manage-login-items-background-tasks-mac-depdca572563/web）；选「不允许」后会怎样没有写明，由 `native_bridge_ipc` 记录（INSTALL §2）。
   - 非持久后台页卸载后计时器不会触发（WWDC21：“A timer won't be invoked if the background page has unloaded.”，https://developer.apple.com/videos/play/wwdc2021/10027/）；后台休眠与唤醒由 `native_bridge_ipc` 与 `first_request_and_old_connections` 验证。

## 1. 仓库结构

```
packages/contract   共享类型与纯函数：视图、HTTP/原生/套接字接口、SSE 事件、错误码、命名、站点、就绪推导、检测服务
packages/easyquick  EasyQuick UI 设计系统：token、组件样式（bundle 原样）、图标、Tailwind 预设
service             本机管理服务（唯一写入者）与 sfe CLI
apps/web            本机网页后台（Vue 3 + EasyQuick UI）
extension           Safari Web Extension（MV3）：后台、弹窗、准备页、登录页内容脚本
apps/macos          Swift：宿主 App、原生桥、sfe-keychain（XcodeGen 工程）
tools/p0            P0 能力门槛实测工具与操作手册（输出写到仓库外；复用同一受限 SurgeAdapter，不切换配置、不重载全部、不 flush，写前快照并打印精确回退）
docs                架构、安装/卸载/回退、P0 手册、验收报告模板
```

## 2. 进程与信任边界

```
Safari 扩展（后台/弹窗/准备页）──sendNativeMessage──▶ 原生桥 SafariWebExtensionHandler（签名 App Extension，沙盒）
   ▲ 内容脚本只经后台发 requestLoginFill            │ 补充 SFExtensionProfileKey；以传输令牌做双向 HMAC 握手（令牌不上线路）；解析钥匙串引用
                                                      ▼ 候选传输（P0: native_bridge_ipc 决定）
                                         sfe-service（Node，随 App 打包，SMAppService LaunchAgent）
网页（127.0.0.1:61847，Bearer 令牌）──HTTP + 事件流──▶ │ ──▶ SQLite（数据目录 0700）
sfe CLI / GPT ──agent.sock（受限）──────────────────▶ │ ──▶ sfe-keychain（stdin JSON，只写账号密码，可读代理凭据）
宿主 App ──maintenance.sock（维护）─────────────────▶ │ ──▶ Surge（固定的 CLI/HTTP 原语，只读回环 API）
```

**原生桥传输（待 P0 定案，`native_bridge_ipc`）**：候选 A，回环 TCP `127.0.0.1:<bridgePort>` + 每次安装随机令牌（宿主 App 写入 App Group 容器给扩展、写入数据目录 0600 给服务，服务每个连接重新检查该文件，宿主 App 改写令牌后无需重启服务；扩展需要 `network.client`；NDJSON 一连接一次握手加一个请求，HTTP 请求行无法解析即断开）。回环 TCP 对本机所有系统用户可达，服务未监听时端口可能被其他用户抢占，因此令牌从不上线路：双方用 HMAC-SHA256 互相证明持有令牌，原生桥先验证服务的证明，未通过不发送场景 ID 或消息（握手见 §7.2）。候选 B，App Group 容器内 Unix 套接字（需证明 LaunchAgent 访问容器无 TCC 提示、路径 ≤103 字节）。候选 C，同团队签名的 Swift 中继（Mach 服务名带 App Group 前缀）。服务从不回退到无令牌的 TCP 或 0700 目录外的路径。

**信任与最小权限**：

- 同一用户的本机进程是信任边界。能连 maintenance.sock 的进程可以拿到网页登录码；agent.sock 是给 GPT/导入工具的最小权限通道，不是对抗恶意同用户进程的安全边界。两个套接字都是 0600、位于 0700 数据目录。
- 网页不用 Cookie：浏览器对 127.0.0.1 的不同端口共享 Cookie，其他本机网页服务会收到它。改为一次性登录码换取会话令牌，令牌存放在该源的 localStorage（按端口隔离），每个 `/api` 请求带 `Authorization: Bearer`。
- 原生桥消息里的 `profileId` 只有在原生桥证明持有令牌（§7.2 握手）时才被采信；抢占回环端口的其他系统用户既拿不到令牌，也拿不到场景 ID 或消息。令牌对同用户进程可读，所以伪造桥消息的进程可以做 agent 能做的事，并且能拿到明文登录账号与一次性钥匙串引用（比 agent 多）。**买家密码不经 Node 返回**：服务只发钥匙串引用，由签名的原生桥自己读钥匙串。其他进程拿到引用后读取该项时，系统会弹出钥匙串授权提示（macOS 10.13.1 起要求输入钥匙串密码），只有用户拒绝时才读不到；用户选「允许」或「始终允许」后就能读到（Apple：“If so, the system grants access. Otherwise, the system prompts the user for confirmation. The user may choose to Deny, Allow, or Always Allow the access.”，https://developer.apple.com/documentation/security/access-control-lists；“the system … always prompts for the keychain password when asking the user whether to add an app to the list of trusted apps.”，https://developer.apple.com/documentation/security/secaclcreatewithsimplecontents(_:_:_:_:_:)）。所以这道防线依赖用户拒绝陌生程序的请求，INSTALL §6 写明了这一点。
- **账号密码的存放**（`bridge_keychain_access` 决定）：首选方案——由 App 内的 sfe-keychain 写入登录钥匙串（文件型），条目的访问控制只信任 sfe-keychain 与扩展（SecAccess 受信任应用列表）；sfe-keychain 对账号密码只支持写入与删除。备选方案——数据保护钥匙串 + 共享访问组，由带描述文件的签名组件写入，仅当 `extension_install_persistence` 证明免费描述文件不会失效时采用。两者都不行时登录填充保持不可用，并在 INSTALL/ACCEPTANCE 中写明。钥匙串调用有超时（30 秒，等待用户授权提示），超时或拒绝进入可恢复状态（秘密不提交、操作失败可重试），从不把未写入的引用标为可用。
- **含秘密的位置**（完整清单）：钥匙串；sfe-keychain 的 stdin/stdout；`sfe-nodes.list`（Surge 语法要求明文代理凭据）；工作配置与原配置备份（含用户自己节点的凭据、http-api 密钥、MITM 证书口令）；`<数据目录>/tmp` 下的 `--check` 候选副本（用后即删）。不进 SQLite、日志、命令行参数、事件流、HTTP 列表接口、Git。代理凭据因此对同用户进程可读（资源文件本来就是明文），文档如实说明。

## 3. 服务内部模块（service/src）

| 目录 | 职责 |
|---|---|
| `config.ts` | 数据目录（默认 `~/Library/Application Support/SafariProfileSurge`，数据目录在 Git 工作树内时拒绝启动）、套接字与端口、Surge CLI 路径（只来自 0600 安装配置）、演示模式 |
| `util/` | `clock`（含测试时钟）、`ids`（≥128 位令牌）、`scrubber`（按值脱敏 + Surge 行规则）、`logger`（只写脱敏 JSON 行，不记请求体）、`keyed-digest`（HMAC）、`secure-files`（O_EXCL 0600 原子写、0700 目录、临时文件清扫） |
| `db/` | `node:sqlite` 打开、迁移、事务（BEGIN IMMEDIATE + 保存点）、每张表的仓库与记录类型 |
| `secrets/` | `SecretStore`（钥匙串 / 测试内存实现）、`SecretRefManager`（四步协议、引用计数回收）、pepper 与 HMAC 指纹 |
| `domain/` | 输入校验、节点行变化判定、命名分配、差异、视图组装 |
| `importer/` | CSV/XLSX/JSON 解析为 `ImportRecord`（不执行公式/宏/外链），映射与行级校验 |
| `surge/` | 原语接口实现（CLI/HTTP/Fake）、配置解析与受管理段合并、节点资源与入口规则生成、入口策略、能力门槛、请求核对、连接结束、配置脱敏 |
| `engine/` | 操作受理、outbox、唯一执行器、各操作处理器、对账器（启动/周期/动作前）、事件总线、AppService 实现 |
| `http/` | 回环 HTTP、令牌认证、Host/Origin 检查、路由、事件流、静态文件、登录交换页 |
| `ipc/` | NDJSON 帧；原生桥服务（按 P0 定案的传输）；agent/maintenance 套接字 |
| `cli/` | `sfe` 命令行（秘密只从 stdin 读） |
| `main.ts` | 组装与启动：版本断言 → 迁移 → 读 Surge 事实对账 → 恢复未完成操作 → 开始执行器 → 开放 HTTP/IPC |

依赖通过 `service/src/ports.ts` 注入；测试用 `FakeSurge`、内存秘密存储与可控时钟。

## 4. 数据模型（SQLite）

`service/src/db/schema.ts` 是唯一定义。要点：

- `environments`：稳定编号、展示名、站点、选项、`expected_exit_ip`（不是节点参数，直接修改）、`revision`、`desired_proxy_revision`、`deployed_proxy_revision`、`last_verified_proxy_revision`、`binding_stage`、`deleted_at`。账号修改后的“未核对”标记在 `accounts.changed_since_page_check`。
- `proxy_revisions`：节点参数（协议/地址/端口/用户名与密码引用及 HMAC 指纹/前置 id）、`node_name`、`state`（desired/deployed/superseded/retired）。**只有节点行字段变化（协议、地址、端口、用户名或密码指纹、解析后的前置 id）才产生新版本与新节点名。**
- `front_proxies`：`surge_name`、`kind`（首版只允许 node）、`state`、`is_default`、`retired`。
- `accounts`、`profile_bindings`（含 `state`：bound / bound_unverified_id）、`profile_reports`（各场景最近上报的窗口/Amazon 标签页/站点权限，只作提示）。
- `deployments` 与 `deployment_operations`（一次发布包含的多个操作）、`readback_level`、`unchecked_fields`。
- `managed_objects`：本应用拥有的对象清单——受管理段、资源文件、入口规则集文件、本应用添加的精确临时规则——含内容摘要与状态（pending_add / present / pending_remove / removed）。任何写入前先提交意图行，读回后再确认；对账以它判断归属，从不按前缀或注释判断。
- `route_state`（单行）：epoch、入口模式、阶段、活动环境与版本、选择、旧窗口策略、警告、等待截止、最近对账时间、**激活快照**（切换前的环境/版本/选择/模式/实测/epoch，崩溃后用于回滚）。
- `operations`：`request_id` 唯一、`request_digest`（对秘密值做 HMAC 后的规范形式的带密钥摘要）、`kind`、`initiator_kind`、`initiator_profile_id`、`probe_kind`、`superseded_by`、阶段、状态（含 waiting / superseded）、payload（只含引用）、结构化结果。
- `operation_steps`、`outbox`（`resume_reason`）、`probes`（含 Surge 请求证据、链路证据、浏览器侧时间与状态、检测时入口模式、配置代数）、`verification_tests`。
- `capabilities`（状态、验证上下文、逐协议覆盖、所确认的提议 `proposal_id`）、`capability_proposals`（P0 工具/agent/维护通道提交的证据摘要，待网页确认）。
- `backups`（源与备份路径、各文件摘要、可读的运行开关：增强模式、系统代理、出站模式、自动重载、HTTP API）。
- `settings`、`meta`、`secret_refs`（`owner_kind`、`owner_id`、状态）、`web_sessions`（令牌哈希、绝对与空闲过期）、`login_codes`（哈希、60 秒、单次）。

**秘密生命周期**：

1. 小事务插入 `secret_refs(ref, pending, owner)`；2. 写钥匙串（新 ref，从不覆盖）；3. 主事务写引用该 ref 的行、标 committed、写 operation + outbox；4. 失败则删除该项与 pending 行；启动及周期清扫超过 10 分钟的 pending。
- `keep` 语义：新代理版本沿用旧 ref；回收按引用判断——只有没有任何非 retired 的版本行、账号行或设置行引用它时才删除。
- 账号密码替换或清除：在提交新状态的同一事务中把旧 ref 标为 orphaned，之后删除。
- 删除环境：其版本全部 retired 后删除其秘密。
- 回收在启动时和每小时执行一次：删除已 orphaned 且没有任何引用的项、超过 10 分钟的 pending 项。
- pepper 存在钥匙串中；读不到时 fail closed（停止导入与发布，`SECRET_STORE_FAILED`），从不静默重新生成。
- **不存储或发出任何基于含秘密内容的无密钥哈希**：资源文件、配置、请求、导入批次的摘要一律用 pepper 派生密钥的 HMAC；视图与事件只给配置代数，不给摘要。

## 5. Surge 适配层

### 5.1 原语

`SurgeAdapter`（`ports.ts`）只含：读——版本与构建（含 Core 版本与 Controller 协议，只用于与运行实例交叉核对）、当前配置、策略列表、策略详情（解析后在内存中脱敏）、组成员与选择、有效规则列表（含模块规则）、规则求值（`rule match`，只求值不建立连接）、活动/最近请求、外部资源列表（含 `local`、`updating`、`fromModule`）、临时规则列表、接管与出站状态、自动重载设置、运行信息（引擎运行时长与换算的启动时间）；写——组选择（只 SFE-ROUTE，不能是 auto）、结束单个请求（数字 id）、按单个 key 更新外部资源（不能是 all；结果区分“已下载”与“被跳过”，本地资源总是被跳过，从不算刷新）、增删单条临时规则；校验——`--check` 候选文件、策略测试。CLI 映射与 argv 允许清单见 `service/src/surge/cli-commands.ts`（目标 Mac 6.10.0，读命令带 `--raw`，写命令不带以保留客户端命令校验）。

- 没有 switch-profile / profile switch、reload、restart-engine、update all、flush 临时规则、开关接管（feature set）、改出站模式（mode set、global-policy set）、module、set、managed-profile update、停止 Surge 的原语，代码层面不可能调用；每条 argv 执行前还要完全符合 `CLI_ARGV_ALLOWLIST` 中的一项。
- `reloadProfile` 不在 `SurgeAdapter` 上，只存在于单独的 `MaintenanceSurge` 端口，只注入维护处理器（init/remerge），发布、路由、回滚、恢复处理器拿不到它；它从不是刷新失败的兜底。
- 每个原语固定到一种实现（CLI 或 HTTP），由 P0 原语清单决定并写入配置；`CompositeSurgeAdapter` 不动态选择。能力记录里的 `adapterMechanism` 与配置不一致时视为待验证。
- CLI：`execFile(cliPath, argv)`，不经 shell；`cliPath` 只来自安装配置，必须解析到已安装的 Surge.app 内且通过 `codesign --verify`（记录的 Team ID）；argv 只有路径、资源 key、组名、节点名、规则文本。
- 子进程（surge-cli、codesign、sw_vers、defaults、open，运行实例读取的 ps、plutil、lsof，以及 P0 的 ps 等）一律经 `util/exec-fixed.ts`：只执行绝对路径的固定程序，不经 shell，启动后立即关闭 stdin（sfe-keychain 例外：写入一行请求后关闭）。不带命令运行时 `surge-cli` 进入交互模式（随包技能：“If no command is provided, it enters interactive mode.”；历史上 6.5.0 遇到无法识别的 `--version` 也是如此），stdin 不关闭时只能等到超时，被误报为无法连接。CLI 每个命令的 argv 都有子命令（只有 `--check` 是单独的选项），不使用没有写入文档的 `--version`；版本用 6.8.0 起的 `version` 命令。6.10 不带 `--raw` 时客户端拒绝不认识的命令（“Unknown command”），按 `SURGE_COMMAND_FAILED`（`details.reason = unsupported_command`）处理，失败即关闭。
- 输出（stdout 或 stderr）中出现交互模式提示时，先于退出码、超时、无法连接文字等一切分类，也先于解析，按 `SURGE_COMMAND_FAILED`（`details.reason = interactive_mode`）处理：退出 0 不算成功（`--check` 不算通过，写命令不算已写入），错误信息不回显输出（其中的 `Connected to 127.0.0.1` 不是版本或结果）。P0 `inventory` 的 `--help` 输出若是该提示（匹配提示且不含原语表中任何命令词），命令词按空处理、给出警告并保留原文；帮助正文中提到交互模式但列出了命令时仍按帮助解析。
- 退出 0（或 `--check` 的非零结果）时，stderr 出现无法连接文字（not running、isn't running、connection refused、could not connect、controller connection timed out / was closed、connection interrupted、Surge CLI is not connected 等，取自 6.10 包内 surge-cli 的文字），或 stdout 不是 JSON 且出现这些文字，同样先于解析按 `SURGE_UNREACHABLE` 处理：空输出不会被当作“没有临时规则”，`--check` 不算通过，写命令不算已写入。JSON 结果中的名称或规则含这些词不受影响。6.8.0 起“Command errors are now written to standard error and produce a non-zero exit status.”；Surge 未运行时的实际输出与退出码待测试 Mac 记录（P0-RUNBOOK V7）。
- HTTP：只连回环；密钥在运行时从工作配置 `[General] http-api` 读取（不落库）；该行绑定到非回环地址时拒绝使用 HTTP 并告警。若 P0 表明必需 HTTP 而工作配置没有，`maintenance.init` 以受管理的 `[General]` 段（`http-api = <随机密钥>@127.0.0.1:<端口>`，关闭 TLS 与网页仪表盘）加入，并经用户确认。
- 来自 Surge 或子进程的任何自由文本（含 `execFile` 错误信息与 stderr、`--check` 输出）先经脱敏器（按值 + 节点行参数 + http-api + URL 用户信息与查询）再进入日志、步骤、错误或事件流。

### 5.2 能力门槛

门槛表见 `CAPABILITY_GATES`（contract/phases.ts）：

| 动作 | 需要 |
|---|---|
| 任何节点资源发布（自动或手动，要求相同） | targeted_resource_refresh、policy_path_reread、external_node_underlying_proxy、connection_continuity、auto_reload_atomic_replace |
| 激活与活动环境切换 | native_bridge_ipc、external_node_underlying_proxy、safari_process_attribution、runtime_entry_modes、entry_rules_after_restart、safari_udp_quic_handling、fixed_profile_no_switch；ruleset_resource 策略另需 auto_reload_atomic_replace（规则集文件经 Surge 文件监视重新读取，由该策略下的 runtime_entry_modes 证明；从不调用 update） |
| 结束 Safari 旧连接 | safari_process_attribution（普通模式下不满足时尽力而为并报告结果） |
| 场景绑定 | native_bridge_ipc（native_profile_id 未通过时绑定状态为 bound_unverified_id） |
| 登录填充、自动打开订单 | native_profile_id、first_request_and_old_connections、bridge_keychain_access，且路由“受控”（§6.6） |
| 独立预检 | independent_node_preflight（不通过：预检记为 inconclusive，不借当前选择组测试） |
| 维护写工作配置与重载 | auto_reload_atomic_replace，且 same_profile_reload_impact 已测量（`CAPABILITY_MEASURED_GATES`：supported 或带影响记录的 unsupported）；入口必须是 NORMAL |

- **进入普通模式永远可用**：它只依赖入口写入原语与运行时读回，不受 safari_process_attribution 等状态影响（让用户在能力失效后仍能撤销本应用的入口）。优先级问题只阻止 VERIFY_ONLY/ACTIVE，不阻止经 BLOCKED 到 NORMAL；结束 Safari 连接失败（含列不出活动请求、严格核对时仍有连接）只记录并报告，不中止；本应用拥有但被外部修改、无法识别或缺失的入口规则集文件按 §5.5 改写。
- **通过条件**：`CAPABILITY_CRITERIA`（contract/phases.ts）是网页能力页与 P0 手册共用的唯一文字来源。safari_process_attribution 与 safari_udp_quic_handling 的提议必须带逐协议覆盖（`ProtocolCoverage`）；确认 supported 时，`GATING_COVERAGE_ITEMS` 每项都必须是 pass 或写明 limitation；DNS、WebRTC、系统服务只作记录与展示。
- **验证上下文**：每条能力记录保存 Surge 版本与构建、macOS 构建与补充版本（后台安全改进，`macosVersionExtra`）、后台安全改进待重启状态（`macosRestartPending`）、Safari 版本、入口策略、进程路径摘要、工作配置身份、自动重载设置、接管方式、签名身份、原语实现（只记录该能力依赖的原语，见 `CAPABILITY_PRIMITIVES`，以规范 JSON 比较）；`CAPABILITY_CONTEXT_DEPS` 声明每项依赖哪些字段。比较规则：记录为 `any` 匹配任何当前值；当前值读不到（null）时只匹配记录的 null 或 `any`，否则过期原因为该字段名；其余字段必须相等。例外：Surge 版本与构建（`NEVER_NULL_FIELDS`）只在记录与当前都是格式正确的同一具体值时匹配——任一侧为 null 都不匹配（读不到当前版本时记录的 null 或 `any` 也不匹配，记录为 null 时读到的版本也不匹配）；记录为 `any` 或格式不对（早于提议校验经维护通道提议并确认的旧记录、旧解析器的 `127.0.0.1`）时读到的版本也不匹配，否则升级后能力不会过期。读不到运行中 Surge 的版本即依赖版本的能力全部待验证（失败即关闭），进入普通模式不受影响。例外二：`macosRestartPending` 没有 `any`，只在记录与当前都是 `no` 时匹配（`yes`、`unknown`、null 与旧记录缺少该字段都不匹配），见 §0 第 5 条。提议校验：依赖版本或构建的能力，提议的上下文必须带格式正确的具体值（版本 `^\d{1,3}\.\d{1,3}(\.\d{1,3})?$`、构建 `^\d{1,10}$`），null、`any` 或其他值（例如旧解析器从 CLI 交互模式输出中取到的 `127.0.0.1`）以 `EVIDENCE_REQUIRED` 拒绝；P0 `propose` 在发送前同样拒绝；网页确认已有的提议时服务端按同一规则再查一次（`EVIDENCE_REQUIRED`；提议的上下文不会再变，这条提议标为已驳回、不再显示在待确认列表中，设置与能力记录不变），网页的「确认」按钮同样禁用并说明原因；同一能力的新提议被接受时，该能力较早的、按这条规则永远不能确认的待确认提议一并标为已驳回（能确认的较早提议保留）。依赖 `macosRestartPending` 的能力另要求它为 `no`、`macosVersionExtra` 为读到的具体值（不是 null 或 `any`）：提交、确认（早于该规则、没有这两个字段的提议同样驳回）、P0 与网页同一规则（`hostContextErrors`）。已有的这类能力记录（版本为 null、`any` 或格式不对）无需迁移：无论当前版本能否读到都显示为待验证、过期原因为 surgeVersion/surgeBuild，网页说明为“验证记录缺少……需要重测”。当前值来源：`sw_vers` 构建号与 `-productVersionExtra`（与 P0 同一解析：空输出为 `none`，不认识的输出为 null）、后台安全改进暂存位置的 lstat（存在为 `yes`，不存在为 `no`，其他错误为 null）、Safari.app 的 Info.plist、宿主 App 上报的签名身份、Surge 版本与构建（运行中的 Surge 实例，且与 `surge-cli --raw version` 交叉核对一致、不低于 6.10.0（12500）、Controller 协议 ≥ 22，见下面的“运行中 Surge 的版本”与 §0；读到的值不符合上面的格式也按 null）、`getTakeoverState`、`getAutoReloadSetting`、设置中的策略与进程路径、`mechanism()`。任一依赖字段不匹配 → 有效状态为待验证（`staleReasons` 列出原因）。
- **运行中 Surge 的版本**（`surge/running-instance.ts`，服务与 P0 共用 `createDefaultSurgeInstanceReader`，同一常量、同一 `stat`（bigint）与同一执行方式）：证明磁盘上的包就是运行中的那一份；`surge-cli --raw version`（Mac 6.8.0+：“Show Surge, Core, Controller protocol, operating-system, and device versions.”）只作交叉核对（`crossCheckSurgeVersion`，见 §0“最低 Surge”），不单独作为版本来源，HTTP API 不用于版本（`/v1/metrics` 的 `surge_build_info` 只在 P0 V9 记录）。只在 macOS 上运行，只执行固定的 `/bin/ps`、`/usr/bin/plutil`、`/usr/sbin/lsof`、`/usr/bin/codesign`，不经 shell，stdin 关闭；只读，从不写 Surge 或它的文件。规则依次为：① `ps -ww -axo pid=,uid=,lstart=,comm=`（环境固定为 `LC_ALL=C LANG=C TZ=UTC` 与固定 PATH；`comm` 是进程自己提供的 argv[0]，不是内核给出的可执行文件路径，ps(1)：“a process is entitled to destroy this information”，所以这一步只产生候选，由 ⑥ 的 lsof txt inode 与路径核对确认）中只取当前用户、可执行文件为 `<包>.app/Contents/MacOS/<程序>`、包的真实路径等于 `/Applications/Surge.app` 真实路径的进程（root 特权助手、`Contents/Applications/surge-cli`、包内嵌套的登录项、其他用户的 Surge、其他位置的副本与 Setapp 版都排除；路径含 `/AppTranslocation/` 单列原因）；② 先读 Info.plist 的 `CFBundleExecutable`，只保留程序名与之相同的进程，再要求恰好一个（零个为 `not_running`/`bundle_mismatch`/`translocated`，多个为 `multiple_instances`；其他位置的 Surge.app 同时在当前用户下运行也是 `multiple_instances`；运行中的 `/Applications/Surge.app` 已被移走或指向别处为 `running_image_mismatch`）；③ `lstart` 严格按 `%a %b %e %H:%M:%S %Y`（UTC，日空格补齐，星期须与日期一致）解析为整秒 S，否则 `start_time_unparseable`；④ 先以 bigint stat Info.plist 与主程序，再用 `plutil -extract <键> raw -o -` 读取（不用 `defaults`，避免 cfprefsd 缓存）：`CFBundleIdentifier` 必须在 `SURGE_BUNDLE_IDS`（初始 `com.nssurge.surge-mac`，TODO(P0)：测试 Mac V2 确认后定稿），版本与构建必须符合上面的格式；⑤ 两个文件的 ctime 与 birthtime 都必须已知且严格早于 S（同一秒按已修改处理；解包、`ditto`、`cp -p` 会保留旧 mtime，所以不看 mtime；包目录本身不检查，系统在启动时可能写扩展属性），否则 `modified_after_start`；⑥ `lsof -nP -a -p <pid> -d txt -F in` 中必须有一项与磁盘上的主程序 inode 相同且路径相同（或为其真实路径），否则 `running_image_mismatch`（`mv` 整包替换时 ctime 不变，靠这一条发现），lsof 失败为 `running_image_unverifiable`；⑦ `codesign --verify --strict <包>`（复用 `codesignArgs`；服务的 Team ID 与 CLI 路径校验一致为未知，P0 的 `--surge-team-id` 只会更严），否则 `signature_invalid`；⑧ 再 stat 一次，dev、ino、size、mtime、ctime、birthtime 必须完全相同，否则 `changed_during_read`。以 pid、S 与两次 stat 结果为键缓存包信息与签名结论（失败不缓存）；ps、stat、lsof 每次都执行；同时到来的读取共用一次进行中的读取。读取在执行器通道上进行（对账、刷新、动作前检查都经 `readBasicFacts`），所以服务的 codesign 超时为 15 秒（`SERVICE_CODESIGN_TIMEOUT_MS`，P0 为 60 秒以记录真实耗时），引擎对每次读取另设 8 秒总时限（`SERVICE_INSTANCE_READ_BUDGET_MS`，即引擎的 `DEFAULT_INSTANCE_READ_BUDGET_MS`），超过即按 `read_failed`（版本为 null；读取本身继续完成并更新缓存，它失败时另记 `surge.version_read_late` 与原因代码，例如 codesign 超时的 `signature_invalid`），排队的操作（包括进入普通模式）不会被一次慢的读取长时间拖住。P0 按同一时限核对自己的读取（`serviceLimitsExceeded`/`serviceInstanceResult`）：签名一步达到 15 秒，或缓存命中后每次仍要执行的步骤（包信息与签名以外的全部规则）合计达到 8 秒，服务就读不到这个版本——P0 的能力上下文与 inventory 中版本为 null，`instance` 提示并退出 3，`propose` 拒绝依赖版本的能力。结果是 `{pid, startedAt, bundlePath, bundleId, version, build}` 或带原因的失败，失败原因有中文说明（`RUNNING_INSTANCE_FAILURE_TEXT`）。`HostInfo.surgeInstance()` 缺省为 `not_darwin`（非 macOS）或 `unavailable`；`main.ts` 的 `macHost` 持有一个常驻读取器（为了缓存），演示模式与引擎测试夹具用 `FakeSurge.runningInstance()`。`readBasicFacts` 在可达性检测成功后读取它：版本与构建一起接受或一起为 null，失败原因记在内部的 `SurgeFacts.versionIssue`（不进入契约视图），提示「无法确认运行中的 Surge 版本（原因）：依赖 Surge 版本的能力按待验证处理」。运行实例可读且不低于最低版本后，`readVersion` 调用 `getVersion`（install.json 必须把它映射为 cli；没有映射即 `cli_version_unreadable`）与运行实例交叉核对，三者都通过才记录版本、构建号与 Controller 协议。P0 的 `measureContext` 与 `inventory`（证据 `inventory/surge-instance.json`、`inventory/surge-version.json`）用同一读取器与同一交叉核对，`instance` 命令单独读取并保存逐条证据（低于最低版本时退出 3）；磁盘上 Surge.app 的版本（`defaults read`）只作旁证，与运行实例不一致时提示。这些规则在测试 Mac 上通过 P0-RUNBOOK §1.5 的 V1–V10 之前，不据读到的版本确认依赖版本的能力。
- **可达性**：不经 `getVersion`（版本只决定版本，从不决定可达性）。引擎创建时按 `mechanism()` 在 `LIVENESS_PRIMITIVES`（listExternalResources、getCurrentProfile、listPolicies，按此顺序）中静态选定第一个映射到 CLI 或 HTTP 的只读原语（只有 CLI 时是 `--raw external-resource list`；只配置 HTTP API 时是 getCurrentProfile 或 listPolicies；不含 listTempRules：`--raw dump temp-rule` 的空输出就是“没有临时规则”，不能证明连接，只映射了它时没有检测原语），之后不按成败换用另一个原语或另一种实现。`readBasicFacts` 只在这一次读取解析成功时判为可达，其余一律不可达（失败即关闭），且不再读取其他事实：没有可用原语或其实现不存在（CLI 未通过签名校验、HTTP API 不是只监听回环地址）→「无法连接 Surge：尚未配置可用的命令行工具或 HTTP API」；`SURGE_UNREACHABLE` →「无法连接 Surge」；命令失败、交互模式提示、输出无法识别、HTTP 401 等 →「无法确认 Surge 连接：只读检测失败或输出无法识别」。没有“其他错误按可达处理”的分支。版本与构建与可达性无关：读不到或格式不对时为 null（依赖版本的能力按上面的规则待验证），Surge 仍可达，提示「无法确认运行中的 Surge 版本（原因）：依赖 Surge 版本的能力按待验证处理」。状态提示按优先级只取一条：无法连接 > 当前配置不是工作配置 > 版本无法确认 > 工作配置目录位置无法确认。检测与版本的结论只在变化时记日志（`surge.liveness_failed`/`surge.liveness_restored`、`surge.version_unknown`/`surge.version_known`，只含原语名与原因代码，不含 Surge 输出）。每次读取事实多一次只读调用。不可达时发布、激活、初始化以 `SURGE_UNREACHABLE` 拒绝，托管状态下对账附加 `surge_unreachable`（§6.6）；进入普通模式不看可达性，不受影响。
- **证据与确认**：`supported`/`unsupported` 只能由网页会话确认一个提议（`capability_proposals`）。提议由 tools/p0、agent 或维护通道提交（网页只确认、不提议），必须带上下文、脱敏摘要与原始证据摘要；safari_process_attribution 的提议必须带进程完整路径（绝对路径、存在、无通配、非裸进程名、非系统通用 WebKit 框架路径，且证据显示 Chrome 与其他 WebKit 应用不命中）；runtime_entry_modes 的提议必须带所验证的入口策略。**进程路径与入口策略的唯一来源是已确认的提议**（设置接口不能改）；确认新的路径或策略会让依赖它们的能力回到待验证，入口不是 NORMAL 时拒绝确认。之后改用 ruleset_resource 还需要 `maintenance.remerge` 写入四条 RULE-SET。
- 检测服务（`verifyEndpointId`）只能在入口为 NORMAL 时修改；修改后 Safari 实测全部视为过期。
- 演示模式（§11）不能记录能力，也不读真实 Surge。

### 5.3 工作配置与受管理段

受管理段（注释边界只为便于审阅，归属以 `managed_objects` 为准）：

```ini
[Proxy Group]
# SFE-BEGIN group v1
SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list
# SFE-END group

[Rule]
# SFE-BEGIN entry v1
（按通过 P0 的入口策略生成：ruleset_resource 为 udp/verify/block/active 四条 RULE-SET；temp_rule 不在配置中写规则）
# SFE-END entry
```

- **初始化（`maintenance.init`，一次性）**：预览阶段只读——备份当前活动配置、其相对引用文件与可读运行开关到数据目录 `backups/`（0700/0600），检测 `#!MANAGED-CONFIG` 远端托管头与其他远端来源（`#!include` URL、远端规则集/模块，只显示主机名）并给出「源配置的远端更新不再自动应用，之后需要重新合并」提示、配置目录是否在 iCloud/同步/受保护位置（默认拒绝）或位于 Git 工作树（警告）、LaunchAgent 启动的服务能否无 TCC 提示读写该目录、自动重载设置、接管与出站状态、HTTP API 绑定、名称与文件冲突（配置文本与 `listPolicies` 中的非本应用 `SFE-` 名称、目录中已存在的 `sfe-*` 文件、指向 `sfe-*` 路径的外部资源；策略列表或外部资源列表读不到时无法排除模块等配置文本之外的同名对象，按冲突处理并说明原因，不放行）。生成候选（托管头经确认后移除并在差异中显示，URL 脱敏），在 `<数据目录>/tmp` 构造候选并解析全部相对引用后 `--check`，返回 `preview_digest`。提交时重新计算摘要（源配置、引用文件、受管理差异、目标路径），不一致返回 409 `PREVIEW_STALE`。确认后写入新文件 `日常-Safari环境.conf` 与占位资源文件（目标文件必须不存在），**由用户在 Surge 中手动切换一次**。已有工作配置时再次初始化返回 409；首版更换工作配置需要卸载并清空数据后重新初始化。工作配置路径只由此设置。
- **之后以当前工作配置为基线**：用户在受管理段之外的修改直接成为新基线；只有受管理段被改动/缺失/边界歧义、entry 段不在有效规则首位、出现非本应用的 `SFE-` 对象时才停止同步（`BASELINE_CHANGED` / `NAME_COLLISION`），只报告段名、行号与带密钥摘要，不回显内容。
- **重新合并（`maintenance.remerge`）**：用于恢复受管理段、接入新结构（例如改用 ruleset_resource）或恢复被外部改动的本应用文件。预览显示受管理段差异与 `sfe-nodes.list`/入口规则集相对上次发布内容的脱敏差异、是否需要重载以及 P0 测得的重载影响，由用户选择维护时间后提交。写入工作配置受维护写门槛约束、入口必须是 NORMAL，写后按 P0 结论生效（自动重载或经确认的同一配置重载），并读回接管/系统代理/出站模式未变；恢复本应用文件走发布路径（受发布门槛约束）。被修改的受管理段或文件从不被采纳为基线。提交时摘要不一致返回 `PREVIEW_STALE`。
- **首版前置只允许用户已有的固定节点**：`sfe_managed`/`SFE-F-*` 保留不开放；组、内置策略、`SFE-` 节点都不能作为前置。

### 5.4 节点资源

```
SFE-N-E0001-US01-v003 = socks5, 203.0.113.10, 1080, username=<u>, password=<p>, underlying-proxy=<前置节点名>
```

- 受控序列化：地址/端口/名称/前置名逐项校验；用户名/密码先只允许 `[A-Za-z0-9._~-]`，P0 凭据字符夹具逐个证明后再放宽；不能表达时返回 `UNSAFE_CREDENTIAL_CHARS`。永远不拼接原始表格文本。节点行字段形式（`username=`/`password=` 参数或位置参数）以 P0 校验为准。
- **内容（保留集）**：已部署版本、正在被选择或验证的版本、`last_verified` 版本（回滚目标）、本次发布批次中明确包含的操作的 desired 版本；无效或门槛不满足的条目被排除并保留各自状态。被替换的旧版本在无选择、无进行中操作引用、`listActiveRequests` 无归属到它的请求（P0 确认如何识别组后面的叶节点；无法判断则保留）后合批移除。
- 文件头注释只含配置代数。文件以 O_EXCL 0600 原子写入；Surge 配置目录在同步位置时不允许写入（见 §5.3）。

### 5.5 入口模式

四种逻辑模式与四个逻辑位（`ENTRY_MODE_BITS`；引擎、错误的 `lastConfirmedBits` 与读回的 `bits` 都用它）：

| 模式 | udp | verify | block | active | 效果 |
|---|---|---|---|---|---|
| NORMAL | 0 | 0 | 0 | 0 | Safari 继续匹配用户完整原规则 |
| BLOCKED | 1 | 0 | 1 | 0 | Safari 全部拒绝 |
| VERIFY_ONLY | 1 | 1 | 1 | 0 | 只有检测域名经 SFE-ROUTE（非 UDP），其余拒绝 |
| ACTIVE | 1 | 0 | 0 | 1 | Safari 非 UDP 经 SFE-ROUTE；UDP/QUIC 拒绝（回落 TCP） |

两种策略把它们落成不同的规则。不修改全局 `udp-policy-not-supported-behaviour`，只读取并记录。文档依据（Surge Mac 6.10.0）：逻辑规则“`AND,((Rule1),(Rule2),...),Policy` / `OR,((Rule1),(Rule2),...),Policy` / `NOT,((Rule1)),Policy`”，“`NOT` inverts the result of its sub-rule. It takes exactly one sub-rule”，可以嵌套（https://manual.nssurge.com/rules/logical.html）；“`PROTOCOL,UDP` also matches QUIC and STUN connections”，“`PROTOCOL,TCP` also matches HTTP, HTTPS, and MTProto connections”（https://manual.nssurge.com/rules/protocol-and-network.html）；PROCESS-NAME 以 “/” 开头且不以 “/” 结尾为完整路径模式，“Matching is case-sensitive in all modes”（https://manual.nssurge.com/rules/process.html）。

**ruleset_resource 的规则**：工作配置中四条 RULE-SET 固定先后 udp > verify > block > active > 用户规则，文件中的规则可以相交——udp `AND,((进程),(PROTOCOL,UDP))` → REJECT；verify `AND,((进程),(DOMAIN,<检测主机>))` → SFE-ROUTE；block/active 每个路径一行 `PROCESS-NAME,<路径>`；关闭的位写占位规则 `AND,((PROCESS-NAME,/var/empty/sfe-entry-witness),(DOMAIN,sfe-disabled.invalid))`。每个文件另有一条**见证规则** `AND,((PROCESS-NAME,/var/empty/sfe-entry-witness),(DOMAIN,sfe-entry-<位>-<标记>.invalid))`：每次写入换一个随机标记；初始化写入的占位文件用固定标记 `off`。见证与占位规则都限定一个不存在、也无法创建的合成进程（`/var/empty` 只属于 root 且为空；contract `ENTRY_WITNESS_PROCESS_PATH`），只有见证探测命中：规则文档写明“Domain rules match the hostname of a request. They are the most common rule types and never trigger a DNS lookup”（https://manual.nssurge.com/rules/domain.html），`.invalid` 不解析并不妨碍按主机名匹配，而规则集文件继承 RULE-SET 行的策略（verify/active 为 SFE-ROUTE）——不限定进程时，Chrome 或任何网页请求 `sfe-entry-active-off.invalid` 都会经买家出口发出，固定标记 `off` 又是公开的。读回因此另用对照进程探测各文件当前的见证主机与占位主机（TCP），命中本应用入口规则或 SFE-ROUTE 即为对照命中。没有见证的旧格式文件只在全部为占位规则时可按 Safari 探测读作 NORMAL；早先版本写入的不限定进程的占位规则 `DOMAIN,sfe-disabled.invalid` 仍识别为关闭（只识别、从不写入），读回证据写明，下一次切换按未知重写（这些文件还在时不探测占位主机，否则改写它们的每一步都会因已知的旧格式问题失败）。

**temp_rule 的规则**：五种条件互不相交的临时规则（进程 = 单个 `PROCESS-NAME,<完整路径>` 或它们的 OR）。

| 种类 | 规则 | 覆盖的 Safari 流量 |
|---|---|---|
| block | `<进程>,REJECT` | 全部 |
| udp | `AND,((<进程>),(PROTOCOL,UDP)),REJECT` | UDP（含 QUIC/STUN） |
| verify | `AND,((<进程>),(NOT,((PROTOCOL,UDP))),(DOMAIN,<检测主机>)),SFE-ROUTE` | 检测主机的非 UDP |
| active | `AND,((<进程>),(NOT,((PROTOCOL,UDP)))),SFE-ROUTE` | 全部非 UDP |
| blockOther | `AND,((<进程>),(NOT,((PROTOCOL,UDP))),(NOT,((DOMAIN,<检测主机>)))),REJECT` | 其他主机的非 UDP |

各模式的集合：NORMAL 无；BLOCKED {block}；VERIFY_ONLY {udp, verify, blockOther}；ACTIVE {udp, active}。每个集合里相交的规则策略相同，所以模式只取决于存在哪些规则、与先后无关（`orderIndependentMode`，穷举测试）。报告时种类按逻辑位记（blockOther 是 VERIFY_ONLY 中的“阻断”，记为 block 位）；每一步报告的 `bits` 是这一步读回确认的模式的逻辑位。旧版本（6.5 时期按顺序设计）的 verify `AND,((进程),(DOMAIN,…)),SFE-ROUTE` 与 active `<进程>,SFE-ROUTE` 只用于识别遗留规则（`legacy_<种类>`），从不写入。

**策略与生效原语**（均需 P0）：

- `temp_rule`（首选候选）：写 `surge-cli rule temp add <rule>` / `rule temp remove <rule>`（Mac 6.9.0+、协议 ≥20；CLI 帮助：“Add a temporary rule with the highest priority”、“Remove one temporary rule by its exact text”；不加 `--raw`，保留命令行工具的命令校验），列表读 `--raw dump temp-rule`；从不 `rule temp flush` / `flush-temp-rule`。文档：“Temporary rules take effect immediately, precede all profile rules, and are discarded when Surge stops.”（https://manual.nssurge.com/tools/cli.html）。按 `managed_objects` 记录的精确规则逐条增删；同文的临时规则已存在但无本应用记录时停止（`NAME_COLLISION`），不收编。**规划**（`planTempKinds`，纯函数）：从当前存在的种类集合到目标模式的集合，每步只加入或移除一条，广度优先找最短计划，每步之后的集合在**任何先后**下都只能是 {起点, 终点, BLOCKED, VERIFY_ONLY} 中的模式——新规则排在最前（文档的 “highest priority”）、最后或中间都一样；候选次序让拒绝规则先加、路由规则后加，路由规则先撤。例如 NORMAL→ACTIVE：+block、+udp、+active、−block；VERIFY_ONLY→ACTIVE：+active、−verify、−blockOther；ACTIVE→VERIFY_ONLY：+blockOther、+verify、−active。中断的切换留下的集合（例如 {udp, active, blockOther}）没有与先后无关的计划时，按读到的实际先后与插入位置模拟（`planTempKindsByInsertion`；插入位置记录在能力中，未知时 head 与 tail 都要安全）；仍没有计划时，撤销入口（普通模式、回滚）改走下面的逐条清理，其他切换在写入之前以 `CAPABILITY_UNVERIFIED` 拒绝。穷举：head 插入下 32 个集合 × 全部先后 × 4 个目标都有计划；插入位置未知时，凡实际效果是已知模式的起点都有计划。本应用记录的规则重复、是旧文本（进程路径或检测主机变化后的 `stale_<种类>`，或旧版本的 `legacy_<种类>`）、无法识别或不在有效规则中时，入口状态无法按种类确定：激活方向与未标为撤销的切换以 `UNKNOWN_STATE` 拒绝、不写入；只有撤销入口（入口切换带 `undo`，目标 BLOCKED/NORMAL）逐条清理本应用记录的规则，只走从不放宽的步骤——目标 BLOCKED：先确保当前配置的 block 规则存在（缺失则加入：加入 REJECT 规则在任何插入位置都不放宽；同文规则无本应用记录 → `NAME_COLLISION`）并出现在有效规则中（否则不移除任何规则，`UNKNOWN_STATE`），再在它一直生效的前提下按 active → verify → 无法识别（策略不是 REJECT 类）→ udp → blockOther → 无法识别（策略为 REJECT 类）→ 其他 block 文本的顺序移除其余本应用规则（可能路由的规则先走；结构无法识别但策略为 REJECT 类的规则保留到 udp、blockOther 之后，否则先移除它会短暂暴露其后同一匹配范围内旧的 SFE-ROUTE 规则），清理后的 {block} 就是 BLOCKED，Safari 全程不会经 SFE-ROUTE 新放行，也不会落到原规则；不属于本应用、可能匹配 Safari 流量并放行的规则夹在要移除的本应用规则与 block 之间时（例如排在后加的 block 之前的用户临时规则），移除会让 Safari 流量落到它，所以写入之前按插入位置预测、在任何写入之前以 `PRECEDENCE_VIOLATION` 拒绝（`lastConfirmedBits` 为 null，回滚停在需要处理；普通模式的中间阻断除外，见「优先级检查」）；目标 NORMAL：按同一顺序移除全部本应用规则，block 最后（当前配置的 block 文本在其他 block 文本之后）。每步与常规步骤一样先记录意图、写入、运行时读回、确认归属；任一步失败即停止，不声称已确认状态（`lastConfirmedBits` 为 null，回滚因此停在需要处理）；清理步骤不是按计划的单条变更，每步确认归属之后经入口切换选项的 `onCleanup` 报告（种类按逻辑位，blockOther 记为 block，规则原文随附）——普通模式与回滚把它写成一条操作步骤并累积到操作结果 `entryCleanup`（脱敏，之后失败也保留），同时记入最终读回的证据与错误的 `details.undoCleanup`；优先级语义不变。不属于本应用记录的临时规则任何方向都不移除。Surge 停止时临时规则被丢弃，重启后读回为 UNKNOWN（`missing_<种类>`），进入普通模式按事实确认归属、不写入。
- `ruleset_resource`：文档：“External rule sets are downloaded and cached. Local files are watched and reloaded automatically when they change.”（https://manual.nssurge.com/rules/ruleset.html）；外部资源更新“Download remote external resources immediately. … Local resources are skipped.”，“Local resources have no `updatedAt` field.”（https://manual.nssurge.com/tools/http-api.html，Mac 6.10.0+）。所以从不对入口文件调用 `external-resource update`，也从不把它当作刷新。每一步：读取当前自动重载设置（与能力记录的条件不符或读不到且未记录 `any` → 拒绝，停在已确认的更严格模式；普通模式也一样，报告无法执行而不写入）→ 确认 Surge 中恰好有一个资源指向该文件（否则 `RESOURCE_MISSING`/`NAME_COLLISION`，不写入）→ 比较并替换地原子写入单个规则集文件（期望上次摘要，意图先记入归属，带新的见证标记）→ 在有限时间内（`watch.timeoutMs`/`pollMs`，缺省 5 秒、每 0.2 秒，TODO(P0)：按实测的监视延迟设定）轮询 `rule match <见证主机> process-path=/var/empty/sfe-entry-witness`，直到命中该位的 RULE-SET（或回显的就是这条见证行）且最终策略与该位一致——这证明 Surge 已加载的正是这一版内容，**即使这一位被前面的 block 遮住**、Safari 的探测看不出差别（例如 NORMAL→ACTIVE 中 block 打开时写入的 active：之后撤下 block 不会暴露未加载的内容）→ 有效规则顺序与 Safari/对照探测读回（下文）→ 确认归属，才写下一步。**超时**：结果按未知处理（`READBACK_MISMATCH`，`details.reason = watch_timeout`），不声称更宽松的状态。只有**激活中放宽的一步**（verify/active 打开、udp/block 关闭）在能用写前的见证证明 Surge 仍是写前内容时，按写后摘要比较并替换地把文件改回写前内容，并再次读回写前见证——确认后上一确认状态仍然成立、归属按写前摘要确认（`restored: true`），否则 `lastConfirmedBits` 为 null、意图保持 pending。**撤销入口（普通模式、回滚，目标 BLOCKED/NORMAL）中放宽的一步**（只出现在走向 NORMAL 时：路由位已关闭并确认之后的 udp/block 关闭）同样从不改回（`keptTowardTarget: true`，`lastConfirmedBits` 为 null、意图保持 pending）——它只走向用户要求的普通模式；改回会让比时限慢的监视永远加载不到 udp/block 关闭，普通模式每次重试都写入又改回、永远停在 BLOCKED（违反用户决定 1）。普通模式的中间阻断（`towardNormal`）在见证与探测确认 block 开、verify/active 关、udp 已关（上一次普通模式失败在 NORMAL 一段）且没有异常时不写入，报告 BLOCKED（`bits` 如实，有规则排在入口之前时随读回附上、普通模式照常继续），不重新打开 udp——否则比时限慢的监视会让每次普通模式在中间阻断与 NORMAL 一段之间来回写入 udp；上一次 NORMAL 一段写入、超时后保留的 udp 关闭或 block 关闭（意图未确认、文件已是写入后的关闭内容、Surge 已加载的还不是这一版，且 verify/active 已由见证确认关闭；block 关闭只在 udp 已确认关闭之后出现）尚未加载时同样不写入、不按更宽松的一侧重新收紧（读回 `keptTowardNormal` 列出这些位，由 NORMAL 一段再写入）——否则相隔短于监视延迟的重试会在两段之间来回写入。其中 block 关闭尚未加载时 Surge 已加载的是写前的阻断或已是这次的关闭，本应用入口不会让 Safari 新请求经 SFE-ROUTE，但普通模式不把它记为已阻断，只照常结束 Safari 连接后继续撤销入口；有规则排在入口之前时与 BLOCKED 一样把这些规则记入操作结果 `precedenceIssues`，步骤写明读回不能确认 Safari 新请求不经这些规则发出，不声称 Safari 新请求不会经 SFE-ROUTE。保留写入的超时错误提示等 Surge 的文件监视加载之后再重试。回滚照常回到 BLOCKED 的位组合。**收紧的一步**（udp/block 打开、verify/active 关闭）从不改回：新内容留在文件中、意图保持 pending、`lastConfirmedBits` 为 null（`keptStricter: true`）——监视赶上之后加载的是更严格的内容；改回会让比时限慢的监视永远加载不到收紧，普通模式与回滚每次重试都写入又改回，Safari 一直停在买家出口。下一次切换开始时，pending 的位若见证读到文件中的这一版，就按事实确认归属（不再重写），否则按更宽松的一侧规划。读回本身失败（例如 `rule match` 超时）同样不声称任何已确认状态。已加载内容没有见证确认的位（pending 意图、见证读不到、已加载的不是文件中的这一版 `not_loaded_<位>`、旧格式文件、要改写的外部修改文件）按更宽松的一侧规划（block 未知时按关闭规划，第一步总是开 block），规划没有写到的未知位在最后一个 block 步骤之前按目标值重写一次。若 Surge 的本地规则集监视会重载整个配置、断开连接或不能在合理时间内加载，此策略不通过 P0。本应用记录拥有、但被外部修改、无法识别或缺失的入口规则集文件（读回的 `changedOwnedFiles`；文件监视会加载这些外部修改，Safari 的实际效果由用户的修改决定）：激活从不采纳也不改写它们——§6.3 第 2 步在写入之前以 `BASELINE_CHANGED` 拒绝，之后才出现的由激活中的入口切换（含第 6 步进入 BLOCKED）拒绝（`BASELINE_CHANGED`/`UNKNOWN_STATE`，不写入）并按第 14 步回滚；只有撤销入口（普通模式与回滚，入口切换带 `undo`，目标 BLOCKED/NORMAL）按载入时读到的摘要比较并替换地改写（已加载内容未知，与未确认的意图一样按更宽松的一侧规划、先开 block），失败时不把外部内容确认为记录，`managed_segments_changed` 警告保留（托管状态下到下一次激活；空闲且入口为 NORMAL 时由对账在检查不再成立后清除，§6.6）；不属于本应用记录的文件任何方向都不改写。

**切换顺序（无放行窗口）**：ruleset_resource 用纯函数 `planEntryTransition(from, to)` 输出单个位的变更序列：先开 block（离开 NORMAL 时同时尽早开 udp），再把 verify/active/udp 设为目标值（block 仍开），最后把 block 设为目标值。不变量（穷举测试）：开头之后到最后一步之前 block 一直开着；verify 或 active 为开时 udp 必为开；每个中间有效模式都属于 {BLOCKED, VERIFY_ONLY, 起点, 终点}；不会出现非目标的 ACTIVE 或 NORMAL。temp_rule 的不变量见上（16 对起点/终点在 FakeSurge 上按 head、tail、未知以及每次加入任选 head/tail 的全部组合穷举，每步之后观察 Safari 四类流量、QUIC 与 Chrome）。每步写入后做**运行时读回**；任一步失败停在已确认的更严格状态，记录 `UNKNOWN` 或最后确认的模式，不尝试退回更宽松状态（temp_rule 刚加入的规则读回不符时移除它，回到上一确认状态；例外：撤销入口中刚加入的 REJECT 类规则（block、udp、blockOther）只因探测读不到或与预期不一致而失败时保留——加入 REJECT 规则不会让任何流量新经 SFE-ROUTE 发出，移除它会让 Safari 回到切换前的买家出口、普通模式与回滚永远无法完成；这时不声称任何已确认状态。对照进程命中、或集合与有效顺序不是允许的模式时照常移除）。

**运行时读回**（文件摘要只是次要证据）：有效规则列表（含模块与临时规则）中本应用入口规则位于所有可能匹配 Safari 流量的非 REJECT 规则之前；temp_rule 下临时规则列表与记录完全一致、集合是目标模式的集合；ruleset_resource 下四条 RULE-SET 各出现一次、先后正确、资源无错误、每个文件的见证读回一致。另外每步与每次读回都用 `rule match`（Mac 6.9.0+、协议 ≥20；CLI 帮助：“Evaluate the active rule set without creating a connection, then show the matched rule and final policy.”，“process-path=<path> Source process path; affects PROCESS-NAME rules”，“protocol=<name> Protocol, such as TCP, UDP, HTTP, HTTPS, QUIC, or STUN”）探测：Safari 每个进程路径 × {检测主机, 站点主机（没有时为 `sfe-entry-probe.invalid`）} × {TCP, UDP}，命中的必须是该类流量预期的本应用规则（或预期不命中本应用规则）；被已知的 REJECT 类优先级规则遮住的算一致，被可能放行的优先级规则遮住的按优先级问题处理（读回不能宣称受控）；对照进程（缺省 Chrome 标准路径，`EntryConfig.controlProcessPaths` 可改）的同样四个探测永远不得命中本应用入口规则或 SFE-ROUTE。ruleset_resource 的对照进程另外探测各文件当前的见证主机与占位主机（TCP）。探测不一致、读取失败或对照命中都使读回为 UNKNOWN，切换中则停止（`READBACK_MISMATCH`，`details.runtime`/`controlHit`）。例外（§0「进入普通模式与 `rule match`」）：撤销入口（目标 BLOCKED/NORMAL）时 rule match **读不到**（不是不一致、不是对照命中）——temp_rule 按临时规则列表与有效规则顺序读回，ruleset_resource 在 rule match 不可用（未映射、Unknown command）时走退路——结果带 `runtimeConfirmed: false`，回滚与普通模式据此给路由状态加 `entry_unverified`。切换失败时错误中的最后确认位同样标明确认程度：temp_rule 切换的起点只按临时规则列表与有效规则顺序读出（没有本应用规则时即是 NORMAL，不需要求值），只有一步写入之后 rule match 读回一致才算经运行时求值确认；本次切换中 rule match 读不到（某一步或最终读回），或撤销入口中容忍了读不到的步骤之后，记下的位只按结构读回，之后抛出的错误（某一步写入超时而规则未变、读回不符、最终读回不是目标模式）都带 `runtimeConfirmed: false`——调用方按 UNKNOWN 处理，不把只按结构读回的阻断当作已确认的 BLOCKED（§6.3 第 14 步、§6.5）。temp_rule 没有任何本应用规则在临时规则列表中时（NORMAL）不需要探测。TODO(P0)：`rule match` 是否包含临时规则、命中规则集时 `rule` 字段是 RULE-SET 行还是子规则、“final policy” 是组名还是组内选择（识别对这些写法都接受，都不符合时按不一致处理）、`--raw` 的键名、含空格的进程路径作为一个参数是否被接受、多条临时规则之间的实际先后、本地规则集的监视延迟与它是否只重新加载该规则集。

**优先级检查**：在初始化、每次对账、每次激活前，对排在本应用入口之前的规则分类。“之前”指参与当前模式的最后一条本应用入口规则之前（含夹在本应用入口规则之间的），不只是第一条之前：temp_rule 的用户临时规则可能落在本应用的 udp 与 active、后加的 block 之前，或在撤销清理之前夹在本应用的旧规则与当前 block 之间，同样先于决定这类 Safari 流量的入口规则匹配。参与当前模式的是 Safari 流量还能到达的本应用入口规则：到某一条为止、本应用规则**累计**能证明覆盖 Safari 全部流量（temp_rule 按种类的覆盖表，例如 udp + active 或 udp + verify + blockOther；没有覆盖信息时只认只由覆盖全部 Safari 进程路径的 PROCESS-NAME 组成的单条规则）的这些规则，之后的规则 Safari 到不了、不分类；无法证明的按参与处理（ruleset_resource 的四条 RULE-SET 固定在工作配置中，边界因此是最后一条）；本应用入口规则都不在有效规则中时（temp_rule 的 NORMAL），按文档“precede all profile rules”，第一条配置规则之前的模块与临时规则都算。分类——REJECT 类只提示；可能匹配 Safari 流量、能路由到非 REJECT 策略的规则（模块 DIRECT、用户临时规则、RULE-SET/GEOIP/IP-CIDR/逻辑规则等不能证明无交集者）→ 入口记为 UNKNOWN、阻止激活，列出规则与来源（`PRECEDENCE_VIOLATION`）；从不自动停用或修改用户模块与临时规则。它只阻止进入 VERIFY_ONLY/ACTIVE：BLOCKED 的最终读回因此为 UNKNOWN（`PRECEDENCE_VIOLATION` 只在入口已全部是目标模式、仅被优先级挡住时报告；回滚因此停在需要处理），普通模式把这种已确认的 BLOCKED 当作中间步骤，继续进入 NORMAL。temp_rule 还在写入之前按插入位置预测每一步之后的有效规则（含其他规则的位置）并分类，两种情况在任何写入之前以 `PRECEDENCE_VIOLATION` 拒绝：目标 VERIFY_ONLY/ACTIVE 时任何一步之后出现阻止项（例如尾部插入时新入口排在已有的用户临时规则之后，移除原来覆盖 Safari 全部流量的 block 或 blockOther 后，这些规则就排在新入口之前；只看当前状态的检查发现不了）；目标 BLOCKED（激活中的阻断、回滚，含撤销清理）时某一步要移除的本应用规则排在一条可能匹配 Safari 流量并放行的其他规则之前，而这条规则在这一步或之后会被 Safari 流量到达——被移除的规则原来拦下的流量此后会落到它（可能直连或经其他出口）。早已排在被移除的本应用规则之前的规则不是这些写入造成的，照常由读回报告。普通模式的中间阻断（入口切换带 `towardNormal`）不做后一项拒绝：之后进入 NORMAL 本来就把这些流量交给原规则，普通模式永远可用；它的最终读回照常列出这些规则（`PRECEDENCE_VIOLATION`，入口已确认为 BLOCKED 即继续）。目标 NORMAL 不做预测拒绝。读取 `skip-proxy`、`tun-excluded-routes` 等绕过设置，覆盖站点或检测主机时告警。

### 5.6 文件安全

候选只写 `<数据目录>/tmp`（0700），全部含秘密文件以 O_CREAT|O_EXCL 0600 创建，`--check` 后删除（失败也删），启动时清扫残留；备份保留初始备份 + 最近 5 次维护备份，卸载步骤包含删除；`.gitignore` 排除 `*.conf`、`sfe-*.list`、`backups/` 等。

## 6. 执行器与事务（service/src/engine）

### 6.1 受理、队列与唯一写入者

- 处理器只做：校验 → 一个 SQLite 事务（期望数据 + operation(SAVED) + outbox）→ 202。纯数据修改（展示名、站点、选项、账号、预期出口 IP）同事务内完成为 `COMPLETED`，不入队、不碰 Surge。
- 同步拒绝不创建操作、不占用 `request_id`：校验失败、版本冲突、`NEEDS_CONFIRMATION`、`ROUTE_BUSY`、绑定不符。客户端可以用同一 `request_id` 带上确认重发。
- 同一 `request_id`：带密钥规范摘要相同 → 返回原操作（`duplicate: true`）；不同 → 409。
- 唯一执行器串行领取 outbox，所有 Surge 写在执行器内发生（全局写锁）。等待场景到达或 Safari 实测的操作状态为 `waiting`，释放执行器，由原生桥消息或计时器重新入队。
- 超时/Surge 无响应 = 未知：阶段 `RECONCILING`，先读事实再决定，不重复写。
- **领取顺序**（各组内按可用时间与 id，即受理顺序）：① **崩溃恢复先于一切**：启动时放回上次未完成的领取，状态仍是 running 的操作（串行执行器在两次领取之间没有执行中的操作，只有上一次进程在执行中退出时才有）的条目最先领取——它在退出前持有全局写锁，Surge 可能停在它半途的写入上，先由它按事实恢复（路由操作回滚或重新执行写入之前的步骤，发布按 §6.2），之后的操作从恢复后的状态开始；否则排在它之后受理的普通模式会先执行并报告成功，之后恢复的切换再按激活快照回滚、重新阻断 Safari（旧请求的结果覆盖新请求）。② 有未完成的普通模式（排队中；崩溃恢复中的已在第 ① 组）时路由操作先于其他操作（见下面的并发矩阵）。③ 其余。第二道防线：已开始写入（epoch 已递增）或已开始回滚的路由操作在崩溃恢复时，路由已记在另一个操作名下（`route_state.operation_id` 不是它）→ 路由已由之后的操作接手，不回滚、不写入 Surge，记为 `SUPERSEDED`（`superseded_by` 为接手的操作，步骤写明）。
- **路由操作并发矩阵**（按操作状态判断）：已有路由操作处于 queued 或 running（含 RECONCILING、ROLLING_BACK）→ 新的激活/Safari 重测返回 `ROUTE_BUSY`；新的普通模式照常受理（§5.2「进入普通模式永远可用」，服务视图提供它时从不拒绝；按显式请求串行处理、旧请求的结果不能覆盖新请求，方案 1 设计「多环境争抢」一行），排在其后执行（操作 payload 记 `queuedBehind`，步骤写明；有未完成的普通模式时执行器先领取路由操作（激活、普通模式、重测，以及已进入切换或 `WAITING_ROUTE` 的活动环境发布，与 `ROUTE_BUSY` 判断同一范围）——含它自己，路由操作之间仍按受理顺序——之后才领取受理更早的发布、预检等其他操作，被取代或把路由交给它的激活停下之后它立即执行，过渡中的路由不因无关操作多停留）：执行中的激活（含活动环境发布的切换与崩溃恢复中重新执行的激活）在第一次写入 Surge 之前（开始执行时，以及第 1–3 步的读取与独立预检之后、递增 epoch 与阻断之前——此时停下不碰 Surge：不阻断 Safari、不结束连接（从普通模式出发时按原规则发出的连接不受影响）、不改选节点、不经 SFE-ROUTE 预检）、每一次放宽入口（写入 VERIFY_ONLY、ACTIVE）之前与提交 ACTIVE 之前检查到排队的普通模式即停下，记为 `SUPERSEDED`（`superseded_by` 为该普通模式，不回滚，步骤写明停在哪里；活动环境发布的切换在第一次写入 Surge 之前停下时新版本已部署、路由未改变，与它停在 `WAITING_ROUTE` 时被普通模式结束一样记为 `READY_FOR_NEXT_OPEN`——succeeded、记录 `superseded_by`、没有错误），过渡中的路由交给普通模式——使用中的环境不变，受理时的旧窗口确认仍然成立；回滚、Safari 重测与另一次普通模式照常完成。普通模式开始执行时把其间停在等待中的激活/重测结束为 `SUPERSEDED`、`WAITING_ROUTE` 结束为 `READY_FOR_NEXT_OPEN`（与受理时相同），否则之后提交的实测会让已被撤销的切换重新写入 ACTIVE；执行时已没有使用中的环境（例如排在其后的回滚没有可恢复的切换前路由）不需要重新确认。普通模式排队期间新的激活与重测仍返回 `ROUTE_BUSY`。已有激活或重测处于 waiting（等待场景到达或实测）→ 新的激活或普通模式把它结束为 `SUPERSEDED`（记录 `superseded_by`，epoch 递增使其 test_id 失效，不执行回滚），新操作从当前已确认状态开始（先进入 BLOCKED）；新的重测返回 `ROUTE_BUSY`。已有活动环境改代理操作处于 `WAITING_ROUTE` → 新的激活或普通模式把它结束为 `READY_FOR_NEXT_OPEN`（新版本已部署、未切换，记录 `superseded_by`）；新的重测针对旧版本照常进行。被结束或让路的激活、重测与 `WAITING_ROUTE`（受理时取代、普通模式开始执行时取代、执行中让给排队的普通模式）的目标环境视图随之改变（切换中、检测中 → 未使用）：与这些操作一起发布目标环境（`environment.updated`），否则只靠事件更新的网页后台会一直显示它「切换中」、算作使用中（本地拒绝删除与解除关联）。活动环境改代理操作在路由忙时停在 `WAITING_ROUTE`，从不取代已开始的切换。
- 取消（`cancelOperation`）只适用于等待中的路由操作：激活/重测按 §6.3.14 回滚；`WAITING_ROUTE` 直接结束为 `READY_FOR_NEXT_OPEN`；从不进入 NORMAL。
- 对账（启动、周期、`refreshSurge`）作为执行器内部任务运行，只有在发现变化并改变路由状态或警告时才记录一条 `maintenance.reconcile` 操作，避免操作记录被周期任务刷屏。

### 6.2 发布

`VALIDATING → (门槛不足) WAITING_DEPLOYMENT` 或 `→ DEPLOYING → DEPLOYED_UNVERIFIED | PREFLIGHT_OK → READY_FOR_NEXT_OPEN`；活动环境接着走 §6.3（同一 operation_id，经 `WAITING_ROUTE`）。

1. 前置条件：Surge 当前配置名与路径等于记录的工作配置（否则 `EXTERNAL_PROFILE`，不写）；读取自动重载设置，与能力记录的条件一致（否则停在 WAITING_DEPLOYMENT）。
2. 校验数据、前置存在于 `listPolicies` 且是固定节点、命名唯一；生成候选资源；在 `<数据目录>/tmp` 构造工作配置副本并解析全部相对引用（P0 确认用符号链接或绝对路径）：`sfe-nodes.list` 与入口规则集指向候选副本，其余指向真实文件；任何引用无法解析即校验失败；每个解析结果只把路径（不含内容）记入步骤。然后 `--check`，逐节点核对预期清单，删除候选。
3. 基线三项检查：(1) 本操作开始时读到的工作配置与资源摘要在写入前未变（变了则从第 2 步重来，有限次数后 `BASELINE_CHANGED`）；(2) 受管理段内容与位置与 `managed_objects` 一致、无非本应用 `SFE-` 对象（`listPolicies` 中不在清单或进行中候选里的 `SFE-` 名称、候选新节点名已存在都算）；(3) `sfe-nodes.list` 等于上次发布的摘要。受管理段之外的用户修改直接记为新基线。
4. 写入前确认读回所需原语（`getGroupMembers`、`getGroupSelection`、`listExternalResources`）在固定实现下可用，否则停在 WAITING_DEPLOYMENT（执行器从不写入它无法读回的内容）。枚举外部资源，要求恰好一个 key 的位置解析到 `sfe-nodes.list` 的绝对路径（0 个 `RESOURCE_MISSING`，多个 `NAME_COLLISION`，均不写），且它来自配置（`fromModule` 为 null，否则 `NAME_COLLISION`）、Surge 报告为本地资源（否则 `RESOURCE_MISSING`）；`managed_objects` 写入意图行；原子替换资源文件。**不调用 `updateExternalResource`**（本地资源被跳过，§0）：在 `resourceReloadWait`（缺省 10 秒、每 0.5 秒）内轮询组成员，等待 Surge 自动重新读取。
5. 读回：当前配置名与路径仍是工作配置（否则 `EXTERNAL_PROFILE`）；按引擎运行时长记录发布期间是否发生引擎重启；重新枚举确认同一 key；资源无错误、不在更新中（本地资源没有更新时间，不看它）；时限内成员没有变为清单记 `members_not_reloaded`；SFE-ROUTE 首成员仍为 REJECT，其余成员集合与清单完全相等（数量一致、无重复、无多余或旧成员）；选择等于发布前的选择；`getPolicyDetail` 可用时逐节点核对地址、端口与 underlying-proxy。缺少细节读取时 `readback_level = partial` 并记录未核对字段，界面显示「已部署，读回不完整」。partial 部署只有在 policy_path_reread、targeted_resource_refresh、external_node_underlying_proxy 的 P0 记录覆盖了这些未核对字段时才算“可接受的读回”：此时部署记为 verified、可以激活；否则部署停在 published，相关版本不能激活（汇总状态为 sync_failed，下一步为核验能力）。**重新读取的正面证据**：写入之前先读一次 SFE-ROUTE 的组成员；只有成员从写入前的清单变为期望清单，等待读到的成员才证明 Surge 重新读取了本次写入的文件——名称不变（重新合并后的强制发布、同名替换）时写入前就已一致，第一次读取即“通过”，什么也证明不了。这时只有逐节点读回（`readback_level = full`）直接核对了 Surge 已加载的定义才算证据；都没有（例如只映射了 CLI、`getPolicyDetail` 不可用）时步骤不写“已自动重新读取”，部署不标为 verified（停在 published），重新合并留下的读回要求保留，直到有证据的那一次发布（例如组成员变化的下一次发布）才清除。写入前的组成员读取失败时立即重试（共 3 次），仍读不到则在写入之前失败（不写入没有对照、无法证明的内容，新版本保持待部署）。对照按节点行（去掉带配置代数的首行注释后的摘要）记在引擎键值 `resource:writeBaseline` 中（跨服务重启）：同一组节点行再次发布、文件中已是本应用写入的这组节点行时，沿用第一次写入这组节点行之前读到的成员，而不是这一次写入前读到的——否则那次发布在等待中服务重启（恢复只确认文件）或读回不完整之后，Surge 已加载新节点，之后每次写入前读到的成员都已是期望清单，只有 CLI 的安装再也证明不了重新读取，新版本永远停在 partial。写入其他节点行时换成新的对照，部署被接受（有证据且读回可接受）时清除——只有证据而读回不完整（例如还没有读回覆盖记录）时保留，补上记录之后的发布沿用它证明重新读取并部署；重新合并清除（恢复的文件可能与 Surge 已加载的被篡改内容同名）。
6. 读回不一致 → 用同一路径回滚到上一份“可接受读回”的资源并恢复发布前选择，再读回；回滚失败时活动环境进入 `BLOCKED_NEEDS_ATTENTION`，否则路由 attention。
7. 记录代数与各操作的 `deployed_proxy_revision`；非活动环境在门槛允许时独立预检，否则 inconclusive（「已部署，待激活时由 Safari 实测」）。预检不返回出口 IP（`testPolicy` 不提供），`expected_exit_ip` 只在 Safari 实测时比较。

### 6.3 激活（受控切换）

**受理**：环境已绑定、目标版本已部署（读回可接受）且在组内、汇总状态允许激活、门槛满足、路由不忙。目标与当前活动环境不同、或其他场景在有效期内上报有打开的窗口时，没有 `old_session_policy` → 同步 409 `NEEDS_CONFIRMATION`（含当前环境、其他场景、选项与限制说明）；`confirmed_environment_id` 缺省视为 null（期望没有其他环境在用）。

**执行**：

1. **复用（只读）**：目标环境与版本等于活动环境与版本、路由阶段 active_verified、读回入口为 ACTIVE、选择等于目标节点、无阻断类警告（external_*、rollback_needs_reverify、surge_unreachable、surge_restarted、entry_unverified、takeover_lost、outbound_mode_changed、precedence_violation、front_missing、managed_segments_changed）→ 若最近 Safari 实测为 ok、属于当前 epoch 与活动版本、未过期，且无 probe_failed/exit_ip_mismatch → 直接完成（不递增 epoch、不阻断、不断连；有订单页时定位它）；实测过期或不是 ok → 改为发起 §6.4 重测（不切换）。`takeover_unknown` 与读不到出站模式不阻断，但要求一次新的 Safari 实测。
2. **受控检查**（执行时，写入之前）：活动环境与 `confirmed_environment_id` 不一致 → FAILED（`NEEDS_CONFIRMATION`，details 同 409），不碰路由。Surge 可达；当前配置是工作配置；无 takeover_lost/outbound_mode_changed；优先级检查通过；本应用的入口文件未被外部修改（否则 `BASELINE_CHANGED`，由普通模式改写或经维护流程恢复，§5.5）；前置仍在 `listPolicies` 中（否则 `FRONT_PROXY_MISSING`）；目标节点仍是 SFE-ROUTE 成员（否则 `NODE_NOT_DEPLOYED`）。任一不满足 → FAILED 且不碰路由。例外：本操作经取代接手了等待中激活的过渡状态（路由停在 VERIFY_ONLY 等待、切换中或回滚中，`operation_id` 是本操作、有激活快照）时，第 1–3 步的任何失败都按第 14 步从快照回滚，否则该状态无人负责、也不会超时。
3. **预检**：`independent_node_preflight` 通过时，需要目标版本未过期的 ok 预检（缺失则当场独立预检）→ `PREFLIGHT_OK`（在 SAFARI_BLOCKED 之前）；失败 → `PREFLIGHT_FAILED`，路由、选择、当前环境都不变。不通过时预检推迟到第 8 步之后（见第 8 步）。
4. **活动环境改代理**：在此等待（`WAITING_ROUTE`，status waiting，截止 `profileArrivalTimeoutSec`），直到绑定场景到达（准备页调用 `beginSafariVerification`）；期间旧版本继续使用、Safari 不被阻断。到达后重新执行第 2、3 步检查再继续；截止仍未到达 → 结束为 `READY_FOR_NEXT_OPEN`（下一步「切换到新版本」），路由不变。
5. `route_epoch += 1`，写入激活快照（切换前环境/版本/选择/入口模式/实测/epoch）。快照只在路由回到已确认状态时清除（提交 ACTIVE、回滚成功恢复切换前节点、普通模式完成）；它仍在时（切换进行中被取代，或已中断：对账发现无人负责、回滚无法确认 → attention，以及之后的普通模式失败）沿用其中最初的切换前状态，从不把半途切换写入的未验证选择当作切换前路由，否则之后的回滚会把别的买家出口当作原环境的路由恢复。
6. 入口 → BLOCKED（读回）→ `SAFARI_BLOCKED`；暂停自动打开订单与填充。
7. 结束确认属于 Safari 的连接（按已确认的进程路径过滤，逐条记录 `KillResult`，不清空其他应用）；持久标记（§6.5）中被之后确认的进程归属提议换掉的路径另结束其中可能经买家出口的连接（策略或叶节点是 `SFE-` 对象，或两者都读不到），这些路径上按原规则发出的连接不碰。结束并重新列出确认之后记下（路由载荷 `safariConnectionsEnded`），提交（第 13 步）据此清除普通模式留下的 `buyer_exit_connections_unconfirmed`；没有这一记录（升级前已在进行中的激活）时保留。
8. 选择目标节点并读回。预检推迟时：此时 Safari 已阻断、Chrome 不命中 SFE-ROUTE，经 SFE-ROUTE 执行 `testPolicy`（P0 确认它测试的是当前选择），写入一条预检记录（operation_id、epoch、版本）→ `PREFLIGHT_OK`；失败 → `PREFLIGHT_FAILED` 并进入第 14 步回滚。「不借当前选择组测试」只针对非活动环境的后台预检。
9. 入口 → VERIFY_ONLY（读回）→ `VERIFY_ONLY`，status waiting，路由 `awaiting_safari_verify`。
10. **等待场景到达**（截止 `profileArrivalTimeoutSec`）：从插件发起时场景已在，弹窗立即打开准备页；从网页/菜单/CLI 发起（受控入口）时，由于入口已经阻断，用户之后才打开的场景或恢复的标签页不会经旧出口加载。`open_profile_by_id` 通过前，界面给出「在 Safari 切换到场景 <名称>，点击扩展图标」的引导，不称一键完成；绑定场景的弹窗看到等待中的操作即打开准备页。
11. 准备页 `beginSafariVerification`（来源必须是绑定该环境的场景）→ 记录是否已有 Amazon 标签页 → 签发一次性 `test_id`（绑定操作、环境、场景、epoch、截止 `safariVerifyTimeoutSec`）。签发前重读 SFE-ROUTE 选择（一次 Surge 调用），之后在签发的事务中重读操作与路由：其间操作已结束或被取代（例如受理或开始执行的普通模式结束了等待中的切换）、epoch 变化、或 VERIFY_ONLY 等待的路由已由其他操作接手时不签发（返回该操作的错误，不追加步骤、不写等待截止时间、不安排计时器）。
12. 准备页请求检测地址并 `submitSafariVerification`。服务核对：test_id 未用、epoch 未变、来源场景正确、未超时；签发前与提交后重读 SFE-ROUTE 选择都等于目标节点；在 Surge 最近请求中找到同一时间窗、Safari 进程路径、检测主机、命中 verify 规则、经 SFE-ROUTE（能读到叶节点时等于目标节点）的新连接；有预期出口时必须一致。
13. 通过 → 重新读取基础事实并检查激活门槛（等待期间能力可能被重置或因版本变化过期；缺失 → `CAPABILITY_UNVERIFIED`，按第 14 步回滚，不写 ACTIVE）→ 入口 → ACTIVE（读回）→ 提交活动版本、`last_verified_proxy_revision`、实测 → `ACTIVE_VERIFIED`；提交按设计清除失控类警告，随后立即做一次只读对账，让仍然成立的事实类警告（例如 `managed_segments_changed`）马上重新出现。附加警告：`launch_unverified`（发起或开始实测时场景已有 Amazon 标签页；只有之后一次上报无 Amazon 标签页的受控激活才清除）、`launch_order_unverified`（first_request_and_old_connections 未通过时每次 ACTIVE_VERIFIED 都带）、`old_session_unproven`（跨环境切换且该能力未通过，即使用户确认已关闭）、`old_windows_kept_open`（选择不关闭）。
14. **失败/超时/取消 → `ROLLING_BACK`**：有切换前的已验证路由时，恢复其节点选择并读回，入口保持 BLOCKED，路由阶段 failed，`active_environment_id/active_proxy_revision` 为恢复后的实际值，警告 `rollback_needs_reverify`；结果为 `RollbackResult`（旧版本、旧实测显示为「上次结果」、新版本失败原因）。恢复后的原环境 facets.route 为 rolled_back（汇总 needs_reverify，下一步「重新核验」）；失败的目标环境保持其已部署版本与错误（下一步视其状态）。重新核验由用户发起：激活原环境与原版本，照常执行旧窗口确认（失败的目标场景可能已打开，会被列出），走 BLOCKED → VERIFY_ONLY → 实测 → ACTIVE。原来是 NORMAL 时保持 BLOCKED 并失败。取消与超时只记下请求本身（「已取消切换」「Safari 实测超时…」）与「开始回滚：尝试回到阻断并恢复切换前的节点（回到阻断无法确认时不恢复，SFE-ROUTE 改选 REJECT，并要求处理）」，不预先声称结果；网页后台（路由卡、取消确认、等待场景的提示、设置中的超时说明）与弹窗的取消确认同样只说「尝试恢复…；无法确认时不恢复，改选 REJECT 并要求处理」。取消按钮、确认与说明按操作所处的阶段与种类写明后果（网页与弹窗相同：取消切换、取消等待、取消重测）：活动环境发布只有停在 `WAITING_ROUTE` 时才说「新版本保持已部署，当前出口不变，下次打开时再切换」（弹窗按原生桥 `getCurrentState` 的 `pendingVerification.waiting_route` 判断，不按 `kind`），进入切换后的 VERIFY_ONLY 等待与激活相同；Safari 重测（含第 1 步复用时改为重测的激活，§6.4）只结束检测、路由不变。切换与回滚只按最后经运行时求值确认的入口状态决定（入口错误带 `runtimeConfirmed: false` 时按 UNKNOWN，§5.5）。失败时最后确认的入口已是阻断（例如第 6 步之后结束连接、选择或推迟的预检失败，第 9 步写入 VERIFY_ONLY 之前的检查失败）时，回滚恢复切换前的节点之前重新读回入口：只有仍是经运行时求值确认、没有规则排在入口之前的阻断才跳过回到阻断；读回失败、不是阻断、未经运行时确认，或有规则排在了入口之前（切换期间用户启用或模块自动更新、其他工具 `rule temp add`）时，与从 VERIFY_ONLY 出发一样按撤销入口回到阻断，由它的最终读回如实报告（下面只因有规则排在入口之前的 `PRECEDENCE_VIOLATION`、未经运行时求值确认的回到阻断），步骤写明重新读回的结果，不声称 Safari 保持阻断、不恢复切换前的节点。回滚写入失败或读回无法判定 → `BLOCKED_NEEDS_ATTENTION`（说明只写读回确认过的入口状态）；回到阻断的最终读回只因有规则排在本应用入口之前而不能确认（`PRECEDENCE_VIOLATION`，入口位已读回为阻断）时不声称 Safari 保持阻断：说明写明有几条规则排在入口之前（操作结果 `precedenceIssues`，脱敏）、被它们匹配的 Safari 请求按它们发出（可能直连），路由带 `precedence_violation` 与 `entry_unverified`；这些规则也可能把 Safari 请求交给 SFE-ROUTE，而它选着本次切换写入的未验证节点，所以同样按下面的规则改选 REJECT；最后经运行时求值确认的不是阻断或普通模式时（回到阻断失败或超时——例如 rule match 可用而文件监视比上限慢、收紧的一步保留新内容但没有加载；入口控制器不可用；退路中只因有规则排在入口之前而报告的 `PRECEDENCE_VIOLATION` 带 `runtimeConfirmed: false`，记下的阻断位不算确认；temp_rule 中只按结构读回的阻断位同样带 `runtimeConfirmed: false`，例如回到阻断的前几步容忍了 rule match 读不到、之后一步写入超时），Surge 可能仍加载着 VERIFY_ONLY/ACTIVE 而 SFE-ROUTE 选着本次切换写入的未验证节点：失败即关闭，SFE-ROUTE 尽力改选首成员 REJECT 并读回（改选失败从不越过回滚的失败处理），只有读回确认才把选择记为 REJECT（操作错误 `details.rejectSelected`），说明如实写明是否确认、未确认时 Safari 请求（至少检测主机）可能仍经当前选择的买家出口发出；改选只影响新连接（选择组在建立连接时生效）：已建立的 Safari 连接（检测主机的 keep-alive、ACTIVE 期间的站点长连接）仍在原来的出口上，这些路径不结束连接——在同一事务中补上持久标记（§6.5）并带 `buyer_exit_connections_unconfirmed`，说明写明，由普通模式结束（之后的激活第 7 步在已确认的阻断下结束全部 Safari 连接时同样清除）；不恢复切换前的节点，激活快照保留，入口记为最后经运行时确认的状态（未知为 UNKNOWN）并带 `entry_unverified`。回滚的失败处理在提交事务中重读路由、只在其上合并警告（改选 REJECT 的 Surge 调用期间受理处理器可能已改过警告：确认旧窗口已关闭、预期出口重新比较），成功回滚保留的警告同样按事务中的重读计算。这些路径（含下面未经运行时确认的回到阻断与执行器兜底）去掉之前一次成功回滚留下的 `rollback_needs_reverify`：之后又开始了切换、这次没有恢复节点，「已恢复原节点并保持阻断」不再成立，环境视图改为「路由状态需要处理」。回到 BLOCKED 未经运行时求值确认（`runtimeConfirmed: false`：rule match 读不到；ruleset_resource 的退路只是写入并等满文件监视上限，监视比上限慢时 Surge 仍加载着写入之前的入口——VERIFY_ONLY/ACTIVE，或切换前的普通模式）时不声称 Safari 保持阻断，也不恢复切换前的节点（仍加载的 VERIFY_ONLY/ACTIVE 会让 Safari 至少检测主机经之前买家的出口发出）：SFE-ROUTE 改选首成员 REJECT 并读回（不论 Surge 加载的是哪一版本应用入口，经 SFE-ROUTE 的 Safari 新连接都被拒绝；已建立的连接同上带 `buyer_exit_connections_unconfirmed`），激活快照保留，路由 attention、入口记为 UNKNOWN（文件已写入阻断，Surge 加载的是哪一版未知；不记为 BLOCKED，之后的激活失败时才不会把它当作已确认的阻断、跳过回到阻断就恢复切换前的节点）并带 `entry_unverified`，操作 `BLOCKED_NEEDS_ATTENTION`，说明按入口策略写明还剩什么不确定：ruleset_resource 是 Surge 可能仍加载着写入之前的入口（之前是普通模式时 Safari 仍按原规则发出）；temp_rule 没有加载延迟，阻断规则已按 Surge 的临时规则列表与有效规则顺序读回，只是 Surge 实际如何匹配 Safari 请求未经 rule match 求值确认；改选 REJECT 失败或读回不一致时同样不抛出、不记为 REJECT，说明写明 Safari 请求可能仍经 SFE-ROUTE 当前选择的买家出口发出；由用户进入普通模式，或等 rule match 可用后重新使用环境。`BLOCKED_NEEDS_ATTENTION` 的阶段名称显示为「未能确认，需要处理」，不声称已阻断。路由处理器的意外异常（例如数据库错误）越过了它自己的回滚或失败处理、而本操作仍负责过渡中的路由（切换中、VERIFY_ONLY 等待、回滚中）时，执行器的分派兜底（`dispatch.ts` → `settleAbandonedTransition`）按同一规则失败即关闭：选择不是使用中环境已验证的出口时（按读回判断，见 §6.5）尽力改选 REJECT 并读回，路由 attention、入口 UNKNOWN 并带 `entry_unverified`，操作 `BLOCKED_NEEDS_ATTENTION`——否则执行器只把操作标为失败，路由无人负责，而对账从不写 Surge（§6.6）。**从不回退到 NORMAL、DIRECT 或其他买家出口。**
15. 用户可通过 `proxy_revision` 指定返回该环境的 `last_verified` 版本（例如 r18 失败后回到 r17）；r18 保持已部署，编辑内容保留以便修正。
16. **预期出口修改**：活动环境的预期出口被修改时立即与最近一次 ok 的 Safari 实测比较，不符 → `exit_ip_mismatch`，停止自动打开与填充，不切换。

### 6.4 当前环境的 Safari 重测（`probe.safari`）

只允许针对当前 epoch 中 ACTIVE_VERIFIED 的活动环境，且读回入口为 ACTIVE、无失控类警告（surge_unreachable、surge_restarted、entry_unverified、takeover_lost、outbound_mode_changed、external_*、precedence_violation）：不改入口、不改选择、不断连、不递增 epoch。签发 test_id → 绑定场景准备页检测 → 服务按 §6.3.12 核对（命中 active 规则而非 verify 规则；ACTIVE 下连接复用对“新连接”判断的影响由 P0 确认）。成功更新实测与有效期并清除 `probe_expired`；失败/不符 → 记录、加 `probe_failed`/`exit_ip_mismatch`、停止填充与自动打开，从不自动切换、阻断或进入 NORMAL。超时或取消只把本次重测结束为 FAILED，路由不变；网页的等待说明、路由卡的取消说明、取消按钮（「取消重测」）与取消确认按操作写明这一点，只有切换（激活、活动环境发布进入切换后的 VERIFY_ONLY 等待）才说超时或取消会尝试恢复原节点并保持阻断（§6.3 第 14 步）。是否是重测按操作的 `probeKind`（`safari`）判断，不只看 `kind`：第 1 步复用时改为重测的激活仍是 `route.activate`（`flow: probe`），超时与取消同样只结束检测。实测过期的触发：TTL、对账发现 Surge 重启/配置重载/外部修改、前置状态变化、本机网络变化（主接口或地址变化）。

### 6.5 普通模式

显式操作，任何已识别场景（含未绑定场景）都可发起。有托管环境时需要旧窗口确认（`managed_environment_active`）；执行时活动环境换成了与 `confirmed_environment_id`（缺省 null）不同的另一个环境 → FAILED 并要求重新确认，不碰路由（已没有活动环境时不需要确认，照常执行）。路由操作排队或执行中时照常受理、排在其后（§6.1 并发矩阵），从不返回 `ROUTE_BUSY`。中间阻断未经运行时求值确认（rule match 不可用的退路）时路由记录的入口为 UNKNOWN，不记为 BLOCKED（之后失败或之后的激活会把记下的 BLOCKED 当作已确认）；之后撤销入口失败时，错误带回的阻断位（temp_rule 起点只按临时规则列表与有效规则顺序读出）同样不把它升级为 BLOCKED，仍记为 UNKNOWN（随之按下面的规则改选 REJECT）。普通模式失败、入口记为 UNKNOWN 时路由带 `entry_unverified`（与回滚无法确认相同）。操作阶段 `SAFARI_BLOCKED`（界面显示「Safari 已阻断」/「Safari 已暂时阻断」）只用于读回确认、没有规则排在入口之前的中间阻断；未经运行时求值确认或有规则排在入口之前时停在当前阶段（VALIDATING），只记一步，不声称已阻断。未经运行时求值确认的步骤与完成说明按入口策略写明还剩什么不确定（ruleset_resource：Surge 可能仍加载着写入之前的入口；temp_rule：临时规则已按列表与有效规则顺序读回，只是 Surge 实际如何匹配未经 rule match 确认）。流程：（ruleset_resource 时先检查自动重载设置）入口 → BLOCKED（有规则排在入口之前时，入口位已确认为 BLOCKED 即继续，结果记录这些规则；入口已是 NORMAL——Surge 中没有本应用的入口规则——时不写入）→ 结束 Safari 连接（门槛不满足时尽力而为；列出或结束连接失败只把 `killError` 与逐条结果记入操作结果并报告，不中止；入口已是 NORMAL 时（中间阻断不写入而返回 NORMAL，或开始时的读回已是 NORMAL）照样结束：没有本应用规则不能证明 Surge 重启过，临时规则也可能在 Surge 运行中被 `rule temp remove`/`rule temp flush` 移除，之前经 SFE-ROUTE 建立的 Safari 长连接仍在买家出口上，之前一次失败的切换或崩溃也可能已按事实确认归属而没有结束连接，控制器已看不到本应用记录——只要 Safari 可能有经 SFE-ROUTE 的连接：路由记录不是空闲的普通模式（入口不是 NORMAL 或阶段不是 idle，例如回滚失败时按入口切换报告的最后确认状态记为 NORMAL、阶段为 attention）、仍有使用中的环境或激活快照，或持久标记（引擎键值 `route:safariMayUseRoute`，`service/src/engine/safari-route-marker.ts`；激活写入 VERIFY_ONLY/ACTIVE 之前设置，只在普通模式确认结束了全部 Safari 连接、且结束前后的入口——阻断或已是普通模式，以及之后的 NORMAL——都经运行时求值确认之后清除。未能确认结束，或入口未经运行时确认（rule match 不可用的退路：文件监视比上限慢时 Surge 可能仍加载着写前的入口，Safari 在结束之后又经 SFE-ROUTE 建立连接；退路中因有规则排在入口之前而报告的 PRECEDENCE_VIOLATION 同样带 `runtimeConfirmed: false`）时保留，路由状态带 `buyer_exit_connections_unconfirmed`（「未能确认 Safari 已没有经买家出口的连接，再次进入普通模式会再结束其中可能经买家出口的连接（按原规则发出的不受影响）」；路由已是空闲的普通模式时网页后台的顶栏与路由卡、扩展弹窗的任何已识别场景仍提供「进入普通模式」），完成说明写明原因，下一次普通模式再结束；rule match 不可用期间因此每次普通模式都结束 Safari 可能经买家出口的连接，即失败即关闭）仍在；都不成立时不结束（步骤写明没有 Safari 可能经 SFE-ROUTE 的记录，不声称之前的连接已确认结束），Safari 的连接已按原规则发出。标记同时记下设置以来配置过的 Safari 进程路径；标记仍在或路由记录表明 Safari 可能经 SFE-ROUTE 时确认的进程归属提议换掉路径，被换掉的路径并入标记，之后的普通模式另按它们结束其中可能经买家出口的连接（策略或叶节点是 `SFE-` 对象，或两者都读不到），这些路径上按原规则发出的连接不碰（按新的确认它们不再是配置的 Safari 进程）。入口不确定阻断 Safari 时（入口已是 NORMAL、保留的 block 关闭尚未加载、有规则排在入口之前，或阻断未经运行时求值确认——rule match 不可用的退路只是写入并等满文件监视上限，监视比上限慢时 Surge 仍加载着写前的入口，Safari 仍按原规则发出），只结束、只核对配置路径上可能经买家出口的连接（策略或叶节点是 `SFE-` 对象，或两者都读不到）：已按原规则发出的 Safari 连接不在买家出口上，不结束（否则 rule match 不可用、警告一直不能清除时，每次重试普通模式都会结束 Safari 全部按原规则发出的连接）；结束之后 Safari 按原规则立即重连是预期的，不算失败。入口已确认阻断时结束配置路径上的全部 Safari 连接，任何新连接都记为未能结束。“入口已是 NORMAL”的步骤按入口策略写明依据：temp_rule 是 Surge 中没有本应用的入口规则，ruleset_resource 是四条 RULE-SET 仍在、入口文件已全部为占位规则并经见证与探测读回确认已加载（旧格式文件没有见证规则时注明只由运行时探测确认、未经见证确认，读回 `witnessConfirmed: false`；rule match 不可用时注明只按文件内容判断、未经运行时确认））→ NORMAL（读回）→ 清空活动环境 → `NORMAL_RESTORED`。被外部修改的本应用入口文件按 §5.5 改写（操作结果记 `changedEntryFiles` 并有一步说明），temp_rule 下本应用记录的临时规则重复、无法识别或不在有效规则中（例如进程路径变化后旧文本的记录仍在）时，→ BLOCKED 与 → NORMAL 按 §5.5 逐条清理本应用记录的规则（不需要重启 Surge，不碰用户临时规则；每条加入或移除记一步并记入操作结果 `entryCleanup`，回滚同样；当前配置的 block 规则不在有效规则中时无法确认阻断，停止并报告），`managed_segments_changed` 保留，之后空闲时对账检查到受管理段与本应用文件已一致即清除（§6.6）。普通模式不改变 SFE-ROUTE 的选择（入口关闭后它不再被 Safari 使用），例外是失败即关闭的两种情形：收紧（verify/active 关闭）未经运行时求值确认、而 Safari 可能经 SFE-ROUTE（中间阻断或“入口已是普通模式”的读回 `runtimeConfirmed: false`）时，完成后没有使用中的环境，而还剩的不确定按入口策略不同（ruleset_resource：Surge 加载撤销之前仍可能加载着检测或使用中入口；temp_rule：没有加载阶段，临时规则已按列表与有效规则顺序读回，只是 Surge 实际如何匹配 Safari 请求未经 rule match 确认，说明不声称加载延迟）——SFE-ROUTE 尽力改选 REJECT 并读回，完成说明按入口策略写明是否确认（操作结果 `rejectSelected`）；普通模式失败、最后经运行时求值确认的不是阻断或普通模式、且选择不是使用中环境已验证的出口（激活快照仍在，或没有使用中的环境：例如接手了被取代的切换）时同样尽力改选 REJECT（选择就是使用中环境已验证的出口时不改，Safari 停在原来已验证的路由上）。是否“就是已验证的出口”按读回判断：路由记录的选择等于活动版本的节点、没有 `external_selection_change`，且 `getGroupSelection` 读回也等于它，读不到按不是——选择可能在记录之外被改成别的买家节点（用户在 Surge 中改选、发布回滚无法确认选择），对账只加警告、不改记录。失败步骤只在入口确认阻断或已是普通模式、或选择读回就是已验证的出口时写「未回退到其他出口」，否则写明改选 REJECT 的结果。中间阻断时有规则排在入口之前、普通模式又没有完成（最后确认的不是普通模式）时，记下的阻断只是入口位：路由带 `precedence_violation` 与 `entry_unverified`，选择不是使用中环境已验证的出口时同样改选 REJECT（排在入口之前的规则可能把 Safari 请求交给 SFE-ROUTE）。改选都从不抛出，只有读回确认才记为 REJECT。不修改其他任何东西，不删除用户临时规则。选择「不关闭」时保留 `managed_windows_on_original_rules` 警告（「旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）」），直到用户通过 `acknowledgeWindows` 确认已关闭或下一次激活完成（`acknowledgeWindows` 不等待路由操作：之后的普通模式完成时按提交事务中重读的路由保留这一警告，不按开始时读到的路由把执行期间已确认的警告加回）；`old_windows_kept_open` 同理。

是否提供「进入普通模式」由服务端判定（`RouteStateView.normalModeOffered` 与 `RouteSummaryView.normalModeOffered`，`service/src/engine/safari-route-marker.ts` 的 `normalModeOffered`）：与上面是否结束 Safari 连接同一判断（入口不是 NORMAL、阶段不是 idle、仍有使用中的环境或激活快照、持久标记仍在），另含 `buyer_exit_connections_unconfirmed`。只看入口模式、活动环境与警告不够：回滚失败可能把入口记为 NORMAL（阶段 attention、快照保留），普通模式在结束连接失败之后撤销入口的读回也可能失败，路由记录看起来已是普通模式而 Safari 的连接仍在买家出口上（对账不处理空闲的普通模式）。网页后台的顶栏与路由卡、扩展弹窗的已绑定与未绑定场景都按它提供；未绑定场景在没有使用中的环境时说明原因（例如第一次激活被取消、没有切换前的环境，停在阻断），入口记为普通模式而仍提供时，弹窗顶栏与路由卡不显示为单纯的「普通模式」。未识别场景不能发起普通模式（§7.2），弹窗只显示同样的状态（另一个环境正在使用、`buyer_exit_connections_unconfirmed`、路由没有回到已确认的普通模式）并指向网页后台或已命名场景的弹窗。普通模式失败时按完成时的同一规则处理持久标记：Safari 可能经 SFE-ROUTE、而本次没有在经运行时求值确认的入口下确认结束全部 Safari 连接时，保留（没有时补上）标记并带 `buyer_exit_connections_unconfirmed`，失败步骤写明；失败路径从不清除标记。

### 6.6 对账与“受控”

- **启动**：读数据库未完成操作 → 读 Surge 事实（可达性检测（§5.2）、版本构建、当前配置、受管理段与资源摘要、入口位/临时规则、组选择、接管与出站、自动重载）→ 按 `managed_objects` 意图行与事实判断每步是否已生效，从下一步继续或回滚；不重放全部写。路由操作按路由阶段与 epoch 判断（操作阶段在切换中可能仍是 PREFLIGHT_OK，不能用来判断）：尚未递增 epoch 的（pending/arrived）重新执行检查；已递增的（切换中、VERIFY_ONLY 之后的核对、回滚中）先读入口事实再按激活快照回滚；经取代接手了过渡中路由的激活（`operation_id` 是本操作、阶段 switching/awaiting_safari_verify/rolling_back、有激活快照）或操作阶段已是 `ROLLING_BACK` 的，即使自己的 epoch 仍为空、stage 仍是 pending，也按快照回滚，从不把已开始的回滚重放成切换；Safari 重测不写入，重新执行。等待中的操作未超时则继续等待，已超时按 §6.3.14。
- **周期**：路由阶段不是 idle 或入口不是 NORMAL 时，每 `reconcileIntervalSec`（默认 30 秒）只读对账一次（作为执行器的内部任务，路由/发布写入进行中时延后）；读取版本构建、当前配置、受管理段与本应用文件摘要及位置、入口位、组选择、可达性、接管与出站、已登记前置是否仍存在。不一致：选择或配置被改 → 阶段 `external_change` + `external_selection_change`/`external_profile_change`；受管理段或本应用文件被改 → 阶段 attention + `managed_segments_changed`（停止同步，从不自动修复）；入口位丢失（例如 Surge 重启后临时规则消失）→ 入口 UNKNOWN + 阶段 attention + `entry_unverified`/`surge_restarted`；不可达（§5.2 的检测读取没有解析成功，包括命令失败、交互模式提示与输出无法识别，不只是连接失败）→ 阶段 attention + `surge_unreachable`，不再读取或比较其他 Surge 事实；接管关闭或出站非规则 → 阶段 attention + `takeover_lost`/`outbound_mode_changed`；读不到接管状态 → `takeover_unknown`（不阻断，但要求新的 Safari 实测）；优先级被抢先 → 阶段 attention + `precedence_violation`；前置消失 → 前置状态 missing、依赖环境不能激活、活动环境实测过期 + `front_missing`；Safari/macOS/Surge 版本变化或进程路径不存在 → 能力过期 + `entry_unverified`；路由停在 switching/rolling_back 而负责它的操作已不在执行或排队（例如崩溃恢复失败），或停在 awaiting_safari_verify 而负责它的操作已不在执行、排队或等待（例如核对中的意外异常只把操作标为失败）→ 入口按读回记录（与记录不一致或读不到为 UNKNOWN）+ 阶段 attention + `entry_unverified`、活动实测过期、清除等待截止时间，不写 Surge；激活快照保留，下一次激活沿用其中的切换前状态作为回滚目标（§6.3 第 5 步）；负责操作的状态与路由状态同步读取，读取 Surge 期间才结束的过渡不算中断。对账因此不改选 REJECT：无人负责的过渡只来自处理器没有结算就结束——处理器的意外异常由执行器的分派兜底按 §6.3 第 14 步失败即关闭（改选 REJECT，之后路由已是 attention、不再由负责的操作持有），服务崩溃由启动恢复按快照回滚；只剩兜底本身也失败（例如数据库不可写）的情形，路由 attention 并提供普通模式。awaiting_safari_verify 不跳过选择与入口不一致检查（提交 ACTIVE 之后出错由入口不一致检查发现）。对账在提交事务中重读路由、只合并本次新增的警告，阶段与入口只在仍是读取开始时的值时才改（读取期间受理与原生桥处理器可能已改过警告，例如 `exit_ip_mismatch`、确认窗口已关闭）。空闲且入口为 NORMAL 时（启动、刷新、动作前对账；周期对账不运行）只清除一种警告：受管理段与本应用文件检查已一致时清除撤销入口时保留的 `managed_segments_changed`（例如普通模式已改写入口文件、`maintenance.remerge` 已恢复受管理段）；托管状态下它是粘性的，由下一次激活清除。对账只发布 `route.updated`/`surge.status`，**从不写 Surge、从不抢回控制**，恢复需要用户显式激活或进入普通模式。
- **动作前**：`requestLoginFill`、自动打开订单、激活复用之前，同步做一次短超时对账；失败即拒绝。弹窗与准备页的订单判定（`getCurrentState`）可复用 5 秒内完成的任何对账（§7.2），也可共用进行中的动作前对账；填充不复用，也不共用请求到达之前已开始读 Surge 的对账（它可能在出站模式、接管等改变之前就读过它们）——等它结束后再对账一次（同时到达的填充共用这一次），总时限内没有完成即拒绝；判定本身总按返回时的路由记录与实测重新计算，检查返回之后再读一次（填充同样在对账之后重新判定）。
- **“受控”的定义**（复用、填充、自动打开订单共用一条规则）：Surge 可达（§5.2 的检测读取成功）；当前配置是工作配置；入口读回为 ACTIVE；选择等于活动节点；无 takeover_lost、outbound_mode_changed、external_*、surge_unreachable、surge_restarted、precedence_violation、entry_unverified、front_missing、managed_segments_changed、probe_failed、exit_ip_mismatch 警告；最近 Safari 实测 ok、属于当前 epoch 与活动版本、未过期。`takeover_unknown` 与读不到出站模式不破坏“受控”，但只在新的 Safari 实测（有效期内）证明 Surge 看到了 Safari 连接时成立。

### 6.7 删除、解除绑定与清理

正在使用或正在验证的环境：删除/解除绑定返回 409 `ENVIRONMENT_ACTIVE`（请先进入普通模式；没有请求内确认），从不隐式改路由。否则作为排队操作执行：解除绑定只删映射（从不删除 Safari 场景、Cookie 或登录资料）；删除还设置 `deleted_at`、版本标为 superseded、删除账号密码钥匙串项。入口为 NORMAL 且 SFE-ROUTE 仍选着该环境的节点时，执行器先把选择改为 REJECT 并读回（此时 Safari 不经 SFE-ROUTE，安全），使节点满足移除条件。节点移除由之后的发布（同一发布门槛）在满足 §5.4 移除条件时合批完成；代理秘密在版本 retired 后回收。

### 6.8 前置代理

登记：只接受 `listPolicies` 中的用户代理节点（不接受组、DIRECT/REJECT 等内置策略、`SFE-` 节点）。`frontProxyId = null` 在保存时解析为当时的默认值并存为具体 id。更换前置（`front.replace`）：预览列出依赖环境与版本 → 提交时每个环境按自己的 expected_revision 生成新版本（冲突逐个报告不影响其他）→ 一次发布 → 活动环境走 §6.3。核验前置（`front.verify`）：检查节点仍存在并在门槛允许时对依赖环境重新预检、把活动环境实测标为过期。

### 6.9 汇总状态与下一步

`deriveReadiness`（contract/readiness.ts）按固定优先级：invalid → active（实测过期时下一步为重测）→ activating（含等待场景、等待切换新版本）→ needs_reverify → 无可用版本时 sync_failed → proxy_unavailable → needs_binding → deploying → waiting_deployment → ready / deployed_unverified。有可用版本时，待部署的新版本只作为附加下一步。只有 ready、deployed_unverified、active、needs_reverify 允许发起激活。

### 6.10 订单页与登录填充

- 「打开或定位订单页」只在当前场景是活动环境且路由“受控”时可用；带 `launch_unverified`/`launch_order_unverified` 时可用但显示警告。否则按钮执行受控入口（激活）并在新的空白标签页打开准备页；从不在 NORMAL 或实测前导航到 Amazon。已登录直接显示订单页，不进入登录流程。已绑定场景不是活动环境却有 Amazon 标签页时，弹窗显示「本场景的 Amazon 页面未经启动验证，正按当前路由规则发送请求」。
- 填充：内容脚本只在顶层框架的登录页、页面实际出现对应字段时请求；后台用 `sender` 填 `top_url`/`frame_is_top`（Safari 没有提供 `sender.id`、`sender.frameId` 或 `sender.tab.url` 时直接拒绝，不采用内容脚本自报的值），用一次新的 `getCurrentState` 填 `route_epoch`；服务要求登录页分类、表单目标同源 HTTPS、环境开启填充、请求场景绑定的正是活动环境、路由“受控”、`route_epoch` 一致、账号属于该环境，以及 `fillAndAutoOpen` 门槛；返回页面实际出现的每个字段（账号直接给值，密码给一次性钥匙串引用）。内容脚本在写入前重读 `form.action`，变化即丢弃；每页每字段最多一次；从不提交、不处理验证码或二次验证；字段识别失败时先经后台 `checkLoginFill` 确认本场景适用填充（已绑定、该站点登录页、开启填充、是活动环境；只回答是否适用，不取值），适用才显示「可手动填充」，未绑定、未识别、未开启填充或无法确认时页面上不显示任何东西；不猜提交按钮；提供「返回订单」按钮（只导航一次）。
- 页面登录身份首版始终为「未核对」；修改账号后显示「配置账号已更换，网页登录状态未核对」，由用户确认后清除。

### 6.11 服务停止

服务停止、崩溃恢复、LaunchAgent 卸载、服务卸载**都不改变入口状态或 SFE-ROUTE 选择**。撤销本应用的规则是单独的、用户执行的、有文档的步骤（先进入普通模式，再按 docs/INSTALL.md 移除受管理段）。

## 7. 接口

### 7.1 HTTP（网页）

- 只监听 `127.0.0.1`；Host 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`；`/api` 有 Origin 时必须同源，拒绝 `Origin: null`；不发任何 CORS 头。
- 登录：宿主 App（`NSWorkspace.open`）或 `sfe open`（写 0600 `.webloc` 到 0700 数据目录后 `/usr/bin/open <文件>`，再删除）打开 `http://127.0.0.1:<port>/auth/exchange?code=…`。登录码 ≥128 位、60 秒、单次、只存哈希；只有 HTTP 已绑定时才签发并返回实际地址；交换端点限速。交换页 no-store，由同源静态脚本读取 meta 中的会话令牌存入 localStorage 后 `location.replace('/')`，地址栏不保留登录码。
- 会话：绝对有效期 12 小时、空闲 2 小时；登出或过期时关闭事件流。所有 `/api` 请求（含 GET 与事件流）都要 `Authorization: Bearer`；没有 Cookie。
- 事件流：`fetch` 流式读取（可带请求头），`id:` 为序号，支持 `Last-Event-ID`；缓冲 1000 条，超出发 `snapshot.required`；15 秒心跳。
- 响应头：`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、CSP `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'`。
- 不记录请求或响应体，只记路由、id、结果与错误码。

### 7.2 原生桥（插件）

见 `contract/native.ts`。服务按 `NATIVE_PERMISSIONS` 矩阵强制：未识别场景（原生桥没有拿到 `SFExtensionProfileKey`；默认场景可能就是这样，见 §0「Apple 官方文档核对的架构风险」第 4 条）只允许 `getCurrentState`（不返回其他环境名称，但照常返回路由关系与摘要，弹窗据此显示状态）与 `reportProfileState`（记入所有未识别场景共用的一条记录，只用于旧窗口确认的「其他场景有打开的窗口」）；针对环境的请求携带 `environment_id`，与场景绑定比对不一致 → `BINDING_MISMATCH`（在版本检查与创建操作之前）；`getOperation` 只返回自己环境或自己发起的操作，否则 `NOT_FOUND`；非活动环境的场景只拿到路由摘要（不含实测、选择、操作 id；警告只有 `buyerExitConnectionsUnconfirmed`——路由带 `buyer_exit_connections_unconfirmed` 时为 true，路由即使已是空闲的普通模式，弹窗也显示该警告并提供「进入普通模式」；另有服务端判定的 `normalModeOffered`，弹窗按它提供「进入普通模式」，§6.5）。路由不是空闲的普通模式时，`getCurrentState` 不论来自哪个场景（含其他环境的场景与未识别场景，它们的弹窗顶栏同样按摘要显示）都先做动作前检查，再读路由：有效期（5 秒）内完成过对账（任何来源：动作前、周期、刷新、提交 ACTIVE 之后的对账，按路由记录的 `lastReconciledAt`）时不再读 Surge，否则在执行器空闲时短超时对账一次（可能改写路由，例如 Surge 重启之后；并发的检查共用进行中的那一次）。同一响应中的路由摘要、完整路由、环境视图、关系与订单判定都来自检查之后的同一次读取：`ordersAllowed` 按这次读到的路由与实测重新判定“受控”（§6.6，不读 Surge），从不沿用检查时或之前的判定——检查之后周期对账、刷新或路由操作可能已把路由标为 attention。检查没有完成对账（执行器正忙、读取 Surge 超时或失败；这些结果不缓存）时 `ordersAllowed` 为 false，路由摘要 `reconciled: false`，弹窗顶栏显示「正在确认入口状态」，不按记录的入口声称托管中、已阻断或只允许检测。路由是空闲的普通模式时不检查、不读 Surge（`reconciled: true`）。扩展从不在启动、窗口/标签页创建、焦点或心跳事件中发送激活或普通模式请求，只在用户点击时发送；`reportProfileState` 在弹窗打开、窗口与标签页创建/关闭时由后台发送（未识别场景同样发送），超过 10 分钟的上报不再计入“有打开的窗口”；只作提示，从不改变路由。帧格式 NDJSON，单条 ≤256 KiB。

原生桥 ↔ 服务的一个连接（`BridgeHello` / `BridgeChallenge` / `BridgeRequest`，实现见 `service/src/ipc/bridge-server.ts` 与 `apps/macos/Shared/BridgeHandshake.swift`）。传输令牌从不上线路，HMAC 密钥是令牌的 UTF-8 字节，随机数 32 字节，证明为小写十六进制：

1. 原生桥 → `{ v, type: "hello", clientNonce }`；
2. 服务 → `{ v, type: "challenge", serverNonce, serverProof }`，`serverProof = HMAC(令牌, "sfe-bridge-server\n" + clientNonce + "\n" + serverNonce)`；服务未配置令牌时不回应、直接断开；
3. 原生桥用恒定时间比较验证 `serverProof`，不符即断开且**不发送任何请求内容**；通过后 → `{ v, type: "request", clientProof, payload }`，`payload` 是 `{ bridge, message }` 的 JSON 文本，`clientProof = HMAC(令牌, "sfe-bridge-client\n" + serverNonce + "\n" + clientNonce + "\n" + SHA-256(payload))`（按 payload 原始字节计算，不需要跨语言规范化 JSON）；
4. 服务用 `timingSafeEqual` 验证 `clientProof`，再按原规则校验信封（版本、场景 ID、`bridgeVersion` 为可见 ASCII 且不含空格，原生桥发送 `<短版本>+<构建号>`，例如 `0.1.0+1`；消息类型）并回复一行 `NativeResponse` 后关闭。

握手（从连接建立到收完 request）限时 3 秒；hello 格式不对、服务随机数与客户端随机数相同、request 证明不符（含重放旧连接的 request、同一连接再发 hello）、超时，一律直接断开，不说明是哪一项不符，日志只记阶段。

### 7.3 本机套接字（CLI/GPT/宿主 App）

见 `contract/admin.ts`。`agent.sock`（受限，`sfe` 默认）与 `maintenance.sock`（宿主 App 与 `sfe admin`）。agent 输出中的登录账号一律打码，不提供账号明文、登录码、设置修改、前置登记；能力只能提议。携带秘密的命令只能从 stdin 读 JSON，命令行参数中出现秘密字段时 CLI 拒绝执行。受控入口 `sfe env open <environment_id>` 即激活操作。

## 8. 网页后台（apps/web）

Vue 3 + Vite + vue-router（hash 路由）。样式只用 EasyQuick UI（`@sfe/easyquick`：tokens.css、easyquick.css、Tailwind 预设生成的工具类），图标为设计系统 Icons 组的 Heroicons outline 内联 SVG；严格按 `tools/design/easyquick/reference` 的组件结构与文案规范。

页面：概览（统计卡、当前路由卡含全部警告、Surge 状态含接管与优先级问题、能力门槛摘要、最近操作）；环境（DataTable：环境、绑定、代理连接地址、前置、期望/已部署/活动版本、实际出口与时间、状态、操作；筛选；编辑弹窗按 SecretChange 语义；激活/普通模式/删除确认弹窗含旧窗口选项与限制说明；“打开环境”受控入口与引导）；场景关联向导；导入（上传 → 预览差异与冲突 → 逐行决定 → 提交）；发布与 Surge（工作配置、代数、待部署、读回级别、前置代理与更换、初始化与重新合并向导）；能力门槛（记录与有效状态、过期原因、待确认提议）；操作记录；设置。演示模式显示常驻 DEMO 标识。

## 9. Safari 扩展（extension）

- `manifest.json`（MV3）：`permissions: ["nativeMessaging", "storage", "alarms"]`（`alarms` 只用于后台的合并上报，见下一条）；`host_permissions` 只有 `https://www.amazon.com/*` 与固定的检测服务主机；不申请 `tabs`（用站点权限下的 `tabs.query({url})`；Safari 是否在无 `tabs` 时返回 URL 由 P0 确认）。内容脚本只匹配登录路径，`all_frames: false`。后台为 Safari 支持的非持久后台。
- 非持久后台按 Apple 的要求编写（“When you make your background page nonpersistent: … Add event listeners in the top level of your background page. … Use the `Alarms` API instead of `setTimeout`.”，https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari；WWDC21：“A timer won't be invoked if the background page has unloaded.”）：全部监听器在入口顶层同步注册；窗口/标签页创建与关闭后的 `reportProfileState` 用同名闹钟 `sfe-profile-report`（`when` 为 1.5 秒后，再次创建即替换前一个）合并为一次上报，从不用 `setTimeout`，后台在闹钟到点前被卸载时由闹钟唤醒后补发；`alarms` 不可用或创建失败时直接上报（进行中的上报合并后续请求），不退回计时器。Safari 对闹钟的最小延迟、卸载后是否按时唤醒没有写入文档，由 P0 native_bridge_ipc 记录；延迟变长只推迟这次提示性上报。
- 后台：原生消息的唯一路由；内容脚本只能发 `requestLoginFill` 与 `checkLoginFill`，后台检查 `sender.id`、`sender.frameId === 0`、`sender.tab.url` 分类后代填字段；不在控制台打印请求或响应。
- 弹窗：当前场景状态（绑定、环境、买家号、页面登录状态、站点、代理、前置、实际出口与检测时间、Surge 同步、警告）、关联/新建/结束当前环境（未绑定场景也可进入普通模式）、使用此环境、打开或定位订单页（按 §6.10 门控）、重新检测、编辑、进入普通模式。打开期间约 1 秒轮询，关闭停止。编辑表单中的秘密只在组件内存，提交或关闭即清除，不保存草稿。检查站点权限并提示授权。
- 准备页 `prepare.html`：在目标场景中调用 `beginSafariVerification` 表示到达，以 `cache: 'no-store'`、不带凭据请求检测地址并提交；成功后按环境设置打开或定位订单页。
- P0 另需验证：非持久后台休眠后被唤醒仍能完成原生往返，包括被上报闹钟唤醒后的上报（并入 native_bridge_ipc）；扩展页面请求按 Safari 进程路径归属（并入 safari_process_attribution 的协议覆盖 `extension_page_fetch`）。
- 内容脚本：见 §6.10。
- `storage.local` 只存界面偏好，从不存凭据或草稿。

## 10. macOS 原生部分（apps/macos）

XcodeGen `project.yml`；目标：

- **SafariProfileSurge.app**（宿主，菜单栏）：打开管理后台（maintenance.sock 申请登录码，`NSWorkspace` 打开）；「打开环境」及每环境入口（受控入口，调用激活）；服务状态；以 `SMAppService` 注册内置的 LaunchAgent（App 内打包固定版本的 Node 与服务脚本，同团队签名；Node 是 Mach-O，放在 `Contents/Helpers/node`，服务脚本与网页放在 `Contents/Resources/service/`，按 Apple「Placing content in a bundle」：“Resources are everything that’s not code.”）；生成并分发原生桥传输令牌（写入前检查 App Group 容器能否打开，写入后读回）；打开 Safari 扩展设置；检测扩展未启用或原生桥不可达并提示（系统拒绝访问 App Group 容器与找不到配置分开提示）。
- **Extension**（App Extension）：`SafariWebExtensionHandler` 读取 `SFExtensionProfileKey`，以令牌与服务做双向 HMAC 握手后转发（服务不能证明持有令牌时不发送请求内容），10 秒超时；收到密码钥匙串引用时自己读取（访问组），替换成值后交给扩展；不记录消息内容（去掉模板里的 os_log）。
- **sfe-keychain**（命令行工具，打包在 App 内）：stdin 一条 JSON（set/get/delete），用登录钥匙串；账号密码只支持 set/delete；错误区分「用户拒绝」「钥匙串不允许交互」（`errSecInteractionNotAllowed`，Apple 只定义为 “Interaction with the Security Server is not allowed.”：可能已锁定，也可能无法显示授权提示；线路值沿用 `locked`）「访问控制不匹配」。

服务启动时断言 Node 版本等于打包版本且 `node:sqlite` 所需接口存在，只过滤 sqlite 的 ExperimentalWarning。

## 11. 演示模式

`sfe-service --demo`：独立的临时数据目录、FakeSurge、内存秘密存储、合成数据；拒绝真实 Surge 路径与能力确认；界面常驻 DEMO 标识；不会写入打包的 LaunchAgent。仅用于开发与界面演示，演示中的“已生效”不代表任何网络事实。

## 12. 测试与验收边界

- 离线（本仓库可跑）：契约与纯函数、命名、序列化/注入防护、导入、入口切换规划（穷举不变量）、发布/激活/回滚/对账/恢复编排（FakeSurge，含故障注入与“无全局操作”调用计数断言）、秘密引用“保留后旧版本退役”回归测试、HTTP 认证与 Host/Origin、IPC 权限矩阵、秘密金丝雀测试（标记秘密经所有入口进入后扫描日志、SQLite、事件流、响应）、网页组件、扩展逻辑。`npm run check` 另运行仓库秘密扫描（私钥、密码形状、真实 IP）与测试夹具检查（只允许 RFC 5737/3849 文档地址、回环地址、`example.test`/`.invalid`）。
- 只能在测试 Mac 上验证：全部 P0 能力、Swift 编译与签名、钥匙串、真实 Surge 读回、Safari 实测出口、Chrome 对照、连接连续性、统一日志扫描（`log show`）。见 `docs/P0-RUNBOOK.md`。

离线测试通过不代表网络验收通过；验收报告模板见 `docs/ACCEPTANCE.md`，未测项写「未验证」。
