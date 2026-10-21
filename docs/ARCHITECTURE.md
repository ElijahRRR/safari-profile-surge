# 实现架构

日期：2026-10-21。性质：P1–P4 的实现规格。产品行为以三份 design 文档为准；本文件把它们落到具体模块、接口、数据表和事务顺序上。凡标注「能力门槛」的路径，在 P0 实测通过并记录前，代码会拒绝执行而不是降级为重载、全局改代理或 DIRECT。

## 0. 已确认的用户决定

| 项目 | 决定 | 影响 |
|---|---|---|
| 后台语言 | TypeScript + Node 22.13+（内置 `node:sqlite`） | 后台、网页、插件共用 `packages/contract` 类型；Swift 只做宿主 App、原生桥、Keychain 小工具 |
| Amazon 站点 | 首版只支持美国站 `www.amazon.com` | 扩展只申请该站点权限；填充只认 `https://www.amazon.com` 顶层页面 |
| 跨环境切换时的旧窗口 | 提示手动关闭；也允许选择「不关闭，直接切换」 | 见 §6.3：「不关闭」是用户显式确认的选项，路由状态持续显示警告 |
| 签名 | 只有免费 Apple ID | 本机开发签名（Personal Team），不做 Developer ID 公证；见 docs/INSTALL.md |

### 与设计约束的冲突（已告知用户，按用户选择实现）

「不关闭旧窗口直接切换」与设计中「旧环境后台及长连接不能继续错用出口」冲突：切换事务仍会结束属于 Safari 的旧连接，但旧环境窗口之后发起的新请求会经过新环境出口（整个 Safari 同一时刻共用一个出口）。实现方式：

- 该选项只能在确认弹窗中显式选择，不作为默认值；每次切换都要重新选择。
- 路由状态记录 `old_session_policy = keep_open_acknowledged`，并持续带 `old_windows_kept_open` 警告，网页和插件都显示「旧环境窗口未关闭，其后续请求将使用当前出口」。
- 不把这种状态显示成无警告的绿色「已生效」。

## 1. 仓库结构

```
packages/contract   共享类型：实体视图、HTTP 接口、原生消息、SSE 事件、错误码、命名、站点
service             本机管理服务（唯一写入者）与 sfe CLI
apps/web            本机网页后台（Vue 3 + EasyQuick UI）
extension           Safari Web Extension（MV3）：弹窗、准备页、登录页内容脚本
apps/macos          Swift：宿主 App、SafariWebExtensionHandler 原生桥、Keychain 小工具（XcodeGen 工程）
tools/p0            P0 能力门槛实测工具与操作手册
docs                架构、安装/卸载/回退、P0 手册、验收报告模板
```

## 2. 进程与信任边界

```
Safari 扩展 ──sendNativeMessage──▶ SafariWebExtensionHandler（App Extension，沙盒）
                                     │ 补充 SFExtensionProfileKey
                                     ▼ NDJSON over Unix socket（App Group 容器内 bridge.sock，0600）
网页（127.0.0.1:61847）──HTTP+SSE──▶ sfe-service（Node，LaunchAgent）──▶ SQLite（数据目录 0700）
sfe CLI / GPT ──NDJSON over admin.sock（数据目录内，0600）──▶ │        ──▶ Keychain（经 sfe-keychain，stdin 传值）
                                                               └──▶ Surge（surge-cli argv / 回环 HTTP API）
```

- **同一用户的本机进程**是信任边界：能连上 admin.sock 的进程等同管理员。普通网站不能访问 Unix 套接字；访问 HTTP 端口需要会话 Cookie、合法 Host/Origin 和 CSRF 头。
- **bridge.sock** 只接受 `BridgeEnvelope`，命令范围受场景绑定约束（§7.2）。扩展 JS 自带的任何 profile 字段都被忽略。
- 秘密只在三处出现：Keychain、`sfe-keychain` 的 stdin/stdout、生成的 Surge 节点资源文件（Surge 语法要求明文，文件 0600，见 §5.6）。不进 SQLite、日志、命令行参数、SSE、HTTP 列表接口。

