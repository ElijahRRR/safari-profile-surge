# P0 能力门槛实测手册

日期：2026-10-22（目标 Surge Mac 6.10.0 (12500)）。性质：测试 Mac 上的操作手册。工具代码在 `tools/p0`，离线单元测试见文末。**本手册中的任何一项在测试 Mac 上实测并经网页后台确认之前，产品都按“待验证”处理，相关动作会被能力门槛拒绝。**

## 0. 总览

### 0.1 目的

P0 证明或否定 `CAPABILITY_KEYS` 中的每一项能力，并把结论以“提议”的形式交给本机服务，由用户在网页后台「能力门槛」页逐条确认。通过条件的文字与网页能力页共用 `packages/contract/src/phases.ts` 中的 `CAPABILITY_CRITERIA`（本手册逐字引用，离线测试会检查两者一致）。

### 0.2 不可改变的约束

- 只使用**空白 Safari 测试场景、测试域名（`*.p0.example.test` 与固定的检测服务主机）和本机测试代理**。从不导入买家账号、买家代理凭据或真实订单页。
- 工具**从不**调用 switch-profile / profile switch、reload、restart-engine、更新全部外部资源、flush 临时规则（`rule temp flush`、`flush-temp-rule`）、managed-profile update、module、set，也从不开关增强模式、系统代理或出站模式（feature set、mode set、global-policy set），从不停止 Surge。每条 surge-cli 命令都必须完全符合服务的 argv 允许清单（`service/src/surge/cli-commands.ts` 的 `CLI_ARGV_ALLOWLIST`）。需要切换配置、重启 Surge 或重载配置的步骤都由你在 Surge 菜单中手动完成；**不要为了测试运行 `restart-engine`**。
- 本地文件（测试节点资源、入口与 canary 规则集）写入后**不靠 `external-resource update` 生效**（HTTP API 文档，Mac 6.10.0+：“Download remote external resources immediately. … Local resources are skipped.”）：工具有界轮询，等待 Surge 自动重新读取（规则集文档：“Local files are watched and reloaded automatically when they change.”；本地 policy-path 是否被监视没有写入文档，由 3.11 测量）。update 只对本工具测试资源的单个 key 调用，只为记录它对本地资源报告什么，从不当作刷新。
- 写入之前工具先打印快照与**精确回退**，等你输入 `yes`（或显式加 `--yes`）才执行。
- 原始输出只写到仓库外的限权目录（默认 `~/Library/Application Support/SafariProfileSurge/p0/<运行编号>/`，目录 0700、文件 0600）；终端与提议只含脱敏摘要。不要把原始证据复制到仓库、聊天或工单中。
- 工具只能“提议”能力结论；“确认”只能在网页后台完成。
- 失败时记录限制，**从不**扩大成通用 WebKit 规则、从不用自动重载/重载全部掩盖问题、从不改用 DIRECT 或其他出口兜底。

### 0.3 运行方式

目标版本：**Surge Mac 6.10.0 (12500)**（2026-10-12 的稳定版，官方 appcast）。最低支持 6.10.0、构建 ≥ 12500、Controller 协议 ≥ 22（随包技能的协议门槛：“`rule`/`dns`/`http probe`/`security ban` ≥20; `geoip`, `dump performance|rule-usage|virtual-ip`, `benchmark rule-matching` ≥22 … An older core answers `Unknown command`”）；不兼容 6.5。6.11.0 测试版需要在它上面重做一次 P0（能力记录按版本与构建绑定）。命令、参数与输出假设以官方文档为准（手册 https://manual.nssurge.com/tools/cli.html、https://manual.nssurge.com/tools/http-api.html、随包技能 `Surge.app/Contents/Resources/Skills/surge/`、`surge-cli help <command>`）；文档没有写明的（`--raw` 的键名、多条临时规则的先后、本地 policy-path 是否被监视等，见 §1.6）在代码中标为 TODO(P0)，实测之前按失败处理。

Surge 的版本与构建号由服务与本工具用同一个只读读取器从**运行中的 Surge 实例**取得（当前用户唯一的 `/Applications/Surge.app` 主进程 → 它的 Info.plist，并用启动时间、文件 ctime/birthtime、lsof 与 codesign 证明磁盘上的包就是正在运行的那一份；见 ARCHITECTURE §5.2 与本手册 §1.5），再与 `surge-cli --raw version`（Mac 6.8.0+：“Show Surge, Core, Controller protocol, operating-system, and device versions.”）交叉核对：两者的版本与构建号相同、不低于最低版本、Controller 协议 ≥ 22 才接受。`getVersion` 必须映射为 `cli`（inventory 会这样建议）；没有映射、读不到、不一致或低于最低版本时版本为空：`propose` 拒绝依赖 Surge 版本或构建的能力（supported 与 unsupported 都拒绝，并给出原因），服务也拒绝这类提议并把已有记录显示为待验证；6.5 上的旧记录按版本与构建自动过期，需要重测。读取器的规则在本机通过 §1.5 的 V1–V8 之前，不要据它读到的版本确认依赖版本的能力。本机安装包版本（`defaults read`）只作旁证，不能替代运行实例版本。`surge-cli --version` 不是文档中的选项，产品与工具都不使用它（V8 只记录它现在的行为）。

在测试 Mac 上克隆仓库后：

```sh
npm ci
npx tsx tools/p0/src/cli.ts help
```

需要 Node 22.13 或更高。通用选项：

| 选项 | 说明 |
|---|---|
| `--raw-dir <目录>` | 原始证据根目录（默认见上；位于 Git 工作树、iCloud/云盘、文稿/桌面/下载时拒绝。与服务相同按真实位置判断：指向这些位置的符号链接别名（例如指向 `~/Library/CloudStorage/Dropbox` 的 `~/Dropbox`）、大小写变体与尚未创建的子目录同样拒绝，无法确认真实位置时也拒绝） |
| `--run <运行编号>` | 使用指定运行；缺省为最近一次 |
| `--profile <路径>` | Surge 配置文件的绝对路径（Surge →「配置」→ 在访达中显示） |
| `--surge-cli <路径>` | 默认 `/Applications/Surge.app/Contents/Applications/surge-cli`；必须通过 `codesign --verify` |
| `--surge-team-id <Team ID>` | 校验 Surge CLI 签名的 Team ID（建议提供） |
| `--proxy 127.0.0.1:6152` | Surge 的 HTTP 代理端口（Surge →「设置」→「代理服务」中查看） |
| `--mechanism <原语>=cli\|http\|unavailable` | 临时覆盖原语实现（只用于对比；正式映射以 inventory 结论为准） |
| `--yes` / `--non-interactive` | 跳过确认 / 不提问（需要人工观察的步骤会记为未完成） |

工具没有任何接收密码、密钥或令牌的参数；出现形似凭据的参数会直接拒绝。

### 0.4 顺序

| 顺序 | 阶段 | 命令或操作 | 产出的能力结论 |
|---|---|---|---|
| 1 | 盘点（只读） | `instance` 并按 §1.5 完成 V1–V8；`inventory --profile <当前配置>`（读取逐条命令帮助、核对 `surge-cli --raw version`） | takeover_state_readable；原语映射建议；运行中 Surge 版本与交叉核对的证据 |
| 2 | 测试服务 | 另开终端 `test-servers`，全程保持运行 | — |
| 3 | 测试配置 | `make-test-profile`，然后**手动**在 Surge 中切到「SFE-P0-测试」，再 `inventory --run <编号> --profile <测试配置>` | — |
| 4 | 进程归属 | `attribution` | safari_process_attribution |
| 5 | 扩展与原生桥 | 构建安装（见 docs/INSTALL.md）后 `checklist` 三项 | native_bridge_ipc、native_profile_id、extension_install_persistence |
| 6 | 入口模式 | `entry --strategy …` | runtime_entry_modes、safari_udp_quic_handling |
| 7 | 本地文件重新读取与连续性 | 一个终端 `continuity`，另一个 `refresh`（自动重载开、关各一次；不调用 update，测量 Surge 的自动重新读取） | auto_reload_atomic_replace、targeted_resource_refresh、policy_path_reread、fixed_profile_no_switch、connection_continuity |
| 8 | 前置链路与凭据字符 | `chain`、`charset` | external_node_underlying_proxy；凭据字符白名单 |
| 9 | 独立预检 | `preflight` | independent_node_preflight |
| 10 | 重载影响 | 单独运行 `continuity --reload-test`：对照 45 秒后输入 `reload`，再立即在 Surge 中手动「重新加载配置」（6.9.0 起可能自动升级为完整引擎重启，工具按引擎运行时长记录） | same_profile_reload_impact |
| 11 | 重启生命周期 | `entry --strategy … --restart-test` | entry_rules_after_restart |
| 12 | 首请求与旧连接 | 按清单操作后 `checklist first_request_and_old_connections` | first_request_and_old_connections |
| 13 | 只记录项 | `checklist open_profile_by_id`、`checklist profile_batch_create` | 两项只记录 |
| 14 | 回到原配置 | `rollback --execute`，**手动**切回原配置，删除测试文件 | — |
| 15 | 提议与确认 | `propose <能力> supported\|unsupported`，在网页后台确认 | 全部 |

每一步结束都会在 `<运行目录>/results/<能力>.json` 写入检查项与结论（通过 / 不通过 / 不完整）。`propose … supported` 只接受“通过”的结果。

## 1. 准备

### 1.1 测试 Mac 与应用

- 记录 macOS、Safari、Surge 的版本（instance 与 inventory 会读取并写入证据）。Surge 必须是 6.10.0（12500）或更新：低于它时 instance 退出 3、依赖版本的能力不能提议。命令以 6.10 官方文档为准；文档没有写明的行为以本机实测为准（§1.6），不借用旧版本（6.5）的实测结论。
- Safari：新建一个**空白测试场景**（Safari →「设置」→「场景」→ 新建，例如「P0-测试」），不登录任何账号、不访问 Amazon。归属测试期间关闭其他 Safari 窗口。
- Chrome：作为对照应用，保持一个窗口。
- 另一个 WebKit 应用：用于证明候选路径不是系统通用 WebKit 进程（例如「邮件」的快速查看预览、「快捷指令」的「获取 URL 内容」）。
- Surge：增强模式或系统代理至少一项开启，出站模式为规则模式。记录当前是哪一项（能力上下文中的 `takeoverMode`）。
- 后台安全改进（Background Security Improvement）：测进程归属前不能有待重启的后台安全改进。Apple：“After Safari has been relaunched, it uses the framework and library content from the new cryptexes. The rest of the operating system remains unaffected and doesn't make use of the new content until the system restarts.”（https://support.apple.com/guide/security/background-security-improvements-sec87fc038c2/web）这期间测到的路径可能只是暂时只属于 Safari。inventory 列出「后台安全改进（sw_vers -productVersionExtra）」与「后台安全改进待重启」；后者不是「否」时先重启 Mac。系统设置的软件更新页提示需要重启时同样先重启（工具的判断依据尚待 §1.6 核对）。

### 1.2 测试主机

| 主机 | 用途 |
|---|---|
| `echo.p0.example.test:<回显端口>` | 测试页、回显、长连接流、WebSocket（只能经本机测试出口访问） |
| `chain.p0.example.test` | 测试规则把它交给 SFE-ROUTE，工具用它验证所选节点 |
| `c<N>.canary.p0.example.test` | 规则集 canary：测量本地规则集的文件监视（见 3.9） |
| `p<N>.pcanary.p0.example.test` | 配置 canary：重载检测（见 §1.4） |
| `api.ipify.org`、`api64.ipify.org` | 固定的检测服务（与扩展相同） |
| `api6.ipify.org` | 只有 IPv6 的检测主机 |
| `cloudflare-quic.com` | HTTP/2、HTTP/3 测试页（`/cdn-cgi/trace` 显示 `http=` 协议） |

