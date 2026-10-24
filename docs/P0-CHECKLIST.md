# 测试 Mac 的 P0 执行清单

日期：2026-10-24。性质：在测试 Mac 上按顺序执行 P0 的清单，供执行者（人或代理）逐步勾选。每一步的完整做法、通过条件、证据与回退以 docs/P0-RUNBOOK.md 对应章节为准；本清单只规定**顺序、每步要记录什么、什么情况下停下**。P0-RUNBOOK §0.2 的约束全程有效：不切换配置（除用户明确安排的一次）、不 reload、不 restart-engine、不 flush、不开关接管与出站模式、不用 update 当作刷新、不导入真实买家资料；原始证据只留在测试 Mac 的限权目录。

## 1. 现状（截至 2026-10-24）

已有的真机记录：docs/verification/2026-10-24-mac-p0-increment.md（PR #11），docs/verification/2026-10-24-fixed-profile-live.md（PR #12）。

| 项目 | 现状 | 对后续的影响 |
|---|---|---|
| 版本 | macOS 27.0.1，Safari 27.0.1，Surge 6.10.0（12500，协议 25） | 每轮开头重新核对；版本变了，以前的能力记录按版本过期 |
| 固定工作配置 | 用户允许的一次初始化已完成：活动配置为「SFE-P0-测试」（原配置的副本加 26 行，四条入口 RULE-SET 全部为关闭的占位规则，SFE-ROUTE 选 REJECT）；原配置与限权备份保留 | 之后**不再切换配置**；P0 工具在这份配置上运行。产品自己的初始化（docs/INSTALL.md §3 第 4 步）会新建「日常-Safari环境.conf」并需要再手动切换一次，由用户另行安排，P0 期间不做。入口文件是旧格式占位（`AND…sfe-disabled.invalid`）：现在的服务把它读作关闭，下一次切换按未知重写，不需要重新初始化 |
| Swift XCTest、P0 `instance` | 通过（132 项；V1–V5 正常实例路径） | 代码更新后重跑 XCTest |
| `takeover_state_readable` | P0 结果通过，**尚未在网页确认** | 第 9 步一并提议确认 |
| `rule match` 原语 | 可用（IP 字面量目标）；合成域名在含 IP 规则的配置上因 DNS 失败退出 1 | 服务与 P0 的合成探测已改用 `192.0.2.1`，见证改为完整路径 PROCESS-NAME（第 3 步核对） |
| 临时规则 | 添加、后加的优先、按原文删除都已观察到 | 第 4 步由 entry 正式记录 |
| `safari_process_attribution` | **阻塞**：Safari 与独立 WKWebView 的对照没有稳定的 Safari 专属进程路径 | 整个入口方案的前提；第 2 步优先 |
| 本地 policy-path 重新读取 | **自动重载关闭时不读取**：原子替换节点资源 8 秒内成员不变，单 key update 报 skipped | `policy_path_reread`、`targeted_resource_refresh` 在“自动重载关闭”条件下不通过；新节点只能保持待部署。第 5 步在自动重载开启时再测 |
| 本地规则集重新读取 | 同样在自动重载关闭时 8 秒内未读取 | ruleset_resource 入口在该条件下不可用；第 5 步一起测 |
| 组选择与前置正向链路 | A→B→A 读回正确，真实请求经过所选节点与前置，无重载 | `fixed_profile_no_switch` 还缺 Safari 专属路由 |
| 其他应用连续性 | 300 秒内组选择期间无中断；新节点实际没有发布 | `connection_continuity` 不完整（PR #12 修正了工具误判通过的问题） |
| 独立预检 | 现有 HTTP API `/v1/policies/test` 返回 200 空响应、没有实际探测；CLI `http probe <URL> <策略标识符>` 可行 | 服务的预检要改用 CLI 路线（开发项），现有实现不通过 |
| 扩展与原生桥 | Safari 退出重开后扩展仍启用、往返成功、场景 ID 不变 | 还缺系统重启、服务生命周期、8 天、闹钟唤醒等分支 |

## 2. 开始前要用户决定或安排的事项