## 3. 服务内部模块（service/src）

| 目录 | 职责 | 依赖 |
|---|---|---|
| `config.ts` | 数据目录、套接字路径、端口、Surge 路径；从 `config.json` 与环境变量读取 | — |
| `util/` | `clock`、`ids`（ULID 风格）、`redact`（日志脱敏）、`logger`（只写脱敏 JSON 行）、`digest`、`atomic-write` | — |
| `db/` | `node:sqlite` 打开、迁移、事务助手；`repos/*` 每张表一个仓库 | util |
| `secrets/` | `SecretStore` 接口；`KeychainHelperStore`（spawn sfe-keychain，stdin JSON）；`MemorySecretStore`（仅测试/演示） | util |
| `domain/` | 输入校验、凭据可表达性检查、命名分配、差异、就绪状态推导、视图组装 | contract, db |
| `importer/` | CSV/XLSX/JSON 解析（不执行公式/宏/外链），统一映射成 `EnvironmentInput`，预览与提交 | domain |
| `surge/` | `SurgeAdapter`（低层原语）与实现：`SurgeHttpAdapter`、`SurgeCliAdapter`、`FakeSurge`；`profile.ts`（主配置解析与受管理段合并）；`generate.ts`（节点行/资源文件/规则集）；`entry/`（入口模式策略）；`capabilities.ts`（门槛判断） | contract, secrets |
| `engine/` | 操作队列（outbox）、唯一执行器、各操作处理器、恢复/对账、事件总线 | 以上全部 |
| `http/` | 回环 HTTP 服务、认证/CSRF/Host 检查、路由、SSE | engine |
| `ipc/` | NDJSON 套接字服务：bridge（原生桥）与 admin（CLI） | engine |
| `cli/` | `sfe` 命令行（连接 admin.sock） | contract |
| `main.ts` | 组装与启动；启动顺序：迁移 → 读 Surge 事实 → 对账 → 开始执行器 → 开放 HTTP/IPC |

所有依赖通过 `service/src/ports.ts` 中的接口注入，测试使用 `FakeSurge`、`MemorySecretStore`、可控时钟。

## 4. 数据模型（SQLite）

`service/src/db/schema.ts` 是唯一定义。要点：

- `environments`：`id`、`seq`（稳定编号来源）、`code`（E0001）、`node_tag`（US01）、展示名、站点、选项、`revision`（environment_revision）、`desired_proxy_revision`、`deployed_proxy_revision`、`deleted_at`。
- `proxy_revisions`：`(environment_id, revision)` 主键；协议/地址/端口；`username_ref`/`password_ref`（Keychain 引用）；`username_fp`/`password_fp`（HMAC 指纹，用于“相同内容重复导入为无操作”，密钥是 Keychain 中的随机 pepper）；`front_proxy_id`；`expected_exit_ip`；`node_name`（唯一）；`state`（desired / deployed / superseded / retired）。
- `front_proxies`：`id`、`surge_name`（唯一）、`ownership`、`state`、`is_default`。
- `accounts`：环境一对一；`label`、`login_identifier`、`password_ref`、`password_fp`、`page_identity`、`changed_since_page_check`。
- `profile_bindings`：`profile_id` 主键、`environment_id` 唯一（一对一约束由两个唯一索引保证）。
- `deployments`：`generation` 主键（configuration_generation）、`working_profile_digest`、`resource_digest`、`node_manifest`（JSON 节点名数组）、`state`（candidate / published / verified / failed）、`operation_id`。
- `route_state`：单行（id=1）：`route_epoch`、`entry_mode`、`entry_mode_verified_at`、`phase`、`active_environment_id`、`active_proxy_revision`、`selected_node`、`old_session_policy`、`operation_id`、`warnings`（JSON）。
- `operations`：`id`、`request_id`（唯一）、`request_digest`（同一 request_id 不同内容 → 409）、`kind`、`environment_id`、`expected_revision`、`result_revision`、`route_epoch`、`phase`、`status`、`payload`（JSON，只含引用不含秘密）、`result`、`error`、时间戳。
- `operation_steps`：阶段日志（脱敏）。
- `outbox`：`operation_id`、`available_at`、`claimed_at`、`done_at`、`resume_reason`（例如 verify_submitted / verify_timeout）。
- `probes`：预检与 Safari 实测分开存；`expires_at` 决定是否过期。
- `verification_tests`：一次性 `test_id`、`operation_id`、`environment_id`、`profile_id`、`route_epoch`、`deadline`、`consumed_at`。
- `capabilities`、`settings`（JSON 值）、`meta`（schema_version、事件序号、环境序号、各站点序号）。
- `secret_refs`：`ref`、`state`（pending / committed / orphaned）、`created_at`。