测试出口只把 `*.p0.example.test` 转到本机回显服务；公网主机只允许上表中的检测与 H3 主机（80/443），其他目标一律拒绝，因此测试代理不是开放代理。

### 1.3 测试配置的结构

`make-test-profile` 从当前配置的只读副本生成「SFE-P0-测试.conf」，与源配置同目录（或 `--target-dir` 指定的本机目录），全部文件以 O_EXCL 0600 新建、已存在即拒绝：

- `[Proxy Group]` 末尾加入与正式产品相同的受管理段 `SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list`；`[Rule]` 最前加入四条入口 RULE-SET（udp > verify > block > active，初始全部为占位规则）。文件名与正式产品一致，用来证明真实的资源 key 与位置识别。
- `[Proxy]` 末尾加入本机测试节点：`P0-Front`（前置）、`P0-Front-Dead`（端口无服务）、`P0-Plain` 与 `P0-Canary`（普通测试出口）。凭据是合成的，只对本机测试服务有效。
- 入口段之后加入四条测试规则：canary 规则集 → P0-Canary；配置 canary `DOMAIN,p0.pcanary.p0.example.test,P0-Canary`（工具之后只改写这一行的编号）；`chain.p0.example.test` → SFE-ROUTE；`*.p0.example.test` → P0-Plain（Chrome 与工具自身访问测试主机走这里）。
- 源配置没有 http-api 时加入只监听 127.0.0.1 的 http-api（随机密钥，关闭 TLS 与网页仪表盘）；源配置绑定到非回环地址时在副本中改为回环。不需要时用 `--no-http-api`。
- 源配置带 `#!MANAGED-CONFIG` 时副本移除该行（避免被远端更新覆盖）。
- 另生成测试模块 `SFE-P0-precedence.sgmodule`（启用时加入 `DOMAIN,<检测主机>,DIRECT`），只在优先级测试中由你手动启用。

源配置已经含 SFE 受管理段（初始化之后复测）时，测试配置整段替换为测试内容、从不引用真实环境节点；但同目录中已有 `sfe-*` 文件，工具会拒绝写入，此时用 `--target-dir` 指定单独的本机目录，并在 Surge 设置中**手动**把配置目录临时指向它，测完再改回。测试配置位于 iCloud/同步目录时拒绝写入（正式产品同样不在此写入）；目标目录按真实位置判断，别名、大小写变体与无法确认真实位置的目录同样拒绝。

### 1.4 “未重载”信号（P0 定义）

ARCHITECTURE 要求记录“P0 定义的未重载信号”。Surge 6.10 上工具使用五个信号，任何一个变化即判定发生了重载或重启：

1. **配置 canary**：原子替换测试配置（主配置）中的配置 canary 行（只改编号），之后经 Surge 代理请求 `p<N>.pcanary.p0.example.test`。按新内容命中（经 P0-Canary）说明 Surge 重新读取了主配置，即发生了配置重载（6.9.0 起 reload 只应用差异，同样会读取这一行）。规则集 canary 不再用作重载检测：本地规则集文件本来就会被 Surge 的文件监视重新读取（3.9 测量它）。
2. **引擎运行时长**（`getRuntimeInfo`：`--raw dump performance` 的 uptime，或 `/v1/metrics` 的 `surge_uptime_seconds`）变小：引擎重启。`restart-engine` 或 6.9.0 起需要时自动升级的 reload（“Automatically performs a full engine restart if a change requires one.”）都会这样；进程本身不变，所以第 3 条看不到。
3. **Surge 进程启动时间**（`ps -o lstart`）变化：Surge 退出重开。
4. **本工具之外的临时规则减少**：引擎重启与退出都会清空临时规则（帮助：“discarded when Surge stops”）；reload 保留它们（“Unaffected connections, caches and temporary rules are preserved.”）。
5. **当前配置名**变化。

自动重载开启时，替换主配置本身可能触发重载，配置 canary 就不能用于后续步骤；工具会提示，相关的“没有整份配置重载”检查记为不完整（不是通过），只用另外四个信号与连接影响判断。

### 1.5 运行中 Surge 的版本（只读核对 V1–V10）

服务与本工具的 Surge 版本只来自运行中的 Surge 实例（`service/src/surge/running-instance.ts`，双方同一读取器）。下面的核对**全部只读**：不写 Surge 或它的任何文件，不切换配置，不由工具退出或重启 Surge（V7 由你手动退出并重新打开），**从不为了测试而触发或安装更新**。用 `instance` 命令读取并保存证据（它不执行 surge-cli；与 `surge-cli --raw version` 的交叉核对在 inventory 与每次能力上下文测量中进行，见 V8）：

```sh
npx tsx tools/p0/src/cli.ts instance [--surge-team-id <Team ID>]
```

它逐条打印规则结果（进程、主程序、启动时间、包信息、启动后未修改、运行映像、签名、读取期间未变化）与已排除的其他 Surge 相关进程，并把完整证据（每条规则的结果与耗时、ctime/birthtime 与启动时间之差、lsof 是否一致、codesign 退出码）写入 `<运行目录>/instance/<时间>.json`；能确认且不低于最低支持版本 6.10.0（12500）时退出 0；无法确认或低于最低版本时退出 3 并打印原因。P0 的 codesign 超时为 60 秒（为了记录真实耗时），服务只等 15 秒，引擎对每次读取另有 8 秒总时限，所以 instance 同时按服务的时限核对：签名一步达到 15 秒，或缓存命中后每次仍要执行的步骤（除包信息与签名外的全部规则：ps、plutil、stat、lsof）合计达到 8 秒时，服务读不到这个版本——instance 照样打印读到的版本，但提示是哪一项超时并退出 3，inventory 与能力上下文把版本记为未知，propose 拒绝依赖版本的能力。inventory 同样读取一次并写入 `inventory/surge-instance.json`，「运行中的 Surge」一行显示结论，磁盘上的 Surge.app 版本只作旁证（两者不一致时提示）。`--surge-team-id` 只会让签名校验更严。V1–V8 全部通过之前，不要据读到的版本确认依赖版本的能力；代码中标为 TODO(P0) 的 `SURGE_BUNDLE_IDS` 要在 V2 之后才定稿。以下命令中的 `<pid>` 是 instance 打印的进程号。

| 编号 | 核对 | 做法 | 期望 | 证据 |
|---|---|---|---|---|
| V1 | 进程列表 | `LC_ALL=C LANG=C TZ=UTC /bin/ps -ww -axo pid=,uid=,lstart=,comm=`，与 instance 结果对照 | 当前用户恰好一行完整路径 `/Applications/Surge.app/Contents/MacOS/Surge`（`comm` 是进程自己提供的 argv[0]，不是内核给出的可执行文件路径——ps(1)：“a process is entitled to destroy this information”——所以这一列只作候选，是不是运行中的那份文件以 V4 的 lsof txt inode 与路径为准）；其他 Surge 相关进程（root 特权助手、`Contents/Applications/surge-cli`、包内的登录项等）都出现在 instance 的“已排除”列表中；启动时间与「活动监视器」及 `ps -o etime= -p <pid>` 一致；instance 没有提示超过服务读取的时限（除包信息与签名外各规则的耗时合计在 8 秒内：服务每次读取都要执行这些步骤，超过引擎的总时限即读不到版本） | instance 证据的 process、bundle_executable、start_time 与各规则的 ms |
| V2 | Info.plist | `/usr/bin/plutil -extract CFBundleShortVersionString raw -o - /Applications/Surge.app/Contents/Info.plist`，再分别读 `CFBundleVersion`、`CFBundleIdentifier`、`CFBundleExecutable` | 版本与构建号等于 Surge「关于」窗口（例如 6.10.0 (12500)）；记录包标识与主程序名，交给开发者填写 `SURGE_BUNDLE_IDS` | 命令输出、关于窗口截图、info_plist |
| V3 | 文件时间与重启 | `stat -f '%c %B' /Applications/Surge.app/Contents/Info.plist /Applications/Surge.app/Contents/MacOS/Surge`；分别在正常打开、在 Surge 菜单中退出后重新打开、注销再登录之后运行 instance | 每次都早于启动时间（证据中相对启动的毫秒数为负）；连续几天每天运行一次，记录任何让这条检查误判失败的元数据变化 | not_modified |
| V4 | lsof | `/usr/sbin/lsof -nP -a -p <pid> -d txt -F in` 与 `stat -f %i /Applications/Surge.app/Contents/MacOS/Surge` | 主程序那一项的 inode 与路径都一致；记录是否需要额外权限与耗时 | running_image |
| V5 | 签名 | `/usr/bin/codesign --verify --strict /Applications/Surge.app`；`/usr/bin/codesign -dv --verbose=2 /Applications/Surge.app` 读取 TeamIdentifier | 退出 0，且在 15 秒内完成（服务的 codesign 超时；更慢时服务按签名校验未通过处理，instance 提示并退出 3）；记录耗时与 Team ID，然后用 `instance --surge-team-id <Team ID>` 复核 | signature（耗时见各规则的 ms） |
| V6 | 规则自测（不碰 Surge） | 见下方步骤：在运行目录中做一个临时 App，用 `instance --self-test-bundle <该 App>` 核对 | 直接启动：通过；原子改写其 Info.plist：`modified_after_start`；启动前 `cp -p` 一份主程序、启动后用 `mv` 覆盖：`running_image_mismatch`（APFS 改名不更新 ctime 时）或 `modified_after_start`（更新时）——记录是哪一个；给包目录加扩展属性：仍通过 | `instance/selftest-*.json` |
| V7 | Surge 未运行 | 在 Surge 菜单中手动退出 Surge，运行 instance；再逐条运行（`S=/Applications/Surge.app/Contents/Applications/surge-cli`）：`time "$S" --raw external-resource list </dev/null; echo "exit=$?"`、`"$S" --raw status </dev/null; echo "exit=$?"`、`"$S" --raw dump temp-rule </dev/null; echo "exit=$?"`、`"$S" help kill </dev/null; echo "exit=$?"`、`"$S" --check "<测试配置路径>" </dev/null; echo "exit=$?"`；之后手动重新打开 Surge | instance 报告 `not_running`（退出 3）。按 6.8.0 发布说明（“Command errors are now written to standard error and produce a non-zero exit status.”），三条读命令应在 stderr 打印 6.10 包内 surge-cli 的 `Surge isn't running on the local machine. Use --remote to specify a remote target.` 并以非零状态退出，服务据此（以及 controller connection timed out / was closed、connection interrupted 等文字）判为无法连接；`help` 只是帮助文字，`--check` 列在帮助的 Utilities 中（与离线的 lsp 同组），两者能否在 Surge 未运行时照常输出以实测为准。记录每条的 stdout、stderr、退出码与耗时，交给开发者核对 `UNREACHABLE_TEXT_RE`（TODO(P0)）；`dump temp-rule` 的空输出无法与“没有临时规则”区分，不用于可达性检测 | 终端输出 |
| V8 | 版本交叉核对 | （`S` 同 V7，Surge 运行中）`"$S" version </dev/null; echo "exit=$?"` 与 `"$S" --raw version </dev/null; echo "exit=$?"`；运行 inventory，查看「版本交叉核对（surge-cli --raw version）」一行与 `inventory/surge-version.json`；最后记录 `time "$S" --version </dev/null; echo "exit=$?"` 现在的行为 | `--raw version` 输出 JSON：版本与构建号等于 instance 读到的值（例如 6.10.0、12500），`controller-protocol` 是不小于 22 的数字，另有数字 `core-version`；inventory 显示「通过：6.10.0（12500）· Controller 协议 …」，`propose` 才会接受依赖版本的能力。记录版本与构建号的原始键名（没有写入文档，TODO(P0)），不要把设备名、设备标识与系统版本复制到工单（适配器读取后即丢弃）。`--version` 不是文档中的选项（6.10 帮助只列 `--raw`、`--remote/-r`、`--password-stdin`、`--check/-c`），产品与工具从不使用：只记录它是打印交互模式提示（服务与 P0 按 `interactive_mode` 处理）还是 `Unknown command` 加非零退出，以及是否在 2 秒内结束。再核对 inventory 的帮助原文与调用记录：顶层 `--help` 与每条 `help <command>`（`inventory/surge-cli-help/`）都不是交互模式提示，每个已映射的读原语与测试配置的 `--check` 都没有出现该提示；记录写命令（`rule temp add/remove`、`policy-group set SFE-ROUTE`、`external-resource update <key>`）在 refresh/entry 中执行时的原始输出，交给开发者收紧解析 | 终端输出、`inventory/surge-version.json`、`inventory/surge-cli-help.txt` 与 `inventory/surge-cli-help/`、调用记录 |
| V9 | HTTP API | 测试配置启用回环 HTTP API 时：`curl -sS -D - -o /dev/null http://127.0.0.1:<端口>/v1/outbound`（不带密钥） | 只记录响应头名称与任何像版本的值（Mac 6.9.0+ 的 `/v1/metrics` 文本中 `surge_build_info{version,build}` 也只作旁证记录）；**不使用**（即使有，将来也只作交叉核对，与运行实例不一致时版本为空）。需要带密钥的请求时用 `curl -H @<0600 的头文件>`，不要把密钥写在命令行 | 终端输出 |
| V10 | 真实更新 | 只在 Surge 自己提示有更新、你本来就要更新时进行：安装后如果 Surge 没有立即自动重新打开，先运行 instance；重新打开后再运行一次 | 重新打开前：给出失败原因（例如 `modified_after_start`、`running_image_mismatch`），从不显示新版本；重新打开后：显示新版本。Surge 自动重新打开时只记录这一点。**不要为了测试而触发更新** | 两次 instance 证据 |

