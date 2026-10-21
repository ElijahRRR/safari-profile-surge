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

**冲突 2（待用户确认）**：免费 Apple ID 的 Personal Team 签名是否满足 CLAUDE.md「正式产品需正常打包签名，临时扩展不是长期交付」尚未验证。待测：不开「允许未签名扩展」时扩展能否在 Safari 退出重开、重启、8 天以上、重新构建后保持启用；描述文件/证书有效期与重签频率；App Group 与钥匙串访问组在 Personal Team 下是否可用。对应能力 `extension_install_persistence`、`native_bridge_ipc`、`bridge_keychain_access`。如必须依赖「允许未签名扩展」，交付物视为不满足约束并明确告知，不作为正常安装路径。

**待用户决定的产品选项**：`first_request_and_old_connections` 实测不通过时，跨环境切换是否要求（还是仅建议）「保存工作后退出并重开 Safari」。在决定前只建议、不强制，并持续显示限制警告。

**最低系统**：macOS 14 / Safari 17（`SFExtensionProfileKey` 自此提供），以 P0 实测为准。

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
- 原生桥消息里的 `profileId` 只有在原生桥证明持有令牌（§7.2 握手）时才被采信；抢占回环端口的其他系统用户既拿不到令牌，也拿不到场景 ID 或消息。令牌对同用户进程可读，所以伪造桥消息的进程可以做 agent 能做的事，并且能拿到明文登录账号与一次性钥匙串引用（比 agent 多）。**买家密码不经 Node 返回**：服务只发钥匙串引用，由签名的原生桥自己读钥匙串；没有原生桥签名身份的进程拿到引用也读不到。
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

`SurgeAdapter`（`ports.ts`）只含：读——版本与构建、当前配置、策略列表、策略详情（解析后在内存中脱敏）、组成员与选择、有效规则列表（含模块规则）、活动/最近请求、外部资源列表、临时规则列表、接管与出站状态、自动重载设置、运行信息（启动时间）；写——组选择、结束单个请求、按 key 更新单个外部资源、增删单条临时规则；校验——`--check` 候选文件、策略测试。

- 没有 switch-profile、update all、flush 临时规则、开关接管、改出站模式、停止 Surge 的原语，代码层面不可能调用。
- `reloadProfile` 不在 `SurgeAdapter` 上，只存在于单独的 `MaintenanceSurge` 端口，只注入维护处理器（init/remerge），发布、路由、回滚、恢复处理器拿不到它；它从不是刷新失败的兜底。
- 每个原语固定到一种实现（CLI 或 HTTP），由 P0 原语清单决定并写入配置；`CompositeSurgeAdapter` 不动态选择。能力记录里的 `adapterMechanism` 与配置不一致时视为待验证。
- CLI：`execFile(cliPath, argv)`，不经 shell；`cliPath` 只来自安装配置，必须解析到已安装的 Surge.app 内且通过 `codesign --verify`（记录的 Team ID）；argv 只有路径、资源 key、组名、节点名、规则文本。
- HTTP：只连回环；密钥在运行时从工作配置 `[General] http-api` 读取（不落库）；该行绑定到非回环地址时拒绝使用 HTTP 并告警。若 P0 表明必需 HTTP 而工作配置没有，`maintenance.init` 以受管理的 `[General]` 段（`http-api = <随机密钥>@127.0.0.1:<端口>`，关闭 TLS 与网页仪表盘）加入，并经用户确认。
- 来自 Surge 或子进程的任何自由文本（含 `execFile` 错误信息与 stderr、`--check` 输出）先经脱敏器（按值 + 节点行参数 + http-api + URL 用户信息与查询）再进入日志、步骤、错误或事件流。

### 5.2 能力门槛

门槛表见 `CAPABILITY_GATES`（contract/phases.ts）：

| 动作 | 需要 |
|---|---|
| 任何节点资源发布（自动或手动，要求相同） | targeted_resource_refresh、policy_path_reread、external_node_underlying_proxy、connection_continuity、auto_reload_atomic_replace |
| 激活与活动环境切换 | native_bridge_ipc、external_node_underlying_proxy、safari_process_attribution、runtime_entry_modes、entry_rules_after_restart、safari_udp_quic_handling、fixed_profile_no_switch；ruleset_resource 策略另需 auto_reload_atomic_replace（规则集刷新本身由该策略下的 runtime_entry_modes 证明） |
| 结束 Safari 旧连接 | safari_process_attribution（普通模式下不满足时尽力而为并报告结果） |
| 场景绑定 | native_bridge_ipc（native_profile_id 未通过时绑定状态为 bound_unverified_id） |
| 登录填充、自动打开订单 | native_profile_id、first_request_and_old_connections、bridge_keychain_access，且路由“受控”（§6.6） |
| 独立预检 | independent_node_preflight（不通过：预检记为 inconclusive，不借当前选择组测试） |
| 维护写工作配置与重载 | auto_reload_atomic_replace，且 same_profile_reload_impact 已测量（`CAPABILITY_MEASURED_GATES`：supported 或带影响记录的 unsupported）；入口必须是 NORMAL |