**期望数据与任务入队在同一 SQLite 事务提交。**Keychain 与 SQLite 不是同一个事务，顺序固定为：

1. 小事务插入 `secret_refs(ref, pending)`；
2. 写 Keychain（新 ref，从不覆盖旧 ref）；
3. 主事务：写新版本行引用该 ref、把 ref 标为 committed、写 operation + outbox；
4. 任一步失败：删除该 Keychain 项与 pending 行；启动时清理超过 10 分钟的 pending ref。

旧版本的秘密只在该版本 `retired`（不再被选择、不在资源中、无相关连接）后标为 orphaned 并删除。

## 5. Surge 适配层

### 5.1 低层原语 `SurgeAdapter`

见 `service/src/ports.ts`。原语按能力分组，每个实现对自己做不到的原语抛出 `CAPABILITY_UNVERIFIED`，**不提供任意命令接口**：

- 读：`getVersion`、`getCurrentProfile`、`listPolicies`、`getGroupMembers`、`getGroupSelection`、`listRules`、`listActiveRequests`、`listRecentRequests`、`listExternalResources`、`listTempRules`。
- 写（受全局写锁约束，只由执行器调用）：`selectGroupPolicy`、`killRequest`、`updateExternalResource(key)`、`addTempRule`、`removeTempRule`、`reloadProfile`（仅维护流程）。
- 校验：`checkProfile(path)`（官方 CLI `--check`，只读候选文件）、`testPolicy(name, url)`。

没有 `switchProfile`、`updateAllResources`、`flushTempRules`、`setOutboundMode`、`stopSurge` 原语，代码层面不可能调用。

`SurgeCliAdapter` 用 `execFile(cliPath, argv)`，从不经过 shell，argv 里只出现路径、资源 key、组名、节点名；命令字形集中在 `surge/cli-commands.ts`，每条注明「已读帮助/待 P0 核对」。`SurgeHttpAdapter` 只连回环地址，密钥来自 SecretStore，请求头 `X-Key`。两者都可以只实现一部分；`CompositeSurgeAdapter` 按原语选择已配置的实现。

### 5.2 能力门槛（`surge/capabilities.ts`）

`requireCapabilities(keys)` 读取 `capabilities` 表；状态不是 `supported`，或记录的 Surge 版本与当前版本不同，都视为未通过并抛 `CAPABILITY_UNVERIFIED`（details 列出缺失项）。门槛表：

| 动作 | 需要 |
|---|---|
| 发布节点资源（自动） | targeted_resource_refresh, policy_path_reread, connection_continuity, auto_reload_atomic_replace |
| 发布节点资源（用户手动确认） | targeted_resource_refresh, policy_path_reread, auto_reload_atomic_replace；connection_continuity 未通过时必须带 `acknowledge_continuity_unverified` |
| 任意入口模式切换、激活、普通模式 | safari_process_attribution, runtime_entry_modes, entry_rules_after_restart（记录生命周期即可，状态需为 supported） |
| 结束 Safari 旧连接 | safari_process_attribution |
| 候选节点独立预检 | independent_node_preflight（未通过：结果为 inconclusive，显示「已部署，待激活时验证」，**不借当前组测试**） |
| 场景绑定 | native_profile_id（未通过时允许绑定，但界面标注「场景 ID 稳定性待验证」） |