V6 的步骤（全部在运行目录中，命令在仓库根目录执行）。`RUN` 必须是运行目录的**绝对路径**：默认为 `$HOME/Library/Application Support/SafariProfileSurge/p0/<运行编号>`，`<运行编号>` 是 instance 标题中「运行」后面的编号；用过 `--raw-dir <目录>` 时把 `RUN=` 一行换成 `<目录>/<运行编号>`（同样写绝对路径），之后每条 instance 命令都加上同一个 `--raw-dir <目录>`。instance 打印的证据路径把主目录显示为 `~`，不要原样放进引号：引号里的 `~` 不会展开，命令会在当前目录（仓库）下建出名为 `~` 的目录，`--self-test-bundle` 也会因为不是绝对路径被拒绝；照抄时把 `~` 换成 `$HOME`。每种情况用一个新的临时 App：把 `CASE=plain` 换成该情况的名字（plain、plist、mv、xattr）后从 `CASE=` 一行重新执行，每次都会建一个带时间的新目录（不复用上一次的 Info.plist、扩展属性或进程）。

命令块中**没有注释**，说明都写在正文里：macOS 终端缺省的 zsh 不把行中的 `#` 当作注释（`#` 及其后的文字会作为参数传给命令，`<…>` 还会被当作重定向），bash 与 zsh 都可以直接粘贴执行。第一段建出临时 App、启动它并运行一次 instance（期望通过）；`cp -p` 一行先保存一份主程序，只在 mv 的情况用到。

```sh
RUN="$HOME/Library/Application Support/SafariProfileSurge/p0/<运行编号>"
case "$RUN" in /*) [ -d "$RUN" ] && echo "RUN 可用" || echo "RUN 不存在，请核对运行编号" ;; *) echo "RUN 必须是绝对路径（不要用引号里的 ~）" ;; esac
CASE=plain
DIR="$RUN/selftest/$CASE-$(date +%Y%m%d%H%M%S)"; APP="$DIR/SFE-P0-Selftest.app"; mkdir -p "$APP/Contents/MacOS"
printf '#include <unistd.h>\nint main(void){for(;;)pause();}\n' > "$DIR/main.c"
cc -o "$APP/Contents/MacOS/selftest" "$DIR/main.c"
plutil -create xml1 "$APP/Contents/Info.plist"
plutil -insert CFBundleIdentifier -string test.sfe.p0.instance-selftest "$APP/Contents/Info.plist"
plutil -insert CFBundleExecutable -string selftest "$APP/Contents/Info.plist"
plutil -insert CFBundleShortVersionString -string 1.0.0 "$APP/Contents/Info.plist"
plutil -insert CFBundleVersion -string 1 "$APP/Contents/Info.plist"
codesign -s - --force "$APP"
cp -p "$APP/Contents/MacOS/selftest" "$DIR/selftest.copy"
sleep 2; "$APP/Contents/MacOS/selftest" & SELFTEST_PID=$!
npx tsx tools/p0/src/cli.ts instance --run <运行编号> --self-test-bundle "$APP"
```

然后按情况改动（plain 不改动），再运行一次 instance 并结束进程：

- plist（原子改写 Info.plist，期望 `modified_after_start`）：`plutil -convert xml1 -o "$DIR/Info.new" "$APP/Contents/Info.plist" && mv "$DIR/Info.new" "$APP/Contents/Info.plist"`
- mv（用启动前保存的副本覆盖主程序，期望 `running_image_mismatch` 或 `modified_after_start`，记录是哪一个）：`mv "$DIR/selftest.copy" "$APP/Contents/MacOS/selftest"`
- xattr（包目录扩展属性，期望仍通过）：`xattr -w com.example.sfe-p0 1 "$APP"`

```sh
npx tsx tools/p0/src/cli.ts instance --run <运行编号> --self-test-bundle "$APP"
kill "$SELFTEST_PID"
```

### 1.6 文档没有写明、要在测试 Mac 上实测的行为（TODO(P0)）

下列各项在代码中标为 TODO(P0)，实测之前一律按失败处理（读不到即不可用、不确定即不通过）。逐项记录实际结果（原始输出只在运行目录），交给开发者收紧解析或调整门槛；不要为了得到结果而运行允许清单之外的命令。

- `--raw` 的键名：`version`（版本与构建号的键名）、`status`（`profile` 是否带 `.conf`、`profile-path`）、`feature get enhanced-mode|system-proxy`、`mode get`、`policy-group get SFE-ROUTE` 与 `policy-group list`（policy-path 中的成员是否出现在 list 中）、`dump performance`（uptime 的单位）、`dump temp-rule`（空与非空）、`dump active` / `dump recent`（请求 id、进程路径、策略、规则字段）、`rule match`（`rule`、`policy` 的键名）、`external-resource list`（`local`、`updating`、`fromModule`、`error`）。inventory 的 `values` 与调用记录给出能否解析；原始输出用 V8 的方法手动查看。
- `external-resource update <本地资源 key>` 的输出与退出码（文档：本地资源被跳过；6.10 包内文字有 “No remote external resource needed updating.”）：3.9 与 3.11 记录。
- 本地规则集被文件监视重新读取的延迟，以及它是否只重新读取该规则集（不是整份配置重载、不是引擎重启、其他应用连接不受影响）：3.9。
- 本地 policy-path 文件是否被监视（不调用 update 时 SFE-ROUTE 成员是否变化、选择是否保留、连接是否受影响）：3.11。没有被监视时新节点保持“已保存，待部署”，不实现回环地址的远端资源替代方案。
- 多条临时规则之间的先后（帮助只写 “Add a temporary rule with the highest priority”）、`rule match` 是否包含临时规则、命中规则集时 `rule` 是 RULE-SET 行还是子规则、“final policy” 是组名还是组内选择：3.6。
- 含空格的进程路径作为单个 argv 元素能否被 `rule match process-path=` 与 `rule temp add` 完整接受：3.6（`--process-path` 用实际的 Safari 路径）。
- 哪个请求字段是 `kill <connection-id>` 的 id：3.6 的结束连接记录。
- `--check` 对无效配置的退出码：make-test-profile 的 `--check` 记录；可另用一份故意写错的合成配置手动核对。
- 6.9.0 起哪些改动会让 reload 升级为完整引擎重启：3.14 只记录本次是否升级，不据一次结果推断规则。
- 后台安全改进的识别（服务与 P0 同一规则，见 `service/src/engine/capabilities.ts`）：先记录 `man sw_vers` 中 `-productVersionExtra` 的原文；再在**没有安装**、**已安装未重启**（Safari 已重开）、**重启后**三种状态下各记录一次 `/usr/bin/sw_vers`（完整输出）、`/usr/bin/sw_vers -productVersionExtra`（输出与退出码，没有安装时是否为空）、`ls -ld /System/Volumes/Preboot/Cryptexes/Incoming`（是否存在、普通用户能否读取），以及 inventory 的两行结果。`Incoming` 这个暂存位置是测试 Mac 上的观察，Apple 没有写明路径（只写到 “applying the Incoming Cryptex”）。没有待重启时它也存在 → 依赖进程归属的三项（归属、UDP/QUIC、首请求与旧连接）会一直待验证，交给开发者改判断方法；装上后不出现 → 工具发现不了待重启，测试者继续按 §1.1 人工核对，同样交给开发者。补充版本在安装时还是重启后才变化，以及 Safari 进程路径在三种状态下是否不同（`/Applications/...`、`/System/Cryptexes/...` 或 `/System/Volumes/Preboot/Cryptexes/...`），一并记录。移除后台安全改进同样要重启才完成，有条件时也按三种状态记录一次。

## 2. 通用回退

任何时候出现意外（页面持续无法访问、Chrome 受影响、读回不一致）：

1. 入口回到普通模式：`npx tsx tools/p0/src/cli.ts entry --strategy <策略> --to NORMAL`（ruleset_resource 总是允许；temp_rule 的例外：插入探测已报告 listTempRules 不可用时无法读回，工具拒绝并提示直接执行第 2 步；listTempRules 还没有经过插入探测正向确认时照常切换，但会提示读回不能证明规则已删除，接着执行第 2 步）。
2. 删除本工具添加的临时规则：`rollback`（只打印）→ `rollback --execute`（确认后逐条按原文删除，读回确认；回退计划与读回确认都按规范化文本比较，Surge 列出时改了空格的规则仍判定为存在；从不 flush，不删除你自己的临时规则）。只有经过插入探测正向确认的临时规则列表才被当作“已不存在”的证据：未确认或已报告不可用时，回退计划逐条尝试删除本工具登记的全部规则，删除后无法读回确认（退出码 1），请在 Surge 中手动核对。
3. 在 Surge 菜单「配置」中**手动**切回原配置（inventory 记录的名称）。
4. 确认增强模式、系统代理与出站模式与盘点时一致。
5. 在 test-servers 终端按 Ctrl+C。
6. 确认 Surge 已不在「SFE-P0-测试」后，把 `rollback` 列出的测试文件移到废纸篓（只删列出的文件）。

测试配置中的 SFE-ROUTE 选择、测试节点资源与入口规则集只存在于测试配置；切回原配置后它们不再生效。

## 3. 逐项能力

每一项都按“用途 → 前置条件 → 步骤 → 通过条件 → 失败处理 → 保留的证据 → 回退”书写。证据字段按 DEVELOPMENT §9：测试编号、时间、场景代号、扩展/入口状态、期望节点、Surge 实际策略、实际出口、连接处理结果、配置身份、对照应用结果。原始证据都在运行目录中，下文只写路径。

### 3.1 takeover_state_readable（接管与出站模式读取）

- **用途**：服务对账时判断接管是否丢失、出站模式是否被改。读不到时产品只显示 `takeover_unknown` 并要求新的 Safari 实测。
- **前置条件**：无。
- **步骤**：`inventory --profile <当前配置路径>`。结果按建议的原语映射重新读取一次。
- **通过条件**：能经固定原语只读获取增强模式、系统代理与出站模式。
- **失败处理**：记录为不支持；产品保持 `takeover_unknown` 行为，不通过其他手段猜测接管状态。
- **证据**：`inventory.json`（probes、values.getTakeoverState）、`surge-calls.jsonl`、`results/takeover_state_readable.json`；配置身份；时间。
- **回退**：只读，无需回退。