- **进入普通模式永远可用**：它只依赖入口写入原语与运行时读回，不受 safari_process_attribution 等状态影响（让用户在能力失效后仍能撤销本应用的入口）。优先级问题只阻止 VERIFY_ONLY/ACTIVE，不阻止经 BLOCKED 到 NORMAL；结束 Safari 连接失败（含列不出活动请求、严格核对时仍有连接）只记录并报告，不中止；本应用拥有但被外部修改、无法识别或缺失的入口规则集文件按 §5.5 改写。
- **通过条件**：`CAPABILITY_CRITERIA`（contract/phases.ts）是网页能力页与 P0 手册共用的唯一文字来源。safari_process_attribution 与 safari_udp_quic_handling 的提议必须带逐协议覆盖（`ProtocolCoverage`）；确认 supported 时，`GATING_COVERAGE_ITEMS` 每项都必须是 pass 或写明 limitation；DNS、WebRTC、系统服务只作记录与展示。
- **验证上下文**：每条能力记录保存 Surge 版本与构建、macOS 构建、Safari 版本、入口策略、进程路径摘要、工作配置身份、自动重载设置、接管方式、签名身份、原语实现（只记录该能力依赖的原语，见 `CAPABILITY_PRIMITIVES`，以规范 JSON 比较）；`CAPABILITY_CONTEXT_DEPS` 声明每项依赖哪些字段。比较规则：记录为 `any` 匹配任何当前值；当前值读不到（null）时只匹配记录的 null 或 `any`，否则过期原因为 context_unreadable；其余字段必须相等。当前值来源：`sw_vers` 构建号、Safari.app 的 Info.plist、宿主 App 上报的签名身份、`getVersion`、`getTakeoverState`、`getAutoReloadSetting`、设置中的策略与进程路径、`mechanism()`。任一依赖字段不匹配 → 有效状态为待验证（`staleReasons` 列出原因）。
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

- **初始化（`maintenance.init`，一次性）**：预览阶段只读——备份当前活动配置、其相对引用文件与可读运行开关到数据目录 `backups/`（0700/0600），检测 `#!MANAGED-CONFIG` 远端托管头与其他远端来源（`#!include` URL、远端规则集/模块，只显示主机名）并给出「源配置的远端更新不再自动应用，之后需要重新合并」提示、配置目录是否在 iCloud/同步/受保护位置（默认拒绝）或位于 Git 工作树（警告）、LaunchAgent 启动的服务能否无 TCC 提示读写该目录、自动重载设置、接管与出站状态、HTTP API 绑定、名称与文件冲突（配置文本与 `listPolicies` 中的非本应用 `SFE-` 名称、目录中已存在的 `sfe-*` 文件、指向 `sfe-*` 路径的外部资源）。生成候选（托管头经确认后移除并在差异中显示，URL 脱敏），在 `<数据目录>/tmp` 构造候选并解析全部相对引用后 `--check`，返回 `preview_digest`。提交时重新计算摘要（源配置、引用文件、受管理差异、目标路径），不一致返回 409 `PREVIEW_STALE`。确认后写入新文件 `日常-Safari环境.conf` 与占位资源文件（目标文件必须不存在），**由用户在 Surge 中手动切换一次**。已有工作配置时再次初始化返回 409；首版更换工作配置需要卸载并清空数据后重新初始化。工作配置路径只由此设置。
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

四个位，规则顺序 udp > verify > block > active > 用户规则（定义见 `ENTRY_MODE_BITS`）：

| 模式 | udp | verify | block | active | 效果 |
|---|---|---|---|---|---|
| NORMAL | 0 | 0 | 0 | 0 | Safari 继续匹配用户完整原规则 |
| BLOCKED | 1 | 0 | 1 | 0 | Safari 全部拒绝 |
| VERIFY_ONLY | 1 | 1 | 1 | 0 | 只有检测域名经 SFE-ROUTE（TCP），其余拒绝 |
| ACTIVE | 1 | 0 | 0 | 1 | Safari TCP 经 SFE-ROUTE；UDP/QUIC 拒绝（回落 TCP） |

规则示意：udp `AND,((PROCESS-NAME,<路径>),(PROTOCOL,UDP))` → REJECT；verify `AND,((PROCESS-NAME,<路径>),(DOMAIN,<检测主机>))` → SFE-ROUTE；block/active `PROCESS-NAME,<路径>`。多个路径用 OR 组合。确切语法与在规则集/临时规则中的可用性由 P0 在 6.5 上确认。不修改全局 `udp-policy-not-supported-behaviour`，只读取并记录。

**策略与生效原语**（均需 P0）：