不满足时：保存仍成功，任务停在 `WAITING_DEPLOYMENT` 或返回 412，界面给出下一步（去 P0 页面记录实测结果）。

### 5.3 主配置受管理段（`surge/profile.ts`）

工作配置只被修改两处，均用注释边界包围，归属以数据库清单和摘要为准：

```ini
[Proxy Group]
# SFE-BEGIN group v1
SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list
# SFE-END group

[Rule]
# SFE-BEGIN entry v1
RULE-SET,sfe-entry-verify.list,SFE-ROUTE
RULE-SET,sfe-entry-block.list,REJECT
RULE-SET,sfe-entry-active.list,SFE-ROUTE
# SFE-END entry
（用户原有规则保持原样）
```

- 受管理的 entry 段必须位于 `[Rule]` 第一条，否则用户规则会先于入口命中；合并时检查。
- 初始化（维护操作 `maintenance.init`）：备份当前活动配置及其相对引用文件到数据目录 `backups/`（0700），复制为 `日常-Safari环境.conf`，插入受管理段与占位资源文件，`--check` 候选，展示差异，用户确认后写入；**由用户在 Surge 中手动切换一次**到该配置。代码不调用 switch-profile。
- 之后的合并以当前工作配置为基线：只替换边界内的内容；发现非本应用拥有的 `SFE-` 同名对象、边界缺失或被改动时停止同步并显示差异。
- 不使用 `include-all-proxies`，不用模块存节点/组。

### 5.4 节点资源（`surge/generate.ts`）

`sfe-nodes.list` 每行一个节点：

```
SFE-N-E0001-US01-v003 = socks5, 203.0.113.10, 1080, username=<u>, password=<p>, underlying-proxy=<前置节点名>
```

- 受控序列化：主机名（域名/IPv4/IPv6）、端口、名称、前置名逐项校验；用户名/密码只允许 `[A-Za-z0-9._~!@$%^&*()+\-[\]{}|:<>?/]`，否则拒绝并返回 `UNSAFE_CREDENTIAL_CHARS`（当前 Surge 语法下无法安全表达逗号、引号、等号、空白、`#`、`;`、反斜杠等）。永远不拼接原始表格文本。
- 内容 = 所有「仍需保留」的版本：每个环境的 desired、deployed、正在被选择/验证的版本；被替换的旧版本保留到安全清理窗口（无选择、无相关连接）再合批移除。
- 文件头注释含 generation 与摘要，不含秘密。文件权限 0600。

### 5.5 入口模式（`surge/entry/`）

三个规则集文件对应三个「位」：verify（检测域名 + Safari 进程 → SFE-ROUTE）、block（Safari 进程 → REJECT）、active（Safari 进程 → SFE-ROUTE）。规则顺序 verify > block > active > 用户规则。

| 模式 | verify | block | active | 效果 |
|---|---|---|---|---|
| NORMAL | 0 | 0 | 0 | Safari 继续匹配用户完整原规则 |
| BLOCKED | 0 | 1 | 0 | Safari 全部拒绝 |
| VERIFY_ONLY | 1 | 1 | 0 | 只有检测域名经 SFE-ROUTE，其余拒绝 |
| ACTIVE | 0 | 0 | 1 | Safari 全部经 SFE-ROUTE |

关闭的位写入永不匹配的占位规则（`DOMAIN,sfe-disabled.invalid`），不写空文件。