### 3.2 safari_process_attribution（Safari 精确进程归属）

- **用途**：入口规则只能匹配 Safari 的完整进程路径；这是整个方案的前提。
- **前置条件**：测试配置已手动切换；test-servers 在运行；`listRecentRequests` 有可用实现（通常需要测试配置中的回环 http-api，并已用测试配置重新 inventory）；没有待重启的后台安全改进（§1.1）。工具检测到待重启或无法确认时开头即警告，结论记为「不完整」（检查项「没有待重启的后台安全改进」），本次候选路径不作为后续测试的进程路径，重启 Mac 后重测。
- **步骤**：
  1. `attribution`。按提示依次进行四步，每步完成后回车：
     - Safari 空白测试场景：打开 `http://echo.p0.example.test:<端口>/attr/safari`，依次点击 HTTP/1.1、IPv4、IPv6、WebSocket（等约 5 秒）、WebRTC；点击「打开 HTTP/2 · HTTP/3 测试页」，在新标签页刷新 3 次，输入最后一次 `http=` 的值。
     - Safari 扩展页面（扩展已安装时）：让扩展页面自己请求检测服务（覆盖 `extension_page_fetch`）。Safari「设置」→「高级」勾选「显示网页开发者功能」；在同一场景点击扩展图标打开弹窗，在弹窗中右键 →「检查元素」，在检查器控制台运行 `fetch('https://api.ipify.org/?format=json')`，看到返回后关闭检查器。**不要用弹窗的「重新检测」代替**：它由本机服务执行检测（服务未进入受控状态时被拒绝），不是扩展页面请求，在这一步产生的服务进程记录会被误当作扩展页面的进程路径。未安装时输入 `skip`，之后补测。
     - Chrome：打开 `…/attr/chrome`，做同样的点击。
     - 其他 WebKit 应用：加载 `…/attr/other`。
  2. 工具在每步结束时读取 Surge 最近请求，按时间窗与测试主机归到对应应用，只保留测试主机（其他主机记为空，不保存浏览记录）。
- **通过条件**：Safari 实际连接（含扩展页面请求）按完整进程路径命中，Chrome 与其他 WebKit 应用不命中；IPv4/IPv6、HTTP/1.1、HTTP/2、HTTP/3、WebSocket 逐项通过或写明限制；DNS、WebRTC、系统服务另列覆盖情况。
- **判定细节**：候选路径 = 只在 Safari 步骤中命中测试主机、从未在 Chrome 与其他 WebKit 应用步骤中出现的路径；还必须通过服务的同一套校验（绝对路径、存在、无通配、非裸进程名、不是系统通用 WebKit 框架路径）。Chrome 与其他 WebKit 应用两项对照只以该应用**访问测试主机的记录**为证据：对照步骤里只有 Safari/WebKit 后台请求（主机记为空）、或对照应用没能访问测试主机（例如邮件屏蔽了远程内容）时，该项为“不完整”而不是通过，需要换一种方式让对照应用访问测试页后重测。门槛协议（ipv4、ipv6、http1、http2、http3_quic、websocket、extension_page_fetch）每项必须是 pass，或写明 limitation（例如测试网络没有 IPv6）；DNS、WebRTC、系统服务只记录。
- **失败处理**：只有通用 WebKit 进程路径、或路径被 Chrome/其他应用共用时，记录为不支持并停止宣称“整个 Safari 可控”；**不扩成通用 WebKit 规则**。某个协议不归属 Safari 路径（例如 QUIC 由其他进程发出）时写成限制或不通过。
- **证据**：`attribution/*-records.json`（每步的进程路径、协议、策略）、`attribution/analysis.json`、`servers/page.jsonl`（测试页上报，不含出口 IP）、`results/safari_process_attribution.json`；测试编号即测试页的 `t` 参数；场景代号（P0-测试）；对照应用结果（Chrome、其他 WebKit 应用的路径）。
- **回退**：只读（Surge 中无写入）。

### 3.3 native_bridge_ipc（扩展与本机服务通信）

- **用途**：扩展经原生桥与服务往返；也包括扩展的非持久后台从休眠被唤醒后仍能完成往返。
- **前置条件**：按 docs/INSTALL.md 构建安装宿主 App 与扩展，注册后台服务，在测试场景启用扩展。
- **步骤**：
  1. 打开扩展弹窗，确认显示服务状态（往返成功）。
  2. 依次做：Safari 退出重开；系统重启；菜单「停止后台服务」再「注册后台服务」；重新构建并替换 App（服务升级）。每次之后重复第 1 步。
  3. 后台休眠：让 Safari 闲置 5 分钟以上（或在「开发」菜单的扩展后台页确认后台已卸载），再点击扩展图标，确认往返成功。
     - 上报闹钟（结论写进 `background_wake` 项备注）：窗口/标签页事件后的 `reportProfileState` 按 Apple 的要求用 Alarms API 代替 `setTimeout`（“When you make your background page nonpersistent: … Use the `Alarms` API instead of `setTimeout`.”，https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari），闹钟名 `sfe-profile-report`，请求 1.5 秒后到点。Safari 对闹钟的最小延迟、后台卸载后闹钟能否唤醒它，Apple 没有写明，这里实测（用已命名的测试场景：默认场景可能没有场景标识，它的上报记入所有未识别场景共用的一条记录，不能与测试场景一一对应；默认场景的上报是否送达另在 `native_profile_id` 备注中记录）：
       - 延迟：从「开发」菜单打开本扩展后台页的检查器，在测试场景新建一个标签页后立即在控制台执行 `const a = await browser.alarms.get('sfe-profile-report'); a ? a.scheduledTime - Date.now() : '已到点'`，记录结果（明显大于 1500 即 Safari 延长了闹钟；显示「已到点」表示闹钟已经触发，需要更快地执行一次）。
       - 端到端上报：关闭检查器，让后台卸载（同上），在测试场景新建一个标签页后不再操作 Safari，等过上一步的延迟再加 1 分钟：数据目录的 `service.log` 中应有这次的 `bridge.request`（`"type":"reportProfileState"`、`"result":"ok"`），记录它与新建标签页的间隔。这一步只说明标签页事件之后上报能送达：新建标签页的事件本身就会唤醒后台，后台随即创建 1.5 秒后到点的闹钟，闹钟到点时后台多半还没卸载，所以**不能**用它证明闹钟能唤醒已卸载的后台。
       - 闹钟唤醒已卸载的后台：从「开发」菜单打开本扩展后台页的检查器，在控制台执行 `browser.alarms.create('sfe-profile-report', { delayInMinutes: 2 })`，记下时间；关闭检查器，在「开发」菜单确认后台已卸载（闹钟到点前还没卸载时，本次不算，加大 `delayInMinutes` 重做）；之后不再操作 Safari（不打开弹窗，不新建或关闭窗口、标签页：这些事件本身会唤醒后台）。等闹钟时间过后再加 1 分钟（延迟子步骤测得 Safari 延长了闹钟时，按延长后的时间算）：数据目录的 `service.log` 中应有这次的 `bridge.request`（`"type":"reportProfileState"`、`"result":"ok"`），记录它与创建闹钟的间隔。没有出现时 `background_wake` 答「否」并写明：后台卸载后闹钟不能唤醒它，场景上报会丢失，「其他场景有打开的窗口」的确认依赖它。
  4. 全程注意是否出现「访问其他 App 的数据」等系统提示。这只能说明宿主 App 的情况：扩展访问 App Group 容器被拒绝时系统**不弹出提示**（“This restriction also applies to app extensions, although in that case the system won’t prompt the user for consent but will instead just deny the access.”，https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes），所以扩展能否访问以第 1 步往返成功为准，`no_tcc` 答「是」不能代替它。被拒绝时弹窗显示「无法连接本机服务：系统拒绝扩展访问 App Group 容器……」（reason `container_denied`；宿主 App 自己也被拒绝时，菜单另有「系统拒绝访问 App Group 容器」）；出现时把弹窗原文（不含令牌）写进 `roundtrip` 项备注，`roundtrip` 答「否」。弹窗显示「读取原生桥配置失败（errno N）」时同样记录 N（拒绝访问实际返回哪个 errno，Apple 没有写明）。
  5. 握手与令牌（结论写进 `roundtrip` 项备注）：传输令牌从不上线路，原生桥先验证服务的 HMAC 证明（docs/ARCHITECTURE.md §7.2）。
     - 菜单「停止后台服务」后，在终端用 `nc -l 127.0.0.1 61848` 临时监听，再打开扩展弹窗：`nc` 只应收到一行 hello（只有 `v`、`type`、`clientNonce`），不含令牌、场景 ID 或消息；弹窗显示无法连接本机服务（10 秒超时，或结束 `nc` 时为「原生桥认证失败」）。之后重新「注册后台服务」，往返恢复。备注只写结论，不保存 `nc` 输出。
     - 后台服务运行中退出 App，删除 App Group 容器中的 `bridge.token` 后重开 App（App 生成新令牌并覆盖数据目录中的副本），**不重启服务**，重复第 1 步：往返成功（服务每个连接重新读取令牌文件）。从终端删除容器内文件时若出现系统提示，备注写明提示来自终端，不计入 `no_tcc`。macOS 26 或更高时退出 App 会出现下一步所说的提示，这里选「允许」。
  6. 退出 App 时的后台任务提示（结论写进 `quit_prompt` 项备注；更早的系统写「不适用」）。Apple：“On Mac computers with macOS 26 or later, if background tasks are started by an app and remain active after a user quits the app, the user is prompted to allow or not allow the background tasks to remain active.”（https://support.apple.com/guide/deployment/manage-login-items-background-tasks-mac-depdca572563/web）。选「不允许」之后会怎样，Apple 没有写明，所以这里实测：
     - 后台服务运行中从菜单「退出」App，记录是否出现提示与提示原文；选「允许」，重复第 1 步：往返仍成功。
     - 重开 App 再退出，这次选「不允许」：记录服务是否停止（重复第 1 步，往返是否失败）、重开 App 后菜单显示的后台服务状态（`SMAppService.status`），以及 `sfltool dumpbtm` 中 SafariProfileSurge 条目的变化（Apple 同一页：“Prints the current status of login and background items”；需要管理员权限时由你自己输入密码；备注只写这一条目的结论，不保存完整输出，它包含其他 App 的信息）。
     - 之后在「系统设置 → 通用 → 登录项与扩展」（macOS 14 为「登录项」）中恢复允许，并在菜单中「注册后台服务」，重复第 1 步：往返恢复。
  7. `checklist native_bridge_ipc`（签名身份自动读取 `/Applications/SafariProfileSurge.app` 的 Team ID，或用 `--signing-identity` 提供）。
- **通过条件**：扩展经原生桥与服务往返成功；Safari 重开、重启、服务重启、服务升级后仍成功；后台脚本休眠后被唤醒仍能完成往返；无 TCC 提示；macOS 26 或更高时，退出 App 出现的后台任务提示与选「允许」「不允许」后服务的状态已记录。
- **失败处理**：记录不支持；场景绑定与激活门槛保持关闭。不改用无令牌的传输或数据目录之外的路径。
- **证据**：`results/native_bridge_ipc.json`（逐项结论与脱敏备注）；时间；签名身份；`log show --predicate 'subsystem == "com.sfe.SafariProfileSurge.Extension"' --last 1h` 的结论（只记录是否出现消息内容，不保存原文到仓库）。
- **回退**：无 Surge 写入。

### 3.4 native_profile_id（原生场景 ID 稳定性）