| 编号 | 事项 | 为什么需要用户 | 影响哪些步骤 |
|---|---|---|---|
| U1 | 允许在测量窗口内把 Surge 的「自动重载配置」**打开**（测完按用户意愿恢复） | 这是用户自己的 Surge 设置；工具从不改它。打开后 Surge 在主配置变化时会重载，本应用平时只写节点资源与入口规则集，主配置只在维护中写 | 第 5 步（policy-path 与规则集的重新读取只能在开启时再测） |
| U2 | 第 5 步在自动重载开启时**仍不读取**本地文件时，节点发布怎么办 | 用户决定 D7 是“按文档修正、由实测决定，不实现回环地址远端资源备选”。实测否定了本地文件路线时，可选：只用维护时间的同一配置重载发布（违背“不自动重载兜底”时必须由用户同意）、重新考虑回环地址远端资源（`external-resource update` 对远端资源有文档）、或接受“新节点只在维护时生效” | 第 5 步之后的开发方向 |
| U3 | PR #7（拒绝 Incoming/OS 下的通用 WebKit）是否合并 | W2：等归属实测再定 | 第 2 步之后 |
| U4 | ruleset_resource 在本机 DNS 不可用时撤销入口的读回失败（ARCHITECTURE §0「DNS 失败」） | 是否允许“见证已确认、只有真实主机探测因 DNS 失败”时以未经运行时确认完成；决定前失败即关闭 | 只影响 ruleset_resource |
| U5 | 是否同意一段短暂的断网窗口，测真实域名探测在 DNS 不可用时的表现（可选） | 会中断本机全部联网 | P0-RUNBOOK §1.6 |
| U6 | 系统重启、服务停止/重新注册、退出菜单栏 App 等打断性操作的时间 | 影响用户正在用的电脑 | 第 6、8 步 |

## 3. 执行顺序

前三项（进程归属、本地文件重新读取、App Group 原生桥）决定架构是否成立，排在最前；它们不通过时，后面依赖它们的步骤只记录、不提议 supported。

### 第 0 步：代码与工具

- [ ] 测试 Mac 上的仓库更新到包含本清单的提交（记录提交号），`npm ci`，`npx vitest run tools/p0`（应全部通过）。
- [ ] 应用代码有变化时重新构建安装（docs/INSTALL.md），重跑 XCTest（记录项数与失败数），`service.log` 中出现时间晚于替换的 `service.started`。
- **停下**：P0 测试不全通过，或构建失败。

### 第 1 步：只读盘点（P0-RUNBOOK §1.5、§4）

- [ ] `instance --surge-team-id <Team ID>`，按 §1.5 完成 V1–V8。
- [ ] `inventory --profile <SFE-P0-测试 的路径>`：记录原语映射建议（`matchRule` 应为 ok/cli，探测目标 `192.0.2.1`）、自动重载读取结果、后台安全改进与待重启状态。
- [ ] 手动执行一次 §1.6 的 DNS 失败输出记录（`rule match p0-inventory.invalid …`），把脱敏的错误文字与退出码交给开发者作测试样本。
- [ ] 手动 `ls -ld /var/empty`、`ls -A /var/empty`（§1.6）：记录属主与是否为空。
- **停下**：版本低于 6.10.0（12500）或交叉核对不一致；有待重启的后台安全改进（先重启 Mac 再测归属）。

### 第 2 步：Safari 进程归属（3.2，最优先）

- [ ] 确认没有待重启的后台安全改进（第 1 步记录）。
- [ ] `attribution`：Safari 空白测试场景、扩展页面、Chrome、另一个 WebKit 应用四步。**另外**额外用一个独立的 WKWebView 应用访问测试页（2026-10-24 的对照对象），作为第五个对照。
- [ ] 报告中写原始观察（脱敏）：每个应用每个协议（HTTP/1.1、HTTP/2、HTTP/3、WebSocket、IPv4、IPv6）在 Surge 记录中的**进程路径**、是否经过 `Incoming/OS` 路径，以及候选路径是否被任何对照应用共用。
- **通过**：存在只在 Safari（含扩展页面）中出现、从不在任何对照中出现、通过服务校验的完整路径。
- **不通过时**：记录为 `unsupported` 的证据，不扩成通用 WebKit 规则；第 4、7、8 步中依赖 Safari 路径的部分只记录，不提议；把原始观察交给用户与开发者决定架构（这是方案的前提）。

### 第 3 步：rule match 探测形式（见证核对，3.6 的一部分）

- [ ] 在第 4 步的 `entry` 主序列开头自动运行（`witnessForm`）：添加前 `rule match 192.0.2.1 process-path=<见证路径>` 退出 0、命中排在入口段之后的用户规则或 FINAL；加入临时规则后见证路径与占位路径各自精确命中、其他路径（另一标记、`/private/var/…`、大写、Chrome、Safari 路径）都不命中；删除后恢复。
- **不通过时**：ruleset_resource 在这台 Surge 上无法确认任何一步（失败即关闭）；记录 `witnessForm` 原始结果交给开发者，temp_rule 不受影响。

### 第 4 步：temp_rule 入口模式（3.6、3.7；需要第 2 步得到的 Safari 路径）