**切换顺序（无放行窗口）**：① 打开 block 并读回；② 把 verify、active 设为目标值（此时 block 仍开，Safari 最多只能访问检测域名）；③ 把 block 设为目标值并读回。每步失败都停在已确认的更严格状态，记录 `entry_mode = UNKNOWN` 或最后确认的模式，不尝试“退回”到更宽松状态。纯函数 `planEntryTransition(from, to)` 输出步骤，测试穷举 4×4 组合并断言每个中间状态的放行程度不超过 `max(from, to)` 且不会出现非目标的 ACTIVE/NORMAL。

`temp_rule` 策略复用同一位模型，只是「设位」变成按本应用记录的精确规则逐条增删（禁止 flush）；插入位置与优先级由 P0 记录后才启用。

### 5.6 含凭据文件

节点资源与工作配置在 Surge 配置目录内（用户选择的位置），权限 0600；不进 Git、日志或备份清单以外的地方。界面与文档明确说明这不是「所有密码永不落盘」。

## 6. 执行器与事务（service/src/engine）

### 6.1 队列与唯一写入者

- HTTP/IPC 处理器只做：校验 → 一个 SQLite 事务（期望数据 + operation(SAVED) + outbox）→ 返回 202。纯数据修改（展示名、账号、选项）在同一事务内直接完成为 `COMPLETED`，不入队。
- 唯一执行器串行领取 outbox；所有 Surge 写操作只在执行器内发生（全局写锁）。等待 Safari 实测时，激活操作「挂起」释放执行器，由 `submitSafariVerification` 或超时计时器重新入队继续。
- 同一 `request_id`：内容摘要相同返回原操作（`duplicate: true`）；不同返回 409 `DUPLICATE_REQUEST_MISMATCH`。
- 修改带 `expected_revision`，不符返回 409 `REVISION_CONFLICT`，details 含当前版本与脱敏差异。
- 超时或 Surge 无响应 = 未知状态：阶段 `RECONCILING`，先读 Surge 事实再决定，不重复写。

### 6.2 发布（环境新增/改代理/批量导入/手动发布）

`VALIDATING → (门槛不足) WAITING_DEPLOYMENT` 或 `→ DEPLOYING → DEPLOYED_UNVERIFIED | PREFLIGHT_OK → READY_FOR_NEXT_OPEN`：

1. 重新校验数据、前置可解析（Surge 中存在该节点）、无环路、命名唯一。
2. 生成候选资源（活动文件之外的临时目录），连同工作配置副本跑 `--check`；逐节点核对预期清单。
3. 核对基线：工作配置摘要与资源文件摘要等于上次记录（发现外部编辑 → `BASELINE_CHANGED`，停止）。
4. 门槛检查后原子替换资源文件（同目录临时文件 + fsync + rename）。
5. 枚举外部资源，找到路径指向本应用资源文件的 key（每次重新枚举，不缓存）→ `updateExternalResource(key)`。禁止更新全部。
6. 读回：SFE-ROUTE 成员包含清单中全部节点、名称唯一、原选择未变；不满足 → `READBACK_MISMATCH`，资源回滚到上一份已验证内容（同一发布路径）。
7. 记录 deployment generation 与 `deployed_proxy_revision`；非活动环境做独立预检（门槛不足则 inconclusive）。
8. 若该环境正在使用：接着走 §6.3 切换到新版本。

### 6.3 激活（受控切换）

前置：环境已绑定、目标版本已部署且在组内、门槛满足、路由不忙（同一时间只有一个路由操作；新请求会把仍在等待实测的旧操作标为被取代）。