- **用途**：绑定只认 `SFExtensionProfileKey`；不能按场景名猜测。
- **Apple 文档写了什么、没写什么**：示例代码把没有这个键当作普通浏览：`if let profileIdentifier = userInfo[SFExtensionProfileKey] as? UUID { // Perform profile specific tasks. } else { // Perform normal browsing tasks. }`（https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension）；WWDC23 只说 “If your extension is active in a profile, there will be a profileIdentifier value for the key SFExtensionProfileKey.”（https://developer.apple.com/videos/play/wwdc2023/10119/）。默认场景与无痕浏览有没有这个键、值的实际类型、跨 Safari 重开与重签是否不变，Apple 都没有写，只能在这里实测。默认场景没有这个键时，服务按未识别场景处理（只允许 `getCurrentState`），环境只能关联在已命名的场景中；这不算本项不通过。
- **前置条件**：同 3.3；至少两个已命名的测试场景都启用扩展（Safari →「设置」→「描述文件」（Profiles）→ 选择场景 →「扩展」）；默认场景也启用扩展（主「扩展」标签），用于记录。
- **步骤**：在每个已命名场景打开扩展弹窗，记录显示的场景 ID 前 8 位；在默认场景打开弹窗，记录显示「未识别当前场景」还是场景 ID（前 8 位）；如已允许本扩展在无痕浏览中运行，在无痕窗口同样记录一次（只记录，写进 `default_profile` 项备注）。默认场景显示「未识别当前场景」时，再在默认场景新建一个窗口，等过上报闹钟的延迟（§3.3）再加 1 分钟：数据目录的 `service.log` 中应有这次的 `bridge.request`（`"type":"reportProfileState"`、`"result":"ok"`），之后在已命名场景对已关联环境点「使用此环境」，应要求旧窗口确认并列出「未识别场景（可能是默认场景）」（看到即取消，不切换）；结果写进 `default_profile` 项备注，没有出现时写明：默认场景的窗口不计入旧窗口确认。Safari 退出重开、扩展停用再启用、App 重新构建签名后各记录一次。然后 `checklist native_profile_id`。
- **通过条件**：每个已命名场景都提供 SFExtensionProfileKey 且互不相同，Safari 退出重开、扩展重装、App 重签后保持不变或变化行为已记录；默认场景是否提供已记录（不提供时按未识别场景处理、不能关联；提供时也与各已命名场景不同）。
- **失败处理**：记录变化行为；产品绑定状态保持 `bound_unverified_id`，并先落地重新绑定流程。默认场景提供的 ID 与某个已命名场景相同时记为不通过（两个场景无法区分）。
- **证据**：`results/native_profile_id.json`（备注只写前 8 位）；时间；签名身份。
- **回退**：无。

### 3.5 extension_install_persistence（扩展签名与启用持久性）

- **用途**：免费 Apple ID（Personal Team）签名是否满足“正常打包签名”（ARCHITECTURE 冲突 2）。
- **前置条件**：「允许未签名扩展」**关闭**（Safari 17 起在 Safari →「设置」→「开发者」标签中，Apple：“In Safari 17 or later, use the Developer tab in Settings”；它在退出 Safari 时自动复位，每次检查前仍确认一遍）。
- **步骤**：安装后记录日期；Safari 退出重开、系统重启、8 天以上、重新构建后分别检查扩展是否仍启用；记录证书有效期（Xcode → Settings → Accounts）。再记录 App 与扩展是否嵌入描述文件（写进 `validity` 项备注）：
  - `codesign -d --entitlements - --xml /Applications/SafariProfileSurge.app` 与对 `…/Contents/PlugIns/SafariProfileSurgeExtension.appex` 的同一命令：记录签名中实际带的权限（源文件 `Config/App.entitlements`、`Config/Extension.entitlements` 只声明 App 沙盒、`application-groups`、`network.client`；签名中多出的权限如实记录）。
  - 包内布局与嵌套代码签名：`codesign --verify --deep --strict --verbose=2 /Applications/SafariProfileSurge.app` 退出 0；`codesign -dv /Applications/SafariProfileSurge.app/Contents/Helpers/node` 显示标识 `com.sfe.node` 与 App 相同的 TeamIdentifier；`find /Applications/SafariProfileSurge.app/Contents/Resources -type f -exec file {} + | grep -c Mach-O` 为 0（Node 按 Apple「Placing content in a bundle」放在 `Contents/Helpers`：“Resources are everything that’s not code.”）。结果写进 `validity` 项备注。
  - `ls -l /Applications/SafariProfileSurge.app/Contents/embedded.provisionprofile /Applications/SafariProfileSurge.app/Contents/PlugIns/SafariProfileSurgeExtension.appex/Contents/embedded.provisionprofile`：记录哪一个存在。
  - 存在时：`security cms -D -i <该文件> -o "$TMPDIR/sfe-profile.plist" && plutil -p "$TMPDIR/sfe-profile.plist" | grep -E 'CreationDate|ExpirationDate'`，记录两个日期后 `rm "$TMPDIR/sfe-profile.plist"`（描述文件含设备与证书信息，不保存、不提交）。
  - 背景：TN3125 写明 “Unlike Apple’s other platforms, macOS doesn’t require a provisioning profile to run third-party code.” “A Mac app that uses no restricted entitlements doesn’t need a provisioning profile.”（https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles）；免费团队的描述文件 “will expire 7 days from issuance”（https://developer.apple.com/help/account/basics/about-your-developer-account）。Xcode 自动签名是否仍嵌入描述文件、它过期后 App 能否启动、扩展是否保持启用、原生桥是否可用，Apple 都没有写；8 天以上的检查要覆盖嵌入的描述文件过期之后。本应用不使用钥匙串，签名中不应出现 `keychain-access-groups`；出现时如实记录。

  然后 `checklist extension_install_persistence`。
- **通过条件**：不开启“允许未签名扩展”，扩展在 Safari 退出重开、重启、8 天以上与重新构建后仍保持启用；证书有效期、App 与扩展是否嵌入描述文件及其有效期已记录。
- **失败处理**：如果只能依赖「允许未签名扩展」，交付物视为不满足约束并在 ACCEPTANCE 中写明；不作为正常安装路径。
- **证据**：`results/extension_install_persistence.json`；日期；签名身份。
- **回退**：无。

### 3.6 runtime_entry_modes（运行时入口四种模式）

- **用途**：NORMAL / BLOCKED / VERIFY_ONLY / ACTIVE 四种模式在不重载配置、不重启引擎的前提下精确生效，切换中没有放行窗口；Chrome 从不被 Safari 规则命中。
- **前置条件**：3.2 已得到候选路径（或用 `--process-path` 指定）；测试配置；test-servers；Safari 测试场景打开 `http://echo.p0.example.test:<端口>/app/safari`（轮询页），Chrome 打开 `…/app/chrome`；建议同时在另一个终端运行 `continuity`。
- **策略选择**：
  - `ruleset_resource`：四个规则集文件。每一步由服务策略按摘要原子替换一个文件，**不调用 `external-resource update`**（本地资源被跳过），在限定时间内（缺省 5 秒、每 0.2 秒）等待 Surge 的文件监视重新读取；每个文件带一条每次写入都不同的见证规则（`AND,((PROCESS-NAME,/var/empty/sfe-entry-witness),(DOMAIN,sfe-entry-<位>-<编号>.invalid))`，关闭的位的占位规则同样限定这个不存在的合成进程：DOMAIN 规则按主机名匹配任何进程，不限定时 Chrome 请求这一主机会经 SFE-ROUTE），用 `rule match … process-path=/var/empty/sfe-entry-witness` 确认 Surge 加载的正是这一版，再核对规则顺序与 Safari/Chrome 探测（Chrome 另探测各文件的见证主机与占位主机，必须不命中入口规则或 SFE-ROUTE）。等不到时按“结果未知”处理：放宽的一步能确认 Surge 仍是旧内容时把文件写回；收紧的一步保留新内容（监视赶上后加载的是更严格的内容）；入口记为未确认、不继续放宽。需要 `--auto-reload-condition`：服务规则是“读取当前自动重载设置并与能力记录的条件比较，读不到或不一致即拒绝”。读不到设置时只有 `any` 能通过，而 `any` 只有在 3.9 中自动重载开、关两种设置都通过时才可以提议。
  - `temp_rule`：五种条件互不相交的临时规则（`rule temp add <rule>` / `rule temp remove <rule>`，Mac 6.9.0+，协议 ≥20；ARCHITECTURE §5.5），每种模式只取决于存在哪些规则，与先后无关；拒绝↔路由翻转的那一步不论 Surge 把新规则放在哪里，结果都只能是起点、终点、BLOCKED 或 VERIFY_ONLY。帮助只写 “Add a temporary rule with the highest priority”，多条临时规则之间的先后没有写入文档：主序列总会先测量新临时规则插在前还是后（添加并删除两条永不命中的 `DOMAIN,p0-insert-N.invalid,REJECT`；其他情况用 `--probe-insertion` 单独要求测量），结果记入运行状态与 runtime_entry_modes 的检查项（预期为插在最前）。
    - 探测同时正向确认 `listTempRules`：添加后的临时规则列表必须列出两条探测规则才算确认（记入运行状态）。temp_rule 主序列与 `--precedence-test temp` 总会先运行这一探测（不需要 `--probe-insertion`），本次没有确认就在入口写入前停止（前置条件不满足）或不注入；`entry --strategy temp_rule --to <NORMAL 以外>` 在运行状态中没有确认时先探测，仍没有确认就拒绝；临时规则同步与 `rollback` 只在确认后才把列表中没有的规则判为已删除。没有确认的原因分开报告：
      - “没有列出刚添加的探测规则（有效规则中能看到它们）：该原语映射不可用”：只有这一种记为不可用。此后 `entry --strategy temp_rule --to NORMAL` 也拒绝（无法读回，改用 `rollback --execute`）。把 `dump temp-rule` 的输出交给开发者核对后再重测；之后的探测确认成功会覆盖这一结论。
      - “添加后读取临时规则失败（错误码）”：本次无法确认，不记为不可用，可以稍后重试。
      - “临时规则列表与有效规则中都没有刚添加的探测规则：addTempRule 可能没有生效”：问题在 `rule temp add`，不归咎于 listTempRules；把实际效果交给开发者核对。
      - 读不到有效规则列表时无法区分以上两种原因，同样只记为无法确认。
    - 临时规则与配置规则的先后：CLI 不报告规则来源，工具用测试配置自己的 `[Rule]` 文本定位配置规则的起点（第一条规则在有效规则中必须恰好出现一次且顺序与文件一致）；定位不了时输出“与配置规则的先后无法判断（原因）”，不当作结论。