- `temp_rule`（首选候选）：按 `managed_objects` 记录的精确规则逐条增删，从不 flush；同文的临时规则已存在但无本应用记录时停止（`NAME_COLLISION`），不收编。
- `ruleset_resource`：每次写入前读取当前自动重载设置（与能力记录的条件不符或读不到且未记录 `any` → 拒绝，停在已确认的更严格模式；普通模式也一样，报告无法执行而不写入）→ 原子写入单个规则集文件 → 每次重新枚举找到位置指向该文件的唯一 key → `updateExternalResource(key)`；从不重载配置或更新全部。若 6.5 的本地规则集不能不经配置重载就生效、或文件监视会重载配置，此策略不通过。本应用记录拥有、但被外部修改、无法识别或缺失的入口规则集文件（读回的 `changedOwnedFiles`）：激活从不采纳也不改写它们——§6.3 第 2 步在写入之前以 `BASELINE_CHANGED` 拒绝，之后才出现的由激活中的入口切换（含第 6 步进入 BLOCKED）拒绝（`BASELINE_CHANGED`/`UNKNOWN_STATE`，不写入）并按第 14 步回滚；只有撤销入口（普通模式与回滚，入口切换带 `undo`，目标 BLOCKED/NORMAL）按载入时读到的摘要比较并替换地改写（已加载内容未知，与未确认的意图一样按更宽松的一侧规划、先开 block），失败时不把外部内容确认为记录，`managed_segments_changed` 警告保留（托管状态下到下一次激活；空闲且入口为 NORMAL 时由对账在检查不再成立后清除，§6.6）；不属于本应用记录的文件任何方向都不改写。

**切换顺序（无放行窗口）**：纯函数 `planEntryTransition(from, to)` 输出单个位的变更序列：先开 block（离开 NORMAL 时同时尽早开 udp），再把 verify/active/udp 设为目标值（block 仍开），最后把 block 设为目标值。不变量（穷举测试）：开头之后到最后一步之前 block 一直开着；verify 或 active 为开时 udp 必为开；每个中间有效模式都属于 {BLOCKED, VERIFY_ONLY, 起点, 终点}；不会出现非目标的 ACTIVE 或 NORMAL。每步写入后做**运行时读回**；任一步失败停在已确认的更严格状态，记录 `UNKNOWN` 或最后确认的模式，不尝试退回更宽松状态。

**运行时读回**（文件摘要只是次要证据）：有效规则列表（含模块与临时规则）中本应用入口规则位于所有可能匹配 Safari 流量的非 REJECT 规则之前；temp_rule 下临时规则列表与记录完全一致；ruleset_resource 下对应资源无错误、更新时间前进（6.5 能提供多少记多少）；P0 定义的“未重载”信号。6.5 无法给出有效规则顺序与刷新状态时，该策略不能通过 P0。

**优先级检查**：在初始化、每次对账、每次激活前，对排在本应用入口之前的规则分类——REJECT 类只提示；可能匹配 Safari 流量、能路由到非 REJECT 策略的规则（模块 DIRECT、用户临时规则、RULE-SET/GEOIP/IP-CIDR/逻辑规则等不能证明无交集者）→ 入口记为 UNKNOWN、阻止激活，列出规则与来源（`PRECEDENCE_VIOLATION`）；从不自动停用或修改用户模块与临时规则。它只阻止进入 VERIFY_ONLY/ACTIVE：BLOCKED 的最终读回因此为 UNKNOWN（`PRECEDENCE_VIOLATION` 只在入口位已全部是目标模式、仅被优先级挡住时报告；回滚因此停在需要处理），普通模式把这种已确认的 BLOCKED 当作中间步骤，继续进入 NORMAL。读取 `skip-proxy`、`tun-excluded-routes` 等绕过设置，覆盖站点或检测主机时告警。

### 5.6 文件安全

候选只写 `<数据目录>/tmp`（0700），全部含秘密文件以 O_CREAT|O_EXCL 0600 创建，`--check` 后删除（失败也删），启动时清扫残留；备份保留初始备份 + 最近 5 次维护备份，卸载步骤包含删除；`.gitignore` 排除 `*.conf`、`sfe-*.list`、`backups/` 等。

## 6. 执行器与事务（service/src/engine）

### 6.1 受理、队列与唯一写入者