1. 同一环境、同一版本、已 ACTIVE_VERIFIED 且实测未过期：复用，直接完成。
2. 其他环境处于使用中：请求必须带 `old_session_policy`，否则 409 `NEEDS_CONFIRMATION`（列出当前环境与两个选项）。
3. `route_epoch += 1`；记录切换前选择与模式；暂停自动打开订单与填充。
4. 入口 → BLOCKED（读回）→ `SAFARI_BLOCKED`。
5. 结束确认属于 Safari 的连接（按已验证进程路径过滤；逐条记录结果；不清空其他应用）。
6. 选择目标节点并读回 → 入口 → VERIFY_ONLY（读回）→ `VERIFY_ONLY`，路由阶段 `awaiting_safari_verify`，签发一次性 `test_id`（绑定 operation、environment、profile、epoch、deadline）。
7. 目标场景的准备页（扩展）调用 `beginSafariVerification` 拿到检测地址，请求检测服务，`submitSafariVerification` 回报出口 IP。服务核对：test_id 未用过、epoch 未变、来源 profile 正是绑定该环境的场景、未超时；在 Surge 最近请求中找到同一时间窗、Safari 进程、检测主机、经 SFE-ROUTE 的新连接；有预期出口时必须一致。
8. 通过 → 入口 → ACTIVE（读回）→ 提交 `active_proxy_revision`、实测结果 → `ACTIVE_VERIFIED`。
9. 失败/超时 → `ROLLING_BACK`：恢复切换前的节点选择（若有）并保持 BLOCKED，结果 `FAILED` 且标 `rollback_needs_reverify`；**不回退到 NORMAL、DIRECT 或其他买家出口**。回滚本身失败或无法判定 → `BLOCKED_NEEDS_ATTENTION`。

### 6.4 普通模式

显式操作：入口 → BLOCKED → 结束 Safari 连接 → NORMAL（读回）→ 清空活动环境，`NORMAL_RESTORED`。不修改 SFE-ROUTE 之外的任何东西，不删除用户临时规则。

### 6.5 启动恢复与对账

启动时：读数据库未完成操作 → 读 Surge 版本、当前配置名与摘要、入口位、组选择 → 对比数据库记录：

- 外部改了组选择/配置：路由阶段 `external_change`，警告，不抢回；重新接管需要显式激活或普通模式。
- 未完成的写操作：按「读到的事实」判断哪一步已生效，从下一步继续或回滚；不重放全部写。
- 等待实测且未超时的激活：继续等待；已超时：按 §6.3.9 处理。
- 过期 epoch 的检测结果一律拒绝。

## 7. 接口

### 7.1 HTTP（网页）

路由清单见 `packages/contract/src/api.ts` 的 `API_ROUTES`。

- 只监听 `127.0.0.1`；Host 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`（防 DNS 重绑定）；有 Origin 时必须同源；不发任何 CORS 头。
- 登录：`sfe open` 或宿主 App 通过 admin.sock 申请一次性登录码（60 秒、单次）→ 打开 `http://127.0.0.1:<port>/auth/exchange?code=…` → 设置 `sfe_session`（HttpOnly、SameSite=Strict、Path=/）→ 302 到 `/`。登录码不进日志。
- 写请求需要 `x-sfe-csrf` 头等于会话 CSRF 令牌；SSE 与 GET 只需会话。
- SSE `/api/events`：`id:` 为事件序号；支持 `Last-Event-ID`；缓冲 1000 条，超出发 `snapshot.required`；15 秒心跳注释。
- 响应头：`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、严格 CSP（只允许自身脚本与样式）。

### 7.2 原生桥（插件）

消息定义见 `packages/contract/src/native.ts`。服务端规则：

- `profileId` 只取自 BridgeEnvelope；为 null 时只允许 `getCurrentState`、`getOperation`。
- 已绑定场景只能读/改/激活自己绑定的环境；未绑定场景只能关联未绑定的环境或新建并关联。不能按场景名称自动套用。
- `requestLoginFill`：要求顶层框架、`https://www.amazon.com` 登录路径、表单目标同源、环境开启填充、该环境是当前 ACTIVE_VERIFIED 且实测未过期、epoch 未变；只返回页面实际出现的字段对应的一个值。拒绝时不说明是哪一项凭据缺失以外的细节。
- 帧格式：NDJSON，一行一个 JSON；单条最大 256 KiB；每个连接一次请求一次响应。