- **步骤**：
  1. 优先级（必须做两项，才能得到“通过”）：
     - `--precedence-test temp`：注入临时规则 `DOMAIN,<检测主机>,DIRECT`，尝试进入 VERIFY_ONLY 必须被拒绝（PRECEDENCE_VIOLATION），随后删除注入的规则。注入前工具读取当前临时规则：已有相同（按规范化文本比较）的用户规则、读不到列表或列表本次没有经过插入探测正向确认时不注入，该项记为“不完整”（工具按文本增删，注入会删掉或接管你自己的规则）；先在 Surge 中确认没有这条规则再重测。插入探测同样在已有相同规则时不探测。
     - `--precedence-test module`：按提示在 Surge「模块」中安装并启用测试配置目录下的 `SFE-P0-precedence.sgmodule`，同样必须被拒绝；之后按提示停用并移除模块。
  2. 主序列：`entry --strategy ruleset_resource --auto-reload-condition <on|off|any> --precedence-test temp,module`，另一次用 `entry --strategy temp_rule --precedence-test temp,module`。工具先把 SFE-ROUTE 选为测试节点 A、布置配置 canary（§1.4），然后依次切换 BLOCKED → VERIFY_ONLY → ACTIVE → NORMAL，每步写入后运行时读回，每个模式停留 `--dwell` 秒（默认 20）。
  3. rule match 矩阵：每个模式读回确认后，工具对每个 Safari 进程路径与对照进程路径（同一运行目录中 3.2 测得的 Chrome 路径，没有时为 Chrome 的标准路径），分别以检测主机与 `echo.p0.example.test`、`protocol=TCP|UDP|QUIC` 调用 `rule match`（只求值，不建立连接）：Safari 的结果必须符合该模式（QUIC 与 UDP 同类：“`PROTOCOL,UDP` also matches QUIC and STUN connections.”；拒绝或经 SFE-ROUTE 时命中的必须是本应用入口规则，NORMAL 时不能命中本应用入口规则）；对照进程从不命中本应用入口规则，最终策略从不是 SFE-ROUTE 或本应用节点。服务的入口策略在每一步之后也用同样的探测读回。
  4. BLOCKED 之后工具按候选路径结束 Safari 的连接（逐条记录，不影响其他应用）；VERIFY_ONLY 时 Safari 页面中回显应失败、检测服务应成功；ACTIVE 时回显应经过 p0-a，并按提示在 Safari 打开 `https://cloudflare-quic.com/cdn-cgi/trace` 刷新 3 次、输入 `http=` 的值。入口运行不询问扩展弹窗的「重新检测」：它在 P0 中由服务执行（不经过 Safari 入口），BLOCKED 与 VERIFY_ONLY 下显示相同，不能证明扩展页面请求的处理；扩展页面请求的覆盖见 3.7。
  5. 结束后工具读取 Surge 最近请求，把每条 Safari 请求映射到当时生效的入口位组合，检查有没有超出该状态允许的结果（放行窗口）。
- **通过条件**：所选策略下四种模式精确生效，运行时读回包括 rule match：Safari 的 TCP、UDP、QUIC 对检测主机与其他主机都得到该模式预期的结果，Chrome 从不命中本应用入口规则或 SFE-ROUTE；每次切换不发生配置重载或引擎重启，其他应用长连接与新请求不受影响；中间状态无放行窗口；本应用入口优先于启用的模块 DIRECT 规则与用户临时规则；AND/NOT 组合（进程、协议、域名）的入口规则在该机制中可用；temp_rule 时新临时规则的插入位置已实测；ruleset_resource 时规则集文件原子替换后不调用 external-resource update，由 Surge 的文件监视在限定时间内重新读取并经见证规则读回。
- **判定细节**：检查项包括四种模式精确生效（读回）、Surge 记录中没有放行窗口、Safari 测试页在各模式下的表现、Chrome 测试页不受影响、其他应用长连接与新请求不受影响（流或 WebSocket 重置、WebSocket 重连失败、短请求失败都算影响）、没有配置重载或引擎重启（§1.4；配置 canary 不可用时为“不完整”）、rule match 矩阵（Safari 的 TCP/UDP/QUIC 符合各模式；Chrome 从不命中；任一读取失败为“不完整”，不符为“不通过”）、AND(进程,域名) 与 AND(进程,UDP) 规则实际命中（Surge 请求记录）、temp_rule 时插入位置已测得、优先于临时规则与模块 DIRECT 规则。任何一项没有数据时结论为“不完整”。
- **失败处理**：任一步失败时入口停在已确认的更严格状态（工具不会退回更宽松状态），按提示决定是否进入 NORMAL。两种策略都不通过时，记录不支持：NORMAL/BLOCKED/VERIFY_ONLY/ACTIVE 只是逻辑设计，激活门槛保持关闭；**不用后台反复重载主配置替代**。
- **证据**：`entry/<策略>-<时间>.json`（步骤时间线、每个模式的读回与证据、rule match 矩阵与对照路径、Surge 请求中 Safari 与测试主机的记录、配置 canary 与重载/重启信号、结束连接结果、H3 观察）、`entry/old-connections-evidence.json`、`servers/page.jsonl`、`servers/exit.jsonl`、`actions.jsonl`、`results/runtime_entry_modes.json`。期望节点为 SFE-N-P0-A；配置身份为测试配置；对照应用为 Chrome。
- **回退**：`entry --strategy <策略> --to NORMAL`；`rollback --execute`。

### 3.7 safari_udp_quic_handling（Safari UDP/QUIC 处理）

- **用途**：SOCKS5 链不支持 UDP；Safari 的 QUIC 必须被拒绝并回落 TCP，从不直连。
- **前置条件**：同 3.6。全局 `udp-policy-not-supported-behaviour` 只读取记录，不修改。
- **步骤**：与 3.6 的主序列同一次运行：VERIFY_ONLY 与 ACTIVE 期间的 Safari UDP 记录必须全部被 udp 规则拒绝；ACTIVE 下 H3 测试页显示 `http=http/2`（回落 TCP），对应的 TCP 请求经 SFE-ROUTE。逐协议覆盖全部来自测量：
  - http3_quic、http2：本次运行中 Safari 的 UDP 记录与 H3 测试主机回落的 TCP 记录（只接受直接测量）；
  - ipv4、http1：VERIFY_ONLY 下检测请求经 SFE-ROUTE；测试页回显在各模式下符合预期；
  - ipv6：Safari 轮询页每 5 轮请求一次 `api6.ipify.org`，Surge 中的记录在 BLOCKED/VERIFY_ONLY 下必须被拒绝、ACTIVE 下必须经 SFE-ROUTE；NORMAL 下 IPv6 检测也全部失败时记为 limitation（测试网络没有 IPv6）；
  - websocket：轮询页的 WebSocket 从 BLOCKED 确认后（留 2 秒稳定时间）到 VERIFY_ONLY 结束（含两者之间的切换）都不能建立；VERIFY_ONLY 结束之后到 ACTIVE 结束之间重新建立，且首条消息经过 p0-a。ACTIVE 一侧不加稳定时间：VERIFY_ONLY 下测试页每 2 秒重试，ACTIVE 生效后的第一次建立通常就在读回确认后 2 秒内，之后一直保持；切换途中建立的连接也计入，经过的节点不对同样不通过；
  - extension_page_fetch：入口运行不直接测量。扩展页面请求与轮询页请求出自同一 Safari 进程、访问同一检测主机，Surge 记录无法区分；弹窗「重新检测」由服务执行，不算证据。这一项只能由 3.2 的扩展步骤（扩展页面自己请求检测服务、按进程路径归属）按下一条补足；
  - 本次运行中没有直接观察到的非 UDP 项，只有当同一运行目录中有**同一进程路径、结论为“通过”**的 safari_process_attribution（3.2）且该项为 pass/limitation 时，记为 limitation 并注明“由 safari_process_attribution 覆盖”；否则为 not_tested 并写明缺什么，提议 supported 会被拒绝。
- **通过条件**：VERIFY_ONLY 与 ACTIVE 下 Safari 的 UDP/QUIC（H3 测试主机）被拒绝且从不直连，页面回落 TCP 经 SFE-ROUTE，出口一致。
- **失败处理**：UDP 有任何一条未被拒绝或被直连，记录不支持，激活门槛保持关闭。Safari 没有发起 QUIC 时写成“未测”，换一个支持 H3 的测试主机（`--h3-host`）重测。其他门槛项为 not_tested 时按备注补测（保持轮询页打开，或先完成 3.2，包括扩展步骤），不手工改写覆盖。
- **证据**：同 3.6；逐协议覆盖写在 `results/safari_udp_quic_handling.json`。
- **回退**：同 3.6。

### 3.8 entry_rules_after_restart（Surge 重启后入口规则生命周期）

- **用途**：Surge 重启后临时规则消失（帮助：“Temporary rules … are discarded when Surge stops.”；`restart-engine` 同样清空）；控制器必须在一个对账周期内发现，而不是继续显示 ACTIVE。只重启引擎时进程启动时间不变，服务按引擎运行时长回落识别。
- **前置条件**：3.6 通过。
- **步骤**：`entry --strategy <策略> --auto-reload-condition … --restart-test`。主序列结束后工具再次进入 ACTIVE，按提示在 Surge 菜单中退出 Surge 并重新打开，等待接管恢复后回车；工具立即读回入口并记录临时规则、规则集去留、进程启动时间与引擎运行时长，再回到 NORMAL。**不要用 `restart-engine` 代替**（它不在允许清单中，且会关闭全部连接）。
- **通过条件**：Surge 重启（退出重开；只重启引擎时按引擎运行时长回落识别）后入口规则的去留已记录，且控制器在一个对账周期内检测到丢失（入口记为 UNKNOWN 并暂停填充与自动打开）。
- **失败处理**：规则丢失但读回仍为 ACTIVE 时记录不通过（控制器会误报受控）；产品的对账逻辑必须修正后重测。
- **证据**：`entry/<策略>-<时间>.json` 中的 `restart`（进程启动时间是否变化、引擎运行时长是否回落）、`results/entry_rules_after_restart.json`。
- **回退**：同 3.6；如重启后无法回到 NORMAL，按 §2 处理。

### 3.9 auto_reload_atomic_replace（自动重载与原子替换行为）

- **用途**：写入被引用的本地文件之前，必须知道 Surge 会怎样重新读取它：6.10 的本地规则集由文件监视自动重新读取（规则集文档：“Local files are watched and reloaded automatically when they change.”），这一读取必须只涉及该文件——不是整份配置重载，不是引擎重启，不影响其他应用的连接。另记录主配置被原子替换后是否触发重载（维护写入用）。
- **前置条件**：测试配置；test-servers；在 Surge 设置中查看当前「自动重载」开关（工具读不到时由你声明）；`matchRule` 有可用实现时用 `rule match` 读回（否则改用实际请求，较慢）。
- **步骤**：`refresh --auto-reload off`（与 Surge 设置一致），然后在 Surge 中**手动**切换自动重载开关，再运行 `refresh --auto-reload on`。每次工具：
  1. 布置配置 canary（原子替换测试配置中的一行，§1.4），等待 `--wait` 秒（默认 8）后经代理请求配置 canary 主机，记录主配置被替换后是否触发重载（自动重载开时这一步本身就会让 Surge 重载测试配置，6.9.0 起可能升级为完整引擎重启并关闭全部连接：只在测试配置上、确认后进行）；
  2. 原子替换规则集 canary `p0-canary.list`，**不调用 update**，以 `rule match <canary 主机> process-path=/usr/bin/true protocol=TCP dest-port=443` 有界轮询（每 0.5 秒，至多 `--wait` 秒），记录 Surge 读到新内容的延迟，再经代理实际请求一次确认；
  3. 前后比较 §1.4 的信号（配置 canary、引擎运行时长、进程启动时间、临时规则、配置名）、其他外部资源的更新时间与错误状态，以及工具模拟的其他应用流量；
  4. 对规则集 canary 的 key 调用一次 `external-resource update`，只记录 Surge 报告的结果（文档：本地资源被跳过；6.10 包内文字有 “No remote external resource needed updating.”），从不当作刷新。