- 处理器只做：校验 → 一个 SQLite 事务（期望数据 + operation(SAVED) + outbox）→ 202。纯数据修改（展示名、站点、选项、账号、预期出口 IP）同事务内完成为 `COMPLETED`，不入队、不碰 Surge。
- 同步拒绝不创建操作、不占用 `request_id`：校验失败、版本冲突、`NEEDS_CONFIRMATION`、`ROUTE_BUSY`、绑定不符。客户端可以用同一 `request_id` 带上确认重发。
- 同一 `request_id`：带密钥规范摘要相同 → 返回原操作（`duplicate: true`）；不同 → 409。
- 唯一执行器串行领取 outbox，所有 Surge 写在执行器内发生（全局写锁）。等待场景到达或 Safari 实测的操作状态为 `waiting`，释放执行器，由原生桥消息或计时器重新入队。
- 超时/Surge 无响应 = 未知：阶段 `RECONCILING`，先读事实再决定，不重复写。
- **路由操作并发矩阵**（按操作状态判断）：已有路由操作处于 queued 或 running（含 RECONCILING、ROLLING_BACK）→ 新的激活/普通模式/Safari 重测返回 `ROUTE_BUSY`。已有激活或重测处于 waiting（等待场景到达或实测）→ 新的激活或普通模式把它结束为 `SUPERSEDED`（记录 `superseded_by`，epoch 递增使其 test_id 失效，不执行回滚），新操作从当前已确认状态开始（先进入 BLOCKED）；新的重测返回 `ROUTE_BUSY`。已有活动环境改代理操作处于 `WAITING_ROUTE` → 新的激活或普通模式把它结束为 `READY_FOR_NEXT_OPEN`（新版本已部署、未切换，记录 `superseded_by`）；新的重测针对旧版本照常进行。活动环境改代理操作在路由忙时停在 `WAITING_ROUTE`，从不取代已开始的切换。
- 取消（`cancelOperation`）只适用于等待中的路由操作：激活/重测按 §6.3.14 回滚；`WAITING_ROUTE` 直接结束为 `READY_FOR_NEXT_OPEN`；从不进入 NORMAL。
- 对账（启动、周期、`refreshSurge`）作为执行器内部任务运行，只有在发现变化并改变路由状态或警告时才记录一条 `maintenance.reconcile` 操作，避免操作记录被周期任务刷屏。

### 6.2 发布

`VALIDATING → (门槛不足) WAITING_DEPLOYMENT` 或 `→ DEPLOYING → DEPLOYED_UNVERIFIED | PREFLIGHT_OK → READY_FOR_NEXT_OPEN`；活动环境接着走 §6.3（同一 operation_id，经 `WAITING_ROUTE`）。

1. 前置条件：Surge 当前配置名与路径等于记录的工作配置（否则 `EXTERNAL_PROFILE`，不写）；读取自动重载设置，与能力记录的条件一致（否则停在 WAITING_DEPLOYMENT）。
2. 校验数据、前置存在于 `listPolicies` 且是固定节点、命名唯一；生成候选资源；在 `<数据目录>/tmp` 构造工作配置副本并解析全部相对引用（P0 确认用符号链接或绝对路径）：`sfe-nodes.list` 与入口规则集指向候选副本，其余指向真实文件；任何引用无法解析即校验失败；每个解析结果只把路径（不含内容）记入步骤。然后 `--check`，逐节点核对预期清单，删除候选。
3. 基线三项检查：(1) 本操作开始时读到的工作配置与资源摘要在写入前未变（变了则从第 2 步重来，有限次数后 `BASELINE_CHANGED`）；(2) 受管理段内容与位置与 `managed_objects` 一致、无非本应用 `SFE-` 对象（`listPolicies` 中不在清单或进行中候选里的 `SFE-` 名称、候选新节点名已存在都算）；(3) `sfe-nodes.list` 等于上次发布的摘要。受管理段之外的用户修改直接记为新基线。
4. 写入前确认读回所需原语（`getGroupMembers`、`getGroupSelection`、`listExternalResources`）在固定实现下可用，否则停在 WAITING_DEPLOYMENT（执行器从不写入它无法读回的内容）。枚举外部资源，要求恰好一个 key 的位置解析到 `sfe-nodes.list` 的绝对路径（0 个 `RESOURCE_MISSING`，多个 `NAME_COLLISION`，均不写）；`managed_objects` 写入意图行；原子替换资源文件；`updateExternalResource(key)`。
5. 读回：当前配置名与路径仍是工作配置（否则 `EXTERNAL_PROFILE`）；记录 P0 定义的“未重载”信号；重新枚举确认同一 key；资源无错误、更新时间前进（可得时）；SFE-ROUTE 首成员仍为 REJECT，其余成员集合与清单完全相等（数量一致、无重复、无多余或旧成员）；选择等于发布前的选择；`getPolicyDetail` 可用时逐节点核对地址、端口与 underlying-proxy。缺少细节读取时 `readback_level = partial` 并记录未核对字段，界面显示「已部署，读回不完整」。partial 部署只有在 policy_path_reread、targeted_resource_refresh、external_node_underlying_proxy 的 P0 记录覆盖了这些未核对字段时才算“可接受的读回”：此时部署记为 verified、可以激活；否则部署停在 published，相关版本不能激活（汇总状态为 sync_failed，下一步为核验能力）。
6. 读回不一致 → 用同一路径回滚到上一份“可接受读回”的资源并恢复发布前选择，再读回；回滚失败时活动环境进入 `BLOCKED_NEEDS_ATTENTION`，否则路由 attention。
7. 记录代数与各操作的 `deployed_proxy_revision`；非活动环境在门槛允许时独立预检，否则 inconclusive（「已部署，待激活时由 Safari 实测」）。预检不返回出口 IP（`testPolicy` 不提供），`expected_exit_ip` 只在 Safari 实测时比较。