### 7.3 admin.sock（CLI/GPT）

同样 NDJSON：`{ "op": "<命令>", "args": {...} }`。命令与 HTTP 能力一一对应，另有 `issueLoginCode`。秘密只能通过 stdin 的 JSON 进入 CLI，CLI 再经套接字发送；命令行参数中出现秘密字段时 CLI 拒绝执行。

## 8. 网页后台（apps/web）

Vue 3 + Vite + vue-router（hash 路由）。样式只用 EasyQuick UI：`src/styles/tokens.css`（由设计系统 tokens.json 生成）、`src/styles/easyquick.css`（设计系统 bundle.css 原样）、`src/styles/app.css`（补充的少量工具类，同样读 token 变量）。图标为设计系统 Icons 组的 Heroicons outline 内联 SVG。

页面：概览（统计卡、当前路由卡、Surge 状态、能力门槛摘要、最近操作）、环境（DataTable + 筛选标签 + 编辑弹窗 + 激活确认弹窗）、导入（上传 → 预览差异/冲突 → 提交）、发布与 Surge（工作配置、generation、待部署、前置节点、初始化向导）、能力门槛（P0 记录）、操作记录、设置。状态更新来自 SSE；断线自动重连并按需重读快照。

## 9. Safari 扩展（extension）

- `manifest.json`（MV3）：`permissions: ["nativeMessaging", "storage", "tabs"]`；`host_permissions: ["https://www.amazon.com/*"]`；内容脚本只匹配 `https://www.amazon.com/ap/*` 与 `https://www.amazon.com/ax/*`，`all_frames: false`。
- 弹窗：当前场景状态（绑定、环境、买家号、页面登录状态、站点、代理、前置、实际出口与检测时间、Surge 同步）、关联/新建、使用此环境、打开或定位订单页、重新检测、编辑、进入普通模式。打开期间约 1 秒轮询操作状态，关闭即停止。
- 准备页 `prepare.html`：在目标场景内完成实测出口，成功后（环境开启自动打开订单时）打开或定位订单页；已登录不进入登录流程。
- 内容脚本：只在登录页出现邮箱/密码字段时请求填充；只填充不提交，不处理验证码或二次验证。
- 扩展不在 `storage` 中保存任何凭据；`storage.local` 只存界面偏好。

## 10. macOS 原生部分（apps/macos）

XcodeGen `project.yml` 生成工程；三个目标：

- **SafariProfileSurge.app**（宿主，菜单栏）：打开管理后台（申请一次性登录码）、服务状态、安装/卸载 LaunchAgent、打开 Safari 扩展设置。
- **SafariProfileSurge Extension**（App Extension）：`SafariWebExtensionHandler` 读取 `SFExtensionProfileKey`，组装 BridgeEnvelope，经 App Group 容器内 `bridge.sock` 转发，超时 10 秒返回错误。
- **sfe-keychain**（命令行工具）：从 stdin 读一条 JSON（set/get/delete），用 Security 框架访问 `com.sfe.SafariProfileSurge` 服务名下的通用密码项，stdout 返回 JSON；值从不出现在 argv 或日志。

## 11. 测试与验收边界

- 离线（本仓库 CI 可跑）：契约、命名、序列化/注入防护、导入、入口切换规划、发布/激活/恢复编排（FakeSurge）、HTTP 认证与 CSRF、IPC 绑定约束、秘密不外泄（扫描日志与响应）、网页组件、扩展逻辑。
- 只能在测试 Mac 上验证：P0 全部能力、Swift 编译与签名、Keychain、真实 Surge 读回、Safari 实测出口、Chrome 对照、连接连续性。见 `docs/P0-RUNBOOK.md`。

离线测试通过不代表网络验收通过；验收报告模板见 `docs/ACCEPTANCE.md`，未测项写「未验证」。