- **通过条件**：在记录的自动重载设置（开/关）下，原子替换被引用的本地规则集后由 Surge 文件监视重新读取（延迟已记录），不触发整份配置重载或引擎重启，其他应用连接不受影响；主配置被原子替换后是否触发重载也已记录。
- **判定细节**：检查项为“原子替换主配置后的行为已测得”“原子替换的规则集由文件监视重新读取（不调用 update）”“规则集重新读取没有触发整份配置重载”“没有引擎重启或 Surge 重启”“其他外部资源未受影响”“其他应用连接不受影响”。时限内没有读到新内容为“不通过”（可加长 `--wait` 重测）；配置 canary 不可用（自动重载开时替换主配置本身就触发了重载，或结果无法判断）时“没有触发整份配置重载”为“不完整”，因此自动重载开的测量通常不能提议 supported。`--auto-reload any` 只有开、关两种设置下都有“通过”、且任一设置下都没有“不通过”的测量时才可以提议：较早的通过不能抵消较新的失败（反过来也一样），以更严格的结论为准。
- **失败处理**：这项是“测量”，结果都要记录。文件监视的读取是整份配置重载或引擎重启、或影响了其他应用连接时，该设置下结论为“不通过”：ruleset_resource 入口与发布都不能在该设置下使用，**不用重载兜底**。自动重载开时无法证明的：在 Surge 中切回关、再运行一次 `refresh --auto-reload off`，提议 `supported --working-profile any --auto-reload off`（提议总是使用该能力最近一次的结果）；否则发布与 ruleset_resource 入口都停在待部署/拒绝。
- **证据**：`results/auto_reload_atomic_replace.json`（声明的设置值、延迟、update 的结果分类）、`results/history/`、`snapshots/`、`refresh/traffic-*.json`、`surge-calls.jsonl`（rule match 轮询）。
- **回退**：把自动重载开关恢复为测试前的值（手动）；配置 canary 行与 canary 规则集只影响测试主机；测试节点资源由命令自动恢复。

### 3.10 targeted_resource_refresh（节点资源定向重新读取）

- **用途**：新增节点只让本应用的节点资源被重新读取：不调用 update（本地资源被跳过）、不重载、不更新全部，其他资源与其他应用不受影响，读回完整。
- **前置条件**：同 3.9；建议另一个终端运行 `continuity`。
- **步骤**：`refresh --auto-reload off`。阶段 C：测试节点资源加入 SFE-N-P0-C → 原子替换 → **不调用 update**，有界轮询 SFE-ROUTE 成员（每 0.5 秒，至多 `--wait` 秒）直到与清单完全相等 → 读回组成员、选择、资源状态（`local`、`fromModule`、错误、是否正在更新）、节点详情；比较其他外部资源的更新时间与错误状态与 §1.4 的信号。时限内没有重新读取时，工具只对该 key 调用一次 update 并记录 Surge 报告什么、成员是否随之变化——与文档不符时写明，但**从不算通过**。
- **通过条件**：本应用节点资源（本地 policy-path 文件）原子替换后不调用 external-resource update（本地资源被跳过），经固定原语能读回组成员、资源错误与选择；只有该资源变化，其他外部资源不受影响，不发生整份配置重载或引擎重启；执行器从不写入它无法读回的内容。
- **判定细节**：“恰好一个 key 指向测试节点资源，且是来自配置的本地资源”要求 Surge 报告 `local: true`、`fromModule` 为空（没有 `local` 字段时为“不完整”）。节点详情读不到时读回级别为 partial。“资源没有错误”按读回成员 1 秒后的状态判定，备注记录写入前、读回成员后与 1 秒后的资源状态（正常 / 正在更新 / 未就绪 / 有错误；Surge 报告 `ready` 不为 true 时记为未就绪，不算健康）。配置 canary 不可用时“没有发生整份配置重载”为“不完整”。
- **失败处理**：新节点保持“已保存，待部署”，已部署的节点不受影响；**不自动重载兜底**，不实现回环地址的远端资源替代方案。
- **证据**：`results/targeted_resource_refresh.json`、`snapshots/refresh-before-*.json`、`surge-calls.jsonl`（每次调用的原语与耗时）、`actions.jsonl`。
- **回退**：命令结束时写回只含 A、B 的资源并等待重新读取、恢复原选择；失败时按打印的回退处理。

### 3.11 policy_path_reread（本地 policy-path 重新读取）

- **用途**：本地 policy-path 文件是否会被 Surge 自动重新读取没有写入文档（策略组文档只说 “Remote resources are cached on disk and re-downloaded periodically.”，`update-interval` “Only meaningful when the path is a URL.”）。这是发布的前提：没有自动重新读取，新节点只能停在待部署。
- **前置条件**：同 3.10。
- **步骤**：同一次 `refresh`：阶段 C 测得不调用 update 时成员是否在时限内与清单相等及其延迟；之后选择新节点 C 并经 `chain.p0.example.test` 请求，回显必须看到 p0-c；阶段 D（可用 `--skip-removal-fallback` 跳过）选中 C 后从资源移除、等待重新读取，选择必须回落到首成员 REJECT，不能落到其他节点。时限内没有重新读取时，阶段 C 之后的检查记为未测。
- **通过条件**：本地 policy-path 文件原子替换后不调用 external-resource update，Surge 在限定时间内自动重新读取（延迟已记录）：新增成员可选且实际生效，旧成员与选择保留，选中节点被移除时回落到首成员 REJECT。
- **判定细节**：只有“不调用 update 时自动重新读取”能通过；调用 update 后成员才变化（与文档 “Local resources are skipped.” 不符）只作记录，结论仍为“不通过”。延迟会用于调整服务发布的等待（`resourceReloadWait`，缺省 10 秒）。
- **失败处理**：记录不支持；发布门槛保持关闭，新版本停在 WAITING_DEPLOYMENT，已部署的节点不受影响。
- **证据**：`results/policy_path_reread.json`（延迟、轮询次数、update 的结果分类）、`servers/echo.jsonl`（经过的测试节点）。
- **回退**：同 3.10。

### 3.12 fixed_profile_no_switch（固定配置日常不切换）

- **用途**：日常在环境之间切换只改 SFE-ROUTE 选择，不切配置、不重载、不重启引擎。
- **前置条件**：同 3.9；Chrome 打开 `…/app/chrome` 轮询页。
- **步骤**：同一次 `refresh` 的阶段 B：SFE-ROUTE 依次选择 A、B、A（`policy-group set SFE-ROUTE <节点>`），读回选择、经过的节点、当前配置名与 §1.4 的重载/重启信号；同时检查工具自身的长连接/短请求与 Chrome 测试页上报。
- **通过条件**：切换 SFE-ROUTE 选择时工作配置身份不变、不发生配置重载或引擎重启、Chrome 长连接与新请求不受影响。
- **失败处理**：不能以多配置切换替代；记录不支持，激活门槛保持关闭。
- **证据**：`results/fixed_profile_no_switch.json`、`servers/page.jsonl`（Chrome）。
- **回退**：同 3.10。

### 3.13 connection_continuity（其他应用连接连续性）

- **用途**：发布节点资源期间，其他应用（Chrome 与本工具模拟的应用）的长连接保持、新请求正常、出口不变。
- **前置条件**：测试配置；test-servers。
- **步骤**：
  1. 终端 A：`continuity --duration 600`（可加 `--public-url https://api.ipify.org` 只测经代理的新连接建立）。先保持 30 秒以上不做任何变更（对照）。
  2. 终端 B：运行 `refresh --auto-reload off`。终端 A 会自动合并其他命令的动作（写入测试节点资源即“发布”、选择、update 调用、入口切换）；也可以在终端 A 输入事件名标记。
  3. 在终端 A 输入 `q` 结束。
- **通过条件**：发布节点资源期间（写入本地 policy-path 文件并等待 Surge 自动重新读取），其他应用的长连接保持、新请求正常、出口不变，并与未执行变更的对照比较。
- **判定细节**：对照时段本身出现重置、WebSocket 重连失败或短请求失败时结论为“不完整”（测试环境不稳定，不能比较）。WebSocket 打开失败（隧道或握手失败）按指数退避重连（2 秒起、最长 30 秒），每次失败只重连一次；握手没有成功的连接不算“重置”，但计为“重连失败”，同样算影响。提议摘要只逐行列出对照与有影响的时段，其余时段合并为一行。
- **失败处理**：不能称无中断发布；发布门槛保持关闭，新节点保持待部署。
- **证据**：`continuity/<时间>.json`（样本、标记、逐时段统计：成功率、延迟、最大间隔、重置、经过的节点）、`results/connection_continuity.json`。
- **回退**：只读（本命令不写 Surge）。

### 3.14 same_profile_reload_impact（同一配置维护重载影响）

- **用途**：维护流程（remerge）可能需要重载同一配置；用户需要知道影响后选择时间。
- **前置条件**：测试配置；test-servers；入口为 NORMAL。
- **步骤**：Surge 自动重载保持关闭。**单独**运行 `continuity --reload-test`（期间不要运行 refresh、entry 等命令）：工具先布置配置 canary（原子替换测试配置中的一行，§1.4），作为“重载确实发生”的证据。对照至少 45 秒后，在终端 A 输入 `reload` 回车，再立即在 Surge 菜单中**手动**「重新加载配置」；等待恢复后再观察 30 秒，输入 `q`。6.9.0 起这一操作只应用差异（“Unaffected connections, caches and temporary rules are preserved.”），但 “Automatically performs a full engine restart if a change requires one.”，哪些改动会触发没有写入文档；工具按引擎运行时长记录本次是否升级为完整引擎重启。**不要用 `restart-engine` 代替。**
- **通过条件**：同一配置维护重载对其他应用的影响（连接重置、恢复时间、接管与模式是否不变、是否升级为完整引擎重启并清空临时规则）已测量。
- **判定细节**：
  - 影响按**整个观察窗口**统计（流与 WebSocket 重置、WebSocket 重连失败、短请求失败），不只统计标记之后：先点重载、后输入标记时，期间的中断同样计入；恢复时间从第一次中断算到各通道都恢复。
  - 必须有重载确实发生的正面证据：配置 canary 已被重新读取、引擎运行时长回落（升级为完整引擎重启：全部连接关闭、临时规则清空，如实计为这次重载的影响），或标记附近出现中断。没有证据（例如没有加 `--reload-test`、实际没有重载、配置 canary 在重载前已被读取）时“其他应用不受影响”为“不完整”，**不会**判定无影响；检测到 Surge 进程重启（退出重开）时不算同一配置重载。
  - 第一次标记前 15 秒之前的对照必须至少 30 秒且没有任何中断；观察期间还有其他变更事件时同样为“不完整”。
- **失败处理**：这项是“测量”：有证据且无影响时提议支持；有影响时按“不支持（已测量影响）”提议，产品在维护预览中显示测得的影响，由用户选择时间。结论为“不完整”时按检查项备注重测。
- **证据**：`continuity/<时间>.json`、`results/same_profile_reload_impact.json`（重置数、失败数、恢复时间、接管与出站模式前后、是否升级为完整引擎重启）。
- **回退**：无写入；确认接管与出站模式未变。

### 3.15 external_node_underlying_proxy（外部节点前置链路）

- **用途**：外部资源中的节点必须经主配置中的前置；前置不可达或缺失时失败而不是直连。
- **前置条件**：测试配置；test-servers；入口为 NORMAL。
- **步骤**：`chain [--reload-wait 10]`。工具在测试资源中加入 SFE-N-P0-DEAD（前置端口无服务）与 SFE-N-P0-MISSING（前置名不存在），不调用 update，等待 Surge 自动重新读取（DEAD 出现在成员中为准；3.11 未通过时结论为“不完整”，不重载补救），然后依次选择 A、DEAD、MISSING，各经 `chain.p0.example.test` 请求一次。正面证据：前置服务记录 CONNECT 到出口服务、出口服务判定连接来自前置、回显看到 p0-a；DEAD 与 MISSING 不能到达出口，也不能出现 DIRECT 记录。
- **通过条件**：外部资源中的节点经 underlying-proxy 引用主配置前置时确实经过前置；前置不可达时连接失败而非直连；前置名缺失时节点被跳过或失败而非直连。
- **失败处理**：记录不支持，发布与激活门槛保持关闭。
- **证据**：`servers/front.jsonl`、`servers/exit.jsonl`、`results/external_node_underlying_proxy.json`。
- **回退**：命令自动恢复测试资源与选择。

### 3.16 independent_node_preflight（候选节点独立预检）