- [ ] `test-servers` 在另一个终端保持运行（§0.4 第 2 步）。
- [ ] `entry --strategy temp_rule --precedence-test temp,module`：插入探测（新临时规则的位置、rule match 求值顺序）、见证形式核对、BLOCKED → VERIFY_ONLY → ACTIVE → NORMAL 每步读回、rule match 矩阵（Safari、Chrome × 检测主机、`echo.p0.example.test`、`192.0.2.1` × TCP/UDP）、Safari 测试页各模式表现、UDP/QUIC。
- **停下**：任何一步读回不一致或出现放行窗口；工具自动回到 NORMAL 失败时先 `rollback`。

### 第 5 步：本地文件重新读取与连续性（3.9–3.13；需要 U1）

- [ ] 自动重载**关闭**的结果已有（PR #12），不重复；用户同意 U1 后手动打开「自动重载配置」，记录打开的时间。
- [ ] 一个终端 `continuity`，另一个 `refresh --auto-reload on`：规则集 canary 与节点资源的原子替换都**不调用 update**，记录 Surge 是否、多久读到新内容，是否发生整份配置重载或引擎重启（配置 canary、引擎运行时长），其他应用的长连接与 WebSocket 是否中断。
- [ ] `continuity` 的“期间执行过节点资源发布”只接受 refresh 的 `node_publication_verified`（新成员被读取、选中并实际经过；PR #12）。
- [ ] 测完按用户意愿恢复自动重载设置，记录时间。
- **通过**：自动重载开启时节点资源与规则集在限定时间内被重新读取，且没有整份配置重载或引擎重启、其他应用连接不中断。产品随后只在“自动重载开启”的实测条件下允许发布与 ruleset_resource（能力记录按该条件绑定）。
- **不通过时**：停下来交给用户决定 U2；不要用 reload 或 update 补救。

### 第 6 步：扩展与原生桥（3.3–3.5；需要 U6）

- [ ] `checklist native_bridge_ipc`：系统重启、停止/重新注册服务、服务升级（替换 App 后确认新的 `service.started`）、后台卸载后点击与闹钟唤醒、无令牌监听测试、令牌轮换、退出 App 的后台任务提示（macOS 26+，允许/不允许两种）。App Group 容器被拒绝时系统不弹提示，以往返结果为准。
- [ ] `checklist native_profile_id`：默认场景是否有场景 ID、每个命名场景的 ID 在重启、重新启用、重新签名后是否不变。
- [ ] `checklist extension_install_persistence`：不开「允许未签名扩展」时的启用状态；**8 天**项从首次安装日起算，到期再记录。
- **不通过时**：场景绑定与激活门槛保持关闭；记录 `container_denied` 等原因。

### 第 7 步：前置链路、凭据字符、独立预检（3.15、3.16、3.20）

- [ ] `chain`：正向已通过；负向（坏前置、缺失前置）需要加载新节点——第 5 步不通过时记为受阻。
- [ ] `charset`、`preflight`：预检预期不通过（HTTP API 路线），记录 CLI `http probe <合成 URL> <策略标识符>` 的结果作为开发依据。

### 第 8 步：重载影响、重启生命周期、首请求与旧连接（3.8、3.14、3.17–3.19；需要 U6）

- [ ] `continuity --reload-test`（只在用户同意一次手动「重新加载配置」时）。
- [ ] `entry --strategy temp_rule --restart-test`（Surge 退出重开由用户手动做）。
- [ ] 按 3.17 操作后 `checklist first_request_and_old_connections`；`checklist open_profile_by_id`、`checklist profile_batch_create`（只记录）。

### 第 9 步：收尾与提议

- [ ] 入口回到 NORMAL、SFE-ROUTE 为 REJECT、本工具的临时规则为 0 条：`rollback`（先只打印，再 `--execute`）只按原文删除本工具登记过的临时规则。它打印的“切回原配置、删除测试文件”是手动步骤，**这一轮不要做**：「SFE-P0-测试」现在是用户安排的固定工作配置，保持活动。
- [ ] `propose <能力> supported|unsupported --dry-run` 预览，再正式提议；由用户在网页后台「能力门槛」页逐条确认（含 `takeover_state_readable`）。

## 4. 每轮的报告

- 写一份 `docs/verification/<日期>-<主题>.md`（格式同已有的两份）：测试对象（提交号、已安装应用的提交号、版本）、本轮实际结论表（实际观察 + 判定边界）、19 项能力的证据状态、工具问题与修复、终态（入口、SFE-ROUTE、临时规则、活动配置）、尚未达到的验收。
- 只写代号与脱敏字段：不写出口 IP、账号、管理密钥、原始请求日志、浏览记录；原始证据留在测试 Mac 的 `~/Library/Application Support/SafariProfileSurge/p0/<运行编号>/`。
- 工具或产品需要修改时单独开 PR（目标分支 `claude/quirky-maxwell-amxvlf`），附回归测试与真机复验结果。