### 6.3 激活（受控切换）

**受理**：环境已绑定、目标版本已部署（读回可接受）且在组内、汇总状态允许激活、门槛满足、路由不忙。目标与当前活动环境不同、或其他场景在有效期内上报有打开的窗口时，没有 `old_session_policy` → 同步 409 `NEEDS_CONFIRMATION`（含当前环境、其他场景、选项与限制说明）；`confirmed_environment_id` 缺省视为 null（期望没有其他环境在用）。

**执行**：

1. **复用（只读）**：目标环境与版本等于活动环境与版本、路由阶段 active_verified、读回入口为 ACTIVE、选择等于目标节点、无阻断类警告（external_*、rollback_needs_reverify、surge_unreachable、surge_restarted、entry_unverified、takeover_lost、outbound_mode_changed、precedence_violation、front_missing、managed_segments_changed）→ 若最近 Safari 实测为 ok、属于当前 epoch 与活动版本、未过期，且无 probe_failed/exit_ip_mismatch → 直接完成（不递增 epoch、不阻断、不断连；有订单页时定位它）；实测过期或不是 ok → 改为发起 §6.4 重测（不切换）。`takeover_unknown` 与读不到出站模式不阻断，但要求一次新的 Safari 实测。
2. **受控检查**（执行时，写入之前）：活动环境与 `confirmed_environment_id` 不一致 → FAILED（`NEEDS_CONFIRMATION`，details 同 409），不碰路由。Surge 可达；当前配置是工作配置；无 takeover_lost/outbound_mode_changed；优先级检查通过；本应用的入口文件未被外部修改（否则 `BASELINE_CHANGED`，由普通模式改写或经维护流程恢复，§5.5）；前置仍在 `listPolicies` 中（否则 `FRONT_PROXY_MISSING`）；目标节点仍是 SFE-ROUTE 成员（否则 `NODE_NOT_DEPLOYED`）。任一不满足 → FAILED 且不碰路由。例外：本操作经取代接手了等待中激活的过渡状态（路由停在 VERIFY_ONLY 等待、切换中或回滚中，`operation_id` 是本操作、有激活快照）时，第 1–3 步的任何失败都按第 14 步从快照回滚，否则该状态无人负责、也不会超时。
3. **预检**：`independent_node_preflight` 通过时，需要目标版本未过期的 ok 预检（缺失则当场独立预检）→ `PREFLIGHT_OK`（在 SAFARI_BLOCKED 之前）；失败 → `PREFLIGHT_FAILED`，路由、选择、当前环境都不变。不通过时预检推迟到第 8 步之后（见第 8 步）。
4. **活动环境改代理**：在此等待（`WAITING_ROUTE`，status waiting，截止 `profileArrivalTimeoutSec`），直到绑定场景到达（准备页调用 `beginSafariVerification`）；期间旧版本继续使用、Safari 不被阻断。到达后重新执行第 2、3 步检查再继续；截止仍未到达 → 结束为 `READY_FOR_NEXT_OPEN`（下一步「切换到新版本」），路由不变。
5. `route_epoch += 1`，写入激活快照（切换前环境/版本/选择/入口模式/实测/epoch）。
6. 入口 → BLOCKED（读回）→ `SAFARI_BLOCKED`；暂停自动打开订单与填充。
7. 结束确认属于 Safari 的连接（按已确认的进程路径过滤，逐条记录 `KillResult`，不清空其他应用）。
8. 选择目标节点并读回。预检推迟时：此时 Safari 已阻断、Chrome 不命中 SFE-ROUTE，经 SFE-ROUTE 执行 `testPolicy`（P0 确认它测试的是当前选择），写入一条预检记录（operation_id、epoch、版本）→ `PREFLIGHT_OK`；失败 → `PREFLIGHT_FAILED` 并进入第 14 步回滚。「不借当前选择组测试」只针对非活动环境的后台预检。
9. 入口 → VERIFY_ONLY（读回）→ `VERIFY_ONLY`，status waiting，路由 `awaiting_safari_verify`。
10. **等待场景到达**（截止 `profileArrivalTimeoutSec`）：从插件发起时场景已在，弹窗立即打开准备页；从网页/菜单/CLI 发起（受控入口）时，由于入口已经阻断，用户之后才打开的场景或恢复的标签页不会经旧出口加载。`open_profile_by_id` 通过前，界面给出「在 Safari 切换到场景 <名称>，点击扩展图标」的引导，不称一键完成；绑定场景的弹窗看到等待中的操作即打开准备页。
11. 准备页 `beginSafariVerification`（来源必须是绑定该环境的场景）→ 记录是否已有 Amazon 标签页 → 签发一次性 `test_id`（绑定操作、环境、场景、epoch、截止 `safariVerifyTimeoutSec`）。
12. 准备页请求检测地址并 `submitSafariVerification`。服务核对：test_id 未用、epoch 未变、来源场景正确、未超时；签发前与提交后重读 SFE-ROUTE 选择都等于目标节点；在 Surge 最近请求中找到同一时间窗、Safari 进程路径、检测主机、命中 verify 规则、经 SFE-ROUTE（能读到叶节点时等于目标节点）的新连接；有预期出口时必须一致。
13. 通过 → 重新读取基础事实并检查激活门槛（等待期间能力可能被重置或因版本变化过期；缺失 → `CAPABILITY_UNVERIFIED`，按第 14 步回滚，不写 ACTIVE）→ 入口 → ACTIVE（读回）→ 提交活动版本、`last_verified_proxy_revision`、实测 → `ACTIVE_VERIFIED`；提交按设计清除失控类警告，随后立即做一次只读对账，让仍然成立的事实类警告（例如 `managed_segments_changed`）马上重新出现。附加警告：`launch_unverified`（发起或开始实测时场景已有 Amazon 标签页；只有之后一次上报无 Amazon 标签页的受控激活才清除）、`launch_order_unverified`（first_request_and_old_connections 未通过时每次 ACTIVE_VERIFIED 都带）、`old_session_unproven`（跨环境切换且该能力未通过，即使用户确认已关闭）、`old_windows_kept_open`（选择不关闭）。
14. **失败/超时/取消 → `ROLLING_BACK`**：有切换前的已验证路由时，恢复其节点选择并读回，入口保持 BLOCKED，路由阶段 failed，`active_environment_id/active_proxy_revision` 为恢复后的实际值，警告 `rollback_needs_reverify`；结果为 `RollbackResult`（旧版本、旧实测显示为「上次结果」、新版本失败原因）。恢复后的原环境 facets.route 为 rolled_back（汇总 needs_reverify，下一步「重新核验」）；失败的目标环境保持其已部署版本与错误（下一步视其状态）。重新核验由用户发起：激活原环境与原版本，照常执行旧窗口确认（失败的目标场景可能已打开，会被列出），走 BLOCKED → VERIFY_ONLY → 实测 → ACTIVE。原来是 NORMAL 时保持 BLOCKED 并失败。回滚写入失败或读回无法判定 → `BLOCKED_NEEDS_ATTENTION`。**从不回退到 NORMAL、DIRECT 或其他买家出口。**
15. 用户可通过 `proxy_revision` 指定返回该环境的 `last_verified` 版本（例如 r18 失败后回到 r17）；r18 保持已部署，编辑内容保留以便修正。
16. **预期出口修改**：活动环境的预期出口被修改时立即与最近一次 ok 的 Safari 实测比较，不符 → `exit_ip_mismatch`，停止自动打开与填充，不切换。