- **用途**：非活动环境的新节点能否不改变当前选择就做连通性测试。
- **前置条件**：测试配置；test-servers；`testPolicy` 有可用实现。
- **步骤**：`preflight`。SFE-ROUTE 选中 A 时对 B 执行 testPolicy（访问本机回显），回显必须看到 p0-b，测试后选择仍为 A。工具另外记录对 SFE-ROUTE 本身执行 testPolicy 时测的是不是当前选择（激活流程第 8 步依赖它）。
- **通过条件**：不改变当前选择即可对未选中的候选节点做连通性测试。
- **失败处理**：记录不支持；产品把预检记为 inconclusive，“不借当前选择组测试”非活动环境。
- **证据**：`servers/echo.jsonl`、`results/independent_node_preflight.json`。
- **回退**：命令恢复原选择。

### 3.17 first_request_and_old_connections（首请求与旧连接处理）

- **用途**：受控入口下首个业务请求已走新出口；旧环境的长连接、后台请求、恢复的标签页与扩展休眠场景不会继续用旧出口。
- **前置条件**：3.6 已运行（工具记录了结束 Safari 连接的结果）；扩展与宿主 App 已安装；测试环境只用测试节点。
- **步骤**：
  1. 受控入口：在菜单「打开环境」（或 `sfe env open <测试环境>`）发起，观察测试页第一个请求经过的节点（回显 `via`）。
  2. 旧长连接：切换时 Safari 测试页的 WebSocket 必须被结束，之后的消息经过新节点。
  3. 后台请求：旧环境窗口的轮询页在切换后不再经旧节点。
  4. 恢复的标签页：Safari 退出时保留窗口，重开后观察恢复的测试页是否在入口阻断前经旧出口加载。
  5. 扩展休眠：后台休眠后再唤醒，首请求仍经过目标节点。
  6. `checklist first_request_and_old_connections`，不能证明的情况写入备注。
- **通过条件**：受控入口下首个业务请求已走新出口；旧环境的长连接、后台请求、恢复的标签页与扩展休眠场景不会继续使用旧出口；限制已写明。
- **失败处理**：采用受控启动/关闭旧会话，写明限制；是否要求“保存工作后退出并重开 Safari”由用户决定（ARCHITECTURE §0）。不通过时激活结果持续带 `launch_order_unverified`。
- **证据**：`entry/old-connections-evidence.json`、`servers/page.jsonl`、`results/first_request_and_old_connections.json`。
- **回退**：在网页后台或插件中进入普通模式。

### 3.18 open_profile_by_id（按场景 ID 打开 Safari，只记录）

- **用途**：受控入口能否直接打开指定场景；不通过时界面给出「在 Safari 切换到场景 <名称>，点击扩展图标」的引导，不称一键完成。
- **步骤**：查阅当期 Safari/macOS 的公开文档与 API，记录是否存在受支持的方式；不使用私有数据库或界面自动化。`checklist open_profile_by_id`。
- **通过条件**：存在可用的公开方式按场景 ID 打开 Safari 指定场景。
- **失败处理**：只记录，不影响其他门槛。
- **证据**：`results/open_profile_by_id.json`。
- **回退**：无。

### 3.19 profile_batch_create（批量创建 Safari 场景，只记录）

- **用途**：关联向导能否批量创建场景；不通过时向导逐个引导用户在 Safari 官方界面创建并启用扩展。
- **步骤**：同 3.18，并记录官方界面逐个创建与启用扩展的步骤。`checklist profile_batch_create`。
- **通过条件**：存在可用的公开方式批量创建 Safari 场景。
- **失败处理**：只记录。
- **证据**：`results/profile_batch_create.json`。
- **回退**：删除测试中创建的空白场景（在 Safari 设置中手动删除）。

### 3.20 凭据字符（不是能力项，决定 UNSAFE_CREDENTIAL_CHARS 的范围）

- **用途**：代理用户名/密码目前只允许 `[A-Za-z0-9._~-]`；其他字符逐类证明安全后才放宽 `SURGE_SAFE_CREDENTIAL_RE`。
- **步骤**：`charset`（可用 `--classes comma,hash` 只测部分类别；`--reload-wait` 调整等待）。每类一个合成节点，用户名与密码的开头、中间、结尾都含该类字符，另加正常节点 C 作为“已重新读取”的见证；工具 `--check`，不调用 update、等待 Surge 自动重新读取（C 出现在成员中为准），逐个选择并经 SFE-ROUTE 请求，出口服务比较收到的值（只记录长度与判定）。时限内没有重新读取时所有类别记为未测试（不当作“被 Surge 跳过”）。入口必须是 NORMAL。
- **通过条件**：只有“出口收到的值与期望完全一致”的类别算已证明安全；`--check` 未通过、被 Surge 跳过、值被改变、没有到达出口的类别都不放宽。
- **证据**：`charset/result.json`、`charset-expect.json`（合成值）、`servers/exit.jsonl`。
- **回退**：命令自动恢复测试资源与选择。

## 4. 原语映射（adapterMechanism）

1. inventory 先读顶层 `--help`，再逐条读取 `help dump`、`help rule temp`、`help rule match`、`help external-resource`、`help version`、`help status`、`help policy-group`、`help feature`、`help mode`、`help kill`（6.9.0 起顶层帮助只列命令组，手册：“`help <command>` for the detailed usage of one command or command family”），原文存 `inventory/surge-cli-help.txt` 与 `inventory/surge-cli-help/`，取词的并集（`--check/-c` 这样的写法按 `--check` 识别）。不可用的一条（交互模式提示、Unknown command、非零退出或没有输出）不并入并给出警告；顶层帮助是交互模式提示时不读逐条帮助、不探测任何 CLI 原语。
2. inventory 打印建议的映射：读原语取实测可用的实现（CLI 优先；`getVersion` 必须是 cli，才能与运行实例交叉核对），主动原语（组选择、结束请求、外部资源更新、临时规则增删、策略测试）取“帮助中有对应命令”或“模块 B 已实现且回环 HTTP API 可用”的实现，**未经测试命令证明前不能当作已通过**。外部资源更新只用于记录本地资源被跳过，从不作为发布或入口的刷新机制。`reloadProfile` 不由 P0 设置。
3. CLI 只执行签名校验通过的 `surge-cli`，只执行帮助中出现的命令，且每条 argv 必须完全符合 `CLI_ARGV_ALLOWLIST`：读命令带 `--raw`；写命令只有 `policy-group set SFE-ROUTE <节点>`（不能是 auto）、`kill <数字 id>`（单个连接，“Terminate an active connection.”）、`external-resource update <单个 key>`（不能是 all）、`rule temp add|remove <规则>`，不带 `--raw` 以保留客户端命令校验。switch-profile、profile switch、reload、restart-engine、mode set、global-policy set、feature set、module、set、stop、managed-profile update、rule temp flush、flush-temp-rule、update all 等全局动作都不可达。
4. 读原语的 JSON 输出（`--raw`）只接受已知结构：非 JSON、未知外层结构、任何一项缺少可识别字段（规则文本、资源 key 与位置、请求 id、策略名称）时读取直接失败，从不读成空列表或跳过该项；只有空白输出被当作“没有临时规则”。空白输出因此仍可能掩盖仍存在的规则，所以 `listTempRules: cli` 还需要 entry 的插入探测正向确认（见 3.6；inventory 在建议的映射说明中标出）后，才会被当作“规则已不存在”的证据。
5. 某个原语显示 `not_in_help` 时，把 `inventory/surge-cli-help-relevant.txt` 与 `inventory/surge-cli-help/` 中的相关原文交给开发者核对服务的 CLI 原语表（命令以 6.10 文档为准），**不要**手动改用帮助中的其他动词或用 `--raw` 绕过客户端命令校验。
6. 各测试命令通过后，把映射写入数据目录的 `install.json` 的 `adapterMechanism` 字段（文件保持 0600；宿主 App 从不覆盖该字段）。映射变化会让依赖相应原语的能力回到待验证。

## 5. 提议与确认

```sh
npx tsx tools/p0/src/cli.ts propose <能力> supported --dry-run   # 先预览
npx tsx tools/p0/src/cli.ts propose <能力> supported              # 发送到 agent.sock
```

- 提议带：上下文（与服务运行时同一来源测得）、脱敏摘要、运行目录的带密钥证据摘要（`hmac-sha256:`，原始证据不离开本机）；safari_process_attribution 与 safari_udp_quic_handling 带全部门槛协议与 DNS/WebRTC/系统服务的覆盖；归属提议带进程完整路径；runtime_entry_modes 提议带入口策略。
- `supported` 只接受“通过”的结果；测量后上下文（Surge/macOS/Safari 版本、进程路径、原语映射等依赖字段）变化时拒绝，需要重测。
- 依赖进程归属的三项（safari_process_attribution、safari_udp_quic_handling、first_request_and_old_connections）：测量时或提议时有待重启的后台安全改进（或无法确认），或读不到补充版本（`sw_vers -productVersionExtra`），工具直接拒绝，服务也会拒绝；之后装上后台安全改进（补充版本变化）或再次出现待重启时，已确认的这三项回到待验证，网页「能力门槛」页说明原因（需要重启 Mac 或重测）。
- 依赖工作配置身份的能力（fixed_profile_no_switch、targeted_resource_refresh、policy_path_reread、connection_continuity、auto_reload_atomic_replace、same_profile_reload_impact）是在测试配置上测得的，必须显式加 `--working-profile any`，摘要会注明“在 P0 测试配置（源配置副本）上测得”。
- 声明的 `--auto-reload`、`--takeover`、`--signing-identity` 必须有测量证据，对**每个**依赖该字段的能力都适用（不只是 auto_reload_atomic_replace）：具体值必须等于测量时的值（refresh 声明的自动重载设置，或测量时读到的值；测量时没有记录则不能声明）；`--auto-reload any` 需要本能力在自动重载开、关两种设置下的测量都得到与提议相同的结论，`--takeover any` 需要 enhanced、system_proxy、both 三种接管方式下都有，且这些测量的其余依赖上下文与当前一致；任一取值下另有相反结论的测量（不论先后）即拒绝，用作证据的测量次数与时间写入提议摘要。读不到的上下文字段记为 null，服务运行时同样读不到才会匹配；工具会提示。例外：Surge 版本与构建读不到（或不是 `6.10.0`、`12500` 这样的格式）、与 `surge-cli --raw version` 交叉核对不一致、低于最低支持版本 6.10.0（12500）或 Controller 协议 < 22 时，依赖它们的能力不能提议，工具直接拒绝并给出原因——这样的记录在服务中永远不会生效。
- 提议摘要不超过服务接受的 4000 字（超出部分截断并以“…”结尾）。
- 原生相关能力需要签名身份：默认读取 `/Applications/SafariProfileSurge.app` 的 Team ID，也可用 `--signing-identity` 提供。
- 发送后在网页后台「能力门槛」页核对上下文、摘要与覆盖，再确认。工具不能确认。确认新的进程路径或入口策略会让依赖它们的能力回到待验证，且入口必须是 NORMAL。

## 6. 结束：回到原配置

按 §2 的 1–6 步执行。完成后：

- inventory 中记录的接管、出站模式、自动重载开关与测试前一致；
- Surge 临时规则中没有本工具添加的规则（`rollback` 显示“没有需要删除的本工具规则”）；
- 配置目录中没有「SFE-P0-测试.conf」、测试资源与测试模块。

之后按 docs/INSTALL.md 进行初始化；验收报告按 docs/ACCEPTANCE.md 填写，原始证据留在测试 Mac 的限权目录。

## 7. 离线测试

工具的纯逻辑与编排有离线测试（参数解析、摘要脱敏、SOCKS5 握手、证据摘要、回退计划、测试配置生成、归属/入口/连续性分析、提议校验，以及用 FakeSurge + 本机测试服务的命令端到端编排）：

```sh
npx vitest run tools/p0/test        # 或 npx vitest run --project p0 tools/p0/test
```

离线测试通过只证明工具本身的逻辑，不证明任何 Surge、Safari 或网络行为。