### 6.4 当前环境的 Safari 重测（`probe.safari`）

只允许针对当前 epoch 中 ACTIVE_VERIFIED 的活动环境，且读回入口为 ACTIVE、无失控类警告（surge_unreachable、surge_restarted、entry_unverified、takeover_lost、outbound_mode_changed、external_*、precedence_violation）：不改入口、不改选择、不断连、不递增 epoch。签发 test_id → 绑定场景准备页检测 → 服务按 §6.3.12 核对（命中 active 规则而非 verify 规则；ACTIVE 下连接复用对“新连接”判断的影响由 P0 确认）。成功更新实测与有效期并清除 `probe_expired`；失败/不符 → 记录、加 `probe_failed`/`exit_ip_mismatch`、停止填充与自动打开，从不自动切换、阻断或进入 NORMAL。实测过期的触发：TTL、对账发现 Surge 重启/配置重载/外部修改、前置状态变化、本机网络变化（主接口或地址变化）。

### 6.5 普通模式

显式操作，任何已识别场景（含未绑定场景）都可发起。有托管环境时需要旧窗口确认（`managed_environment_active`）；执行时活动环境与 `confirmed_environment_id`（缺省 null）不一致 → FAILED 并要求重新确认，不碰路由。流程：（ruleset_resource 时先检查自动重载设置）入口 → BLOCKED（有规则排在入口之前时，入口位已确认为 BLOCKED 即继续，结果记录这些规则）→ 结束 Safari 连接（门槛不满足时尽力而为；列出或结束连接失败只把 `killError` 与逐条结果记入操作结果并报告，不中止）→ NORMAL（读回）→ 清空活动环境 → `NORMAL_RESTORED`。被外部修改的本应用入口文件按 §5.5 改写（操作结果记 `changedEntryFiles` 并有一步说明），`managed_segments_changed` 保留，之后空闲时对账检查到受管理段与本应用文件已一致即清除（§6.6）。普通模式不改变 SFE-ROUTE 的选择（入口关闭后它不再被 Safari 使用）；不修改其他任何东西，不删除用户临时规则。选择「不关闭」时保留 `managed_windows_on_original_rules` 警告（「旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）」），直到用户通过 `acknowledgeWindows` 确认已关闭或下一次激活完成；`old_windows_kept_open` 同理。

### 6.6 对账与“受控”

- **启动**：读数据库未完成操作 → 读 Surge 事实（版本构建、当前配置、受管理段与资源摘要、入口位/临时规则、组选择、接管与出站、自动重载）→ 按 `managed_objects` 意图行与事实判断每步是否已生效，从下一步继续或回滚；不重放全部写。路由操作按路由阶段与 epoch 判断（操作阶段在切换中可能仍是 PREFLIGHT_OK，不能用来判断）：尚未递增 epoch 的（pending/arrived）重新执行检查；已递增的（切换中、VERIFY_ONLY 之后的核对、回滚中）先读入口事实再按激活快照回滚；经取代接手了过渡中路由的激活（`operation_id` 是本操作、阶段 switching/awaiting_safari_verify/rolling_back、有激活快照）或操作阶段已是 `ROLLING_BACK` 的，即使自己的 epoch 仍为空、stage 仍是 pending，也按快照回滚，从不把已开始的回滚重放成切换；Safari 重测不写入，重新执行。等待中的操作未超时则继续等待，已超时按 §6.3.14。
- **周期**：路由阶段不是 idle 或入口不是 NORMAL 时，每 `reconcileIntervalSec`（默认 30 秒）只读对账一次（作为执行器的内部任务，路由/发布写入进行中时延后）；读取版本构建、当前配置、受管理段与本应用文件摘要及位置、入口位、组选择、可达性、接管与出站、已登记前置是否仍存在。不一致：选择或配置被改 → 阶段 `external_change` + `external_selection_change`/`external_profile_change`；受管理段或本应用文件被改 → 阶段 attention + `managed_segments_changed`（停止同步，从不自动修复）；入口位丢失（例如 Surge 重启后临时规则消失）→ 入口 UNKNOWN + 阶段 attention + `entry_unverified`/`surge_restarted`；不可达 → 阶段 attention + `surge_unreachable`；接管关闭或出站非规则 → 阶段 attention + `takeover_lost`/`outbound_mode_changed`；读不到接管状态 → `takeover_unknown`（不阻断，但要求新的 Safari 实测）；优先级被抢先 → 阶段 attention + `precedence_violation`；前置消失 → 前置状态 missing、依赖环境不能激活、活动环境实测过期 + `front_missing`；Safari/macOS/Surge 版本变化或进程路径不存在 → 能力过期 + `entry_unverified`；路由停在 switching/rolling_back 而负责它的操作已不在执行或排队（例如崩溃恢复失败）→ 入口按读回记录（与记录不一致为 UNKNOWN）+ 阶段 attention + `entry_unverified`。对账在提交事务中重读路由、只合并本次新增的警告，阶段与入口只在仍是读取开始时的值时才改（读取期间受理与原生桥处理器可能已改过警告，例如 `exit_ip_mismatch`、确认窗口已关闭）。空闲且入口为 NORMAL 时（启动、刷新、动作前对账；周期对账不运行）只清除一种警告：受管理段与本应用文件检查已一致时清除撤销入口时保留的 `managed_segments_changed`（例如普通模式已改写入口文件、`maintenance.remerge` 已恢复受管理段）；托管状态下它是粘性的，由下一次激活清除。对账只发布 `route.updated`/`surge.status`，**从不写 Surge、从不抢回控制**，恢复需要用户显式激活或进入普通模式。
- **动作前**：`requestLoginFill`、自动打开订单、激活复用之前，同步做一次短超时对账；失败即拒绝。
- **“受控”的定义**（复用、填充、自动打开订单共用一条规则）：Surge 可达；当前配置是工作配置；入口读回为 ACTIVE；选择等于活动节点；无 takeover_lost、outbound_mode_changed、external_*、surge_unreachable、surge_restarted、precedence_violation、entry_unverified、front_missing、managed_segments_changed、probe_failed、exit_ip_mismatch 警告；最近 Safari 实测 ok、属于当前 epoch 与活动版本、未过期。`takeover_unknown` 与读不到出站模式不破坏“受控”，但只在新的 Safari 实测（有效期内）证明 Surge 看到了 Safari 连接时成立。

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

见 `contract/native.ts`。服务按 `NATIVE_PERMISSIONS` 矩阵强制：未识别场景只允许 `getCurrentState`（不返回其他环境名称）；针对环境的请求携带 `environment_id`，与场景绑定比对不一致 → `BINDING_MISMATCH`（在版本检查与创建操作之前）；`getOperation` 只返回自己环境或自己发起的操作，否则 `NOT_FOUND`；非活动环境的场景只拿到路由摘要（不含实测、选择、操作 id）。扩展从不在启动、窗口/标签页创建、焦点或心跳事件中发送激活或普通模式请求，只在用户点击时发送；`reportProfileState` 在弹窗打开、窗口与标签页创建/关闭时由后台发送，超过 10 分钟的上报不再计入“有打开的窗口”；只作提示，从不改变路由。帧格式 NDJSON，单条 ≤256 KiB。

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

- `manifest.json`（MV3）：`permissions: ["nativeMessaging", "storage"]`；`host_permissions` 只有 `https://www.amazon.com/*` 与固定的检测服务主机；不申请 `tabs`（用站点权限下的 `tabs.query({url})`；Safari 是否在无 `tabs` 时返回 URL 由 P0 确认）。内容脚本只匹配登录路径，`all_frames: false`。后台为 Safari 支持的非持久后台。
- 后台：原生消息的唯一路由；内容脚本只能发 `requestLoginFill` 与 `checkLoginFill`，后台检查 `sender.id`、`sender.frameId === 0`、`sender.tab.url` 分类后代填字段；不在控制台打印请求或响应。
- 弹窗：当前场景状态（绑定、环境、买家号、页面登录状态、站点、代理、前置、实际出口与检测时间、Surge 同步、警告）、关联/新建/结束当前环境（未绑定场景也可进入普通模式）、使用此环境、打开或定位订单页（按 §6.10 门控）、重新检测、编辑、进入普通模式。打开期间约 1 秒轮询，关闭停止。编辑表单中的秘密只在组件内存，提交或关闭即清除，不保存草稿。检查站点权限并提示授权。
- 准备页 `prepare.html`：在目标场景中调用 `beginSafariVerification` 表示到达，以 `cache: 'no-store'`、不带凭据请求检测地址并提交；成功后按环境设置打开或定位订单页。
- P0 另需验证：非持久后台休眠后被唤醒仍能完成原生往返（并入 native_bridge_ipc）；扩展页面请求按 Safari 进程路径归属（并入 safari_process_attribution 的协议覆盖 `extension_page_fetch`）。
- 内容脚本：见 §6.10。
- `storage.local` 只存界面偏好，从不存凭据或草稿。

## 10. macOS 原生部分（apps/macos）

XcodeGen `project.yml`；目标：

- **SafariProfileSurge.app**（宿主，菜单栏）：打开管理后台（maintenance.sock 申请登录码，`NSWorkspace` 打开）；「打开环境」及每环境入口（受控入口，调用激活）；服务状态；以 `SMAppService` 注册内置的 LaunchAgent（App 内打包固定版本的 Node 与服务脚本，同团队签名）；生成并分发原生桥传输令牌；打开 Safari 扩展设置；检测扩展未启用或原生桥不可达并提示。
- **Extension**（App Extension）：`SafariWebExtensionHandler` 读取 `SFExtensionProfileKey`，以令牌与服务做双向 HMAC 握手后转发（服务不能证明持有令牌时不发送请求内容），10 秒超时；收到密码钥匙串引用时自己读取（访问组），替换成值后交给扩展；不记录消息内容（去掉模板里的 os_log）。
- **sfe-keychain**（命令行工具，打包在 App 内）：stdin 一条 JSON（set/get/delete），用登录钥匙串；账号密码只支持 set/delete；错误区分「用户拒绝」「钥匙串已锁」「访问控制不匹配」。

服务启动时断言 Node 版本等于打包版本且 `node:sqlite` 所需接口存在，只过滤 sqlite 的 ExperimentalWarning。

## 11. 演示模式

`sfe-service --demo`：独立的临时数据目录、FakeSurge、内存秘密存储、合成数据；拒绝真实 Surge 路径与能力确认；界面常驻 DEMO 标识；不会写入打包的 LaunchAgent。仅用于开发与界面演示，演示中的“已生效”不代表任何网络事实。

## 12. 测试与验收边界

- 离线（本仓库可跑）：契约与纯函数、命名、序列化/注入防护、导入、入口切换规划（穷举不变量）、发布/激活/回滚/对账/恢复编排（FakeSurge，含故障注入与“无全局操作”调用计数断言）、秘密引用“保留后旧版本退役”回归测试、HTTP 认证与 Host/Origin、IPC 权限矩阵、秘密金丝雀测试（标记秘密经所有入口进入后扫描日志、SQLite、事件流、响应）、网页组件、扩展逻辑。`npm run check` 另运行仓库秘密扫描（私钥、密码形状、真实 IP）与测试夹具检查（只允许 RFC 5737/3849 文档地址、回环地址、`example.test`/`.invalid`）。
- 只能在测试 Mac 上验证：全部 P0 能力、Swift 编译与签名、钥匙串、真实 Surge 读回、Safari 实测出口、Chrome 对照、连接连续性、统一日志扫描（`log show`）。见 `docs/P0-RUNBOOK.md`。

离线测试通过不代表网络验收通过；验收报告模板见 `docs/ACCEPTANCE.md`，未测项写「未验证」。
