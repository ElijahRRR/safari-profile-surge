# P0 能力门槛实测手册

日期：2026-10-21。性质：测试 Mac 上的操作手册。工具代码在 `tools/p0`，离线单元测试见文末。**本手册中的任何一项在测试 Mac 上实测并经网页后台确认之前，产品都按“待验证”处理，相关动作会被能力门槛拒绝。**

## 0. 总览

### 0.1 目的

P0 证明或否定 `CAPABILITY_KEYS` 中的每一项能力，并把结论以“提议”的形式交给本机服务，由用户在网页后台「能力门槛」页逐条确认。通过条件的文字与网页能力页共用 `packages/contract/src/phases.ts` 中的 `CAPABILITY_CRITERIA`（本手册逐字引用，离线测试会检查两者一致）。

### 0.2 不可改变的约束

- 只使用**空白 Safari 测试场景、测试域名（`*.p0.example.test` 与固定的检测服务主机）和本机测试代理**。从不导入买家账号、买家代理凭据或真实订单页。
- 工具**从不**调用 switch-profile、重载全部配置、更新全部外部资源、flush 临时规则，也从不开关增强模式、系统代理或出站模式，从不停止 Surge。需要切换配置、重启 Surge 或重载配置的步骤都由你在 Surge 菜单中手动完成。
- 写入之前工具先打印快照与**精确回退**，等你输入 `yes`（或显式加 `--yes`）才执行。
- 原始输出只写到仓库外的限权目录（默认 `~/Library/Application Support/SafariProfileSurge/p0/<运行编号>/`，目录 0700、文件 0600）；终端与提议只含脱敏摘要。不要把原始证据复制到仓库、聊天或工单中。
- 工具只能“提议”能力结论；“确认”只能在网页后台完成。
- 失败时记录限制，**从不**扩大成通用 WebKit 规则、从不用自动重载/重载全部掩盖问题、从不改用 DIRECT 或其他出口兜底。

### 0.3 运行方式

2026-10-22 测试 Mac 实测：Surge 6.5.0 (10960) 的 `surge-cli --version` 不返回版本，而是进入交互模式；输入结束时退出 0，输出中包含 `Connected to 127.0.0.1`。旧解析器会把该地址误当版本。因此 Surge 的版本与构建号不再经 CLI 或 HTTP API 读取：服务与本工具用同一个只读读取器从**运行中的 Surge 实例**取得（当前用户唯一的 `/Applications/Surge.app` 主进程 → 它的 Info.plist，并用启动时间、文件 ctime/birthtime、lsof 与 codesign 证明磁盘上的包就是正在运行的那一份；见 ARCHITECTURE §5.2 与本手册 §1.5）。`getVersion` 不再使用：不要在 `install.json` 或 `--mechanism` 中把它设为 `cli` 或 `http`（服务按不可用处理并提示）。读取器的规则在本机通过 §1.5 的 V1–V8 之前，不要据它读到的版本确认依赖版本的能力门槛。本机安装包版本（`defaults read`）只作旁证，不能替代运行实例版本。读不到运行中 Surge 的版本时，`propose` 拒绝依赖 Surge 版本或构建的能力（supported 与 unsupported 都拒绝，并给出运行实例的失败原因），服务也拒绝这类提议并把已有记录显示为待验证；旧解析器记成 `127.0.0.1` 的记录同样待验证，能读到版本后需要重测。

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
| 1 | 盘点（只读） | `inventory --profile <当前配置>`；`instance` 并按 §1.5 完成 V1–V8 | takeover_state_readable；原语映射建议；运行中 Surge 版本的证据 |
| 2 | 测试服务 | 另开终端 `test-servers`，全程保持运行 | — |
| 3 | 测试配置 | `make-test-profile`，然后**手动**在 Surge 中切到「SFE-P0-测试」，再 `inventory --run <编号> --profile <测试配置>` | — |
| 4 | 进程归属 | `attribution` | safari_process_attribution |
| 5 | 扩展与原生桥 | 构建安装（见 docs/INSTALL.md）后 `checklist` 四项 | native_bridge_ipc、native_profile_id、extension_install_persistence、bridge_keychain_access |
| 6 | 入口模式 | `entry --strategy …` | runtime_entry_modes、safari_udp_quic_handling |
| 7 | 资源刷新与连续性 | 一个终端 `continuity`，另一个 `refresh`（自动重载开、关各一次） | auto_reload_atomic_replace、targeted_resource_refresh、policy_path_reread、fixed_profile_no_switch、connection_continuity |
| 8 | 前置链路与凭据字符 | `chain`、`charset` | external_node_underlying_proxy；凭据字符白名单 |
| 9 | 独立预检 | `preflight` | independent_node_preflight |
| 10 | 重载影响 | 单独运行 `continuity --reload-test`：对照 45 秒后输入 `reload`，再立即在 Surge 中手动「重新加载配置」 | same_profile_reload_impact |
| 11 | 重启生命周期 | `entry --strategy … --restart-test` | entry_rules_after_restart |
| 12 | 首请求与旧连接 | 按清单操作后 `checklist first_request_and_old_connections` | first_request_and_old_connections |
| 13 | 只记录项 | `checklist open_profile_by_id`、`checklist profile_batch_create` | 两项只记录 |
| 14 | 回到原配置 | `rollback --execute`，**手动**切回原配置，删除测试文件 | — |
| 15 | 提议与确认 | `propose <能力> supported\|unsupported`，在网页后台确认 | 全部 |

每一步结束都会在 `<运行目录>/results/<能力>.json` 写入检查项与结论（通过 / 不通过 / 不完整）。`propose … supported` 只接受“通过”的结果。

## 1. 准备

### 1.1 测试 Mac 与应用

- 记录 macOS、Safari、Surge 的版本（inventory 会读取并写入证据）。开发调研时的 Surge 为 6.5.0 (10960)，以本机实测为准，不借用新版本文档中的能力。
- Safari：新建一个**空白测试场景**（Safari →「设置」→「场景」→ 新建，例如「P0-测试」），不登录任何账号、不访问 Amazon。归属测试期间关闭其他 Safari 窗口。
- Chrome：作为对照应用，保持一个窗口。
- 另一个 WebKit 应用：用于证明候选路径不是系统通用 WebKit 进程（例如「邮件」的快速查看预览、「快捷指令」的「获取 URL 内容」）。
- Surge：增强模式或系统代理至少一项开启，出站模式为规则模式。记录当前是哪一项（能力上下文中的 `takeoverMode`）。

### 1.2 测试主机

| 主机 | 用途 |
|---|---|
| `echo.p0.example.test:<回显端口>` | 测试页、回显、长连接流、WebSocket（只能经本机测试出口访问） |
| `chain.p0.example.test` | 测试规则把它交给 SFE-ROUTE，工具用它验证所选节点 |
| `c<N>.canary.p0.example.test` | 重载检测（见 §1.4） |
| `api.ipify.org`、`api64.ipify.org` | 固定的检测服务（与扩展相同） |
| `api6.ipify.org` | 只有 IPv6 的检测主机 |
| `cloudflare-quic.com` | HTTP/2、HTTP/3 测试页（`/cdn-cgi/trace` 显示 `http=` 协议） |

测试出口只把 `*.p0.example.test` 转到本机回显服务；公网主机只允许上表中的检测与 H3 主机（80/443），其他目标一律拒绝，因此测试代理不是开放代理。

### 1.3 测试配置的结构

`make-test-profile` 从当前配置的只读副本生成「SFE-P0-测试.conf」，与源配置同目录（或 `--target-dir` 指定的本机目录），全部文件以 O_EXCL 0600 新建、已存在即拒绝：

- `[Proxy Group]` 末尾加入与正式产品相同的受管理段 `SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list`；`[Rule]` 最前加入四条入口 RULE-SET（udp > verify > block > active，初始全部为占位规则）。文件名与正式产品一致，用来证明真实的资源 key 与位置识别。
- `[Proxy]` 末尾加入本机测试节点：`P0-Front`（前置）、`P0-Front-Dead`（端口无服务）、`P0-Plain` 与 `P0-Canary`（普通测试出口）。凭据是合成的，只对本机测试服务有效。
- 入口段之后加入三条测试规则：canary 规则集 → P0-Canary；`chain.p0.example.test` → SFE-ROUTE；`*.p0.example.test` → P0-Plain（Chrome 与工具自身访问测试主机走这里）。
- 源配置没有 http-api 时加入只监听 127.0.0.1 的 http-api（随机密钥，关闭 TLS 与网页仪表盘）；源配置绑定到非回环地址时在副本中改为回环。不需要时用 `--no-http-api`。
- 源配置带 `#!MANAGED-CONFIG` 时副本移除该行（避免被远端更新覆盖）。
- 另生成测试模块 `SFE-P0-precedence.sgmodule`（启用时加入 `DOMAIN,<检测主机>,DIRECT`），只在优先级测试中由你手动启用。

源配置已经含 SFE 受管理段（初始化之后复测）时，测试配置整段替换为测试内容、从不引用真实环境节点；但同目录中已有 `sfe-*` 文件，工具会拒绝写入，此时用 `--target-dir` 指定单独的本机目录，并在 Surge 设置中**手动**把配置目录临时指向它，测完再改回。测试配置位于 iCloud/同步目录时拒绝写入（正式产品同样不在此写入）；目标目录按真实位置判断，别名、大小写变体与无法确认真实位置的目录同样拒绝。

### 1.4 “未重载”信号（P0 定义）

ARCHITECTURE 要求记录“P0 定义的未重载信号”。工具使用四个信号，任何一个变化即判定发生了重载或重启：

1. **canary**：原子替换被引用的 `p0-canary.list`（不刷新），之后经 Surge 代理请求 `c<N>.canary.p0.example.test`。按新内容命中（经 P0-Canary）说明 Surge 重新读取了未刷新的文件。
2. **Surge 进程启动时间**（`ps -o lstart`）变化：Surge 重启。
3. **本工具之外的临时规则减少**：重载/重启可能清空临时规则。
4. **当前配置名**变化。

自动重载开启时，原子替换本身可能触发读取，canary 就不能用于后续步骤；工具会提示并改用另外三个信号与连接重置判断。

### 1.5 运行中 Surge 的版本（只读核对 V1–V10）

服务与本工具的 Surge 版本只来自运行中的 Surge 实例（`service/src/surge/running-instance.ts`，双方同一读取器）。下面的核对**全部只读**：不写 Surge 或它的任何文件，不切换配置，不由工具退出或重启 Surge（V7 由你手动退出并重新打开），**从不为了测试而触发或安装更新**。用 `instance` 命令读取并保存证据：

```sh
npx tsx tools/p0/src/cli.ts instance [--surge-team-id <Team ID>]
```

它逐条打印规则结果（进程、主程序、启动时间、包信息、启动后未修改、运行映像、签名、读取期间未变化）与已排除的其他 Surge 相关进程，并把完整证据（每条规则的结果与耗时、ctime/birthtime 与启动时间之差、lsof 是否一致、codesign 退出码）写入 `<运行目录>/instance/<时间>.json`；能确认时退出 0，无法确认时退出 3 并打印原因。P0 的 codesign 超时为 60 秒（为了记录真实耗时），服务只等 15 秒，引擎对每次读取另有 8 秒总时限，所以 instance 同时按服务的时限核对：签名一步达到 15 秒，或缓存命中后每次仍要执行的步骤（除包信息与签名外的全部规则：ps、plutil、stat、lsof）合计达到 8 秒时，服务读不到这个版本——instance 照样打印读到的版本，但提示是哪一项超时并退出 3，inventory 与能力上下文把版本记为未知，propose 拒绝依赖版本的能力。inventory 同样读取一次并写入 `inventory/surge-instance.json`，「运行中的 Surge」一行显示结论，磁盘上的 Surge.app 版本只作旁证（两者不一致时提示）。`--surge-team-id` 只会让签名校验更严。V1–V8 全部通过之前，不要据读到的版本确认依赖版本的能力；代码中标为 TODO(P0) 的 `SURGE_BUNDLE_IDS` 要在 V2 之后才定稿。以下命令中的 `<pid>` 是 instance 打印的进程号。

| 编号 | 核对 | 做法 | 期望 | 证据 |
|---|---|---|---|---|
| V1 | 进程列表 | `LC_ALL=C LANG=C TZ=UTC /bin/ps -ww -axo pid=,uid=,lstart=,comm=`，与 instance 结果对照 | 当前用户恰好一行完整路径 `/Applications/Surge.app/Contents/MacOS/Surge`；其他 Surge 相关进程（root 特权助手、`Contents/Applications/surge-cli`、包内的登录项等）都出现在 instance 的“已排除”列表中；启动时间与「活动监视器」及 `ps -o etime= -p <pid>` 一致；instance 没有提示超过服务读取的时限（除包信息与签名外各规则的耗时合计在 8 秒内：服务每次读取都要执行这些步骤，超过引擎的总时限即读不到版本） | instance 证据的 process、bundle_executable、start_time 与各规则的 ms |
| V2 | Info.plist | `/usr/bin/plutil -extract CFBundleShortVersionString raw -o - /Applications/Surge.app/Contents/Info.plist`，再分别读 `CFBundleVersion`、`CFBundleIdentifier`、`CFBundleExecutable` | 版本与构建号等于 Surge「关于」窗口（例如 6.5.0 (10960)）；记录包标识与主程序名，交给开发者填写 `SURGE_BUNDLE_IDS` | 命令输出、关于窗口截图、info_plist |
| V3 | 文件时间与重启 | `stat -f '%c %B' /Applications/Surge.app/Contents/Info.plist /Applications/Surge.app/Contents/MacOS/Surge`；分别在正常打开、在 Surge 菜单中退出后重新打开、注销再登录之后运行 instance | 每次都早于启动时间（证据中相对启动的毫秒数为负）；连续几天每天运行一次，记录任何让这条检查误判失败的元数据变化 | not_modified |
| V4 | lsof | `/usr/sbin/lsof -nP -a -p <pid> -d txt -F in` 与 `stat -f %i /Applications/Surge.app/Contents/MacOS/Surge` | 主程序那一项的 inode 与路径都一致；记录是否需要额外权限与耗时 | running_image |
| V5 | 签名 | `/usr/bin/codesign --verify --strict /Applications/Surge.app`；`/usr/bin/codesign -dv --verbose=2 /Applications/Surge.app` 读取 TeamIdentifier | 退出 0，且在 15 秒内完成（服务的 codesign 超时；更慢时服务按签名校验未通过处理，instance 提示并退出 3）；记录耗时与 Team ID，然后用 `instance --surge-team-id <Team ID>` 复核 | signature（耗时见各规则的 ms） |
| V6 | 规则自测（不碰 Surge） | 见下方步骤：在运行目录中做一个临时 App，用 `instance --self-test-bundle <该 App>` 核对 | 直接启动：通过；原子改写其 Info.plist：`modified_after_start`；启动前 `cp -p` 一份主程序、启动后用 `mv` 覆盖：`running_image_mismatch`（APFS 改名不更新 ctime 时）或 `modified_after_start`（更新时）——记录是哪一个；给包目录加扩展属性：仍通过 | `instance/selftest-*.json` |
| V7 | Surge 未运行 | 在 Surge 菜单中手动退出 Surge，运行 instance；再运行 `time /Applications/Surge.app/Contents/Applications/surge-cli --raw external-resource list </dev/null; echo "exit=$?"`；之后手动重新打开 Surge | instance 报告 `not_running`（退出 3）；记录该 CLI 命令的退出码、输出与耗时，交给开发者据此确定“无法连接”的文字模式（目前退出 0 时也按 stderr 或非 JSON 的 stdout 中的 not running、could not connect 等判断为无法连接；`dump temp-rule` 的空输出无法与“没有临时规则”区分，不用于可达性检测） | 终端输出 |
| V8 | 交互模式提示 | `time /Applications/Surge.app/Contents/Applications/surge-cli --version </dev/null; echo "exit=$?"`；检查 `inventory/surge-cli-help.txt` 与运行目录中的调用记录 | `--version` 在 2 秒内结束并打印交互模式提示（服务与 P0 按 `interactive_mode` 处理）；inventory 的帮助原文、每个已映射的读原语与测试配置的 `--check` 都没有出现该提示；记录写命令（external-resource update、temp-rule add/remove）在 refresh/entry 中成功时的原始输出，交给开发者收紧解析 | 终端输出、`inventory/surge-cli-help.txt`、调用记录 |
| V9 | HTTP API | 测试配置启用回环 HTTP API 时：`curl -sS -D - -o /dev/null http://127.0.0.1:<端口>/v1/outbound`（不带密钥） | 只记录响应头名称与任何像版本的值；**不使用**（即使有，将来也只作交叉核对，与运行实例不一致时版本为空）。需要带密钥的请求时用 `curl -H @<0600 的头文件>`，不要把密钥写在命令行 | 终端输出 |
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
- **前置条件**：测试配置已手动切换；test-servers 在运行；`listRecentRequests` 有可用实现（通常需要测试配置中的回环 http-api，并已用测试配置重新 inventory）。
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
  4. 全程注意是否出现「访问其他 App 的数据」等系统提示。
  5. 握手与令牌（结论写进 `roundtrip` 项备注）：传输令牌从不上线路，原生桥先验证服务的 HMAC 证明（docs/ARCHITECTURE.md §7.2）。
     - 菜单「停止后台服务」后，在终端用 `nc -l 127.0.0.1 61848` 临时监听，再打开扩展弹窗：`nc` 只应收到一行 hello（只有 `v`、`type`、`clientNonce`），不含令牌、场景 ID 或消息；弹窗显示无法连接本机服务（10 秒超时，或结束 `nc` 时为「原生桥认证失败」）。之后重新「注册后台服务」，往返恢复。备注只写结论，不保存 `nc` 输出。
     - 后台服务运行中退出 App，删除 App Group 容器中的 `bridge.token` 后重开 App（App 生成新令牌并覆盖数据目录中的副本），**不重启服务**，重复第 1 步：往返成功（服务每个连接重新读取令牌文件）。从终端删除容器内文件时若出现系统提示，备注写明提示来自终端，不计入 `no_tcc`。
  6. `checklist native_bridge_ipc`（签名身份自动读取 `/Applications/SafariProfileSurge.app` 的 Team ID，或用 `--signing-identity` 提供）。
- **通过条件**：扩展经原生桥与服务往返成功；Safari 重开、重启、服务重启、服务升级后仍成功；后台脚本休眠后被唤醒仍能完成往返；无 TCC 提示。
- **失败处理**：记录不支持；场景绑定与激活门槛保持关闭。不改用无令牌的传输或数据目录之外的路径。
- **证据**：`results/native_bridge_ipc.json`（逐项结论与脱敏备注）；时间；签名身份；`log show --predicate 'subsystem == "com.sfe.SafariProfileSurge.Extension"' --last 1h` 的结论（只记录是否出现消息内容，不保存原文到仓库）。
- **回退**：无 Surge 写入。

### 3.4 native_profile_id（原生场景 ID 稳定性）

- **用途**：绑定只认 `SFExtensionProfileKey`；不能按场景名猜测。
- **前置条件**：同 3.3；至少两个测试场景加上默认场景都启用扩展。
- **步骤**：在每个场景打开扩展弹窗，记录显示的场景 ID 前 8 位；Safari 退出重开、扩展停用再启用、App 重新构建签名后各记录一次。然后 `checklist native_profile_id`。
- **通过条件**：各场景（含默认场景）提供不同的 SFExtensionProfileKey，Safari 退出重开、扩展重装、App 重签后保持不变或变化行为已记录。
- **失败处理**：记录变化行为；产品绑定状态保持 `bound_unverified_id`，并先落地重新绑定流程。
- **证据**：`results/native_profile_id.json`（备注只写前 8 位）；时间；签名身份。
- **回退**：无。

### 3.5 extension_install_persistence（扩展签名与启用持久性）

- **用途**：免费 Apple ID（Personal Team）签名是否满足“正常打包签名”（ARCHITECTURE 冲突 2）。
- **前置条件**：「允许未签名扩展」**关闭**。
- **步骤**：安装后记录日期；Safari 退出重开、系统重启、8 天以上、重新构建后分别检查扩展是否仍启用；记录证书与描述文件有效期（Xcode → Settings → Accounts）。`checklist extension_install_persistence`。
- **通过条件**：不开启“允许未签名扩展”，扩展在 Safari 退出重开、重启、8 天以上与重新构建后仍保持启用；证书与描述文件有效期已记录。
- **失败处理**：如果只能依赖「允许未签名扩展」，交付物视为不满足约束并在 ACCEPTANCE 中写明；不作为正常安装路径。
- **证据**：`results/extension_install_persistence.json`；日期；签名身份。
- **回退**：无。

### 3.6 bridge_keychain_access（原生桥读取钥匙串）

- **用途**：登录填充时由签名的原生桥自己读取账号密码，服务从不返回密码。
- **前置条件**：同 3.3。只用合成测试值（例如 `example-test-value`），不使用真实账号。
- **步骤**：用 sfe-keychain 写入一个合成账号密码项 → 在测试场景触发一次读取（开发构建的测试入口）→ 记录是否出现提示；重新构建/重签后重复并记录提示次数；锁定钥匙串、拒绝授权时检查错误分类（denied / locked）。`checklist bridge_keychain_access`。
- **通过条件**：签名的原生桥能读取由指定写入方写入的账号密码钥匙串项，无额外提示；重建/重签后的提示次数已记录。
- **失败处理**：首选方案与备选方案（数据保护钥匙串 + 共享访问组）都不行时，登录填充保持不可用，并在 INSTALL/ACCEPTANCE 中写明。
- **证据**：`results/bridge_keychain_access.json`；提示次数；签名身份。
- **回退**：在「钥匙串访问」中删除合成测试项（名称以 SafariProfileSurge 开头、服务 `com.sfe.account`）。

### 3.7 runtime_entry_modes（运行时入口四种模式）

- **用途**：NORMAL / BLOCKED / VERIFY_ONLY / ACTIVE 四种模式在不重载配置的前提下精确生效，切换中没有放行窗口。
- **前置条件**：3.2 已得到候选路径（或用 `--process-path` 指定）；测试配置；test-servers；Safari 测试场景打开 `http://echo.p0.example.test:<端口>/app/safari`（轮询页），Chrome 打开 `…/app/chrome`；建议同时在另一个终端运行 `continuity`。
- **策略选择**：
  - `ruleset_resource`：四个规则集文件 + 按 key 定向刷新。需要 `--auto-reload-condition`：服务规则是“读取当前自动重载设置并与能力记录的条件比较，读不到或不一致即拒绝”。6.5 读不到设置时只有 `any` 能通过，而 `any` 只有在 3.10 中自动重载开、关两种设置都通过时才可以提议。
  - `temp_rule`：每位一条临时规则逐条增删。主序列总会先测量新临时规则插在前还是后（添加并删除两条永不命中的 `DOMAIN,p0-insert-N.invalid,REJECT`；其他情况用 `--probe-insertion` 单独要求测量）。按服务的规划，插入位置不受控时 VERIFY_ONLY 无法到达（插在末尾时验证规则排在阻断之后；插在开头时新规则抢在 udp/block 之前形成放行窗口），工具会在写入前拒绝（CAPABILITY_UNVERIFIED），这本身就是需要记录的结论。
    - 探测同时正向确认 `listTempRules`：添加后的临时规则列表必须列出两条探测规则才算确认（记入运行状态）。temp_rule 主序列与 `--precedence-test temp` 总会先运行这一探测（不需要 `--probe-insertion`），本次没有确认就在入口写入前停止（前置条件不满足）或不注入；`entry --strategy temp_rule --to <NORMAL 以外>` 在运行状态中没有确认时先探测，仍没有确认就拒绝；临时规则同步与 `rollback` 只在确认后才把列表中没有的规则判为已删除。没有确认的原因分开报告：
      - “没有列出刚添加的探测规则（有效规则中能看到它们）：该原语映射不可用”：只有这一种记为不可用。此后 `entry --strategy temp_rule --to NORMAL` 也拒绝（无法读回，改用 `rollback --execute`）。把 `dump temp-rule` 的输出交给开发者核对后再重测；之后的探测确认成功会覆盖这一结论。
      - “添加后读取临时规则失败（错误码）”：本次无法确认，不记为不可用，可以稍后重试。
      - “临时规则列表与有效规则中都没有刚添加的探测规则：addTempRule 可能没有生效”：问题在 `temp-rule add`，不归咎于 listTempRules；把实际效果交给开发者核对。
      - 读不到有效规则列表时无法区分以上两种原因，同样只记为无法确认。
    - 临时规则与配置规则的先后：CLI 不报告规则来源，工具用测试配置自己的 `[Rule]` 文本定位配置规则的起点（第一条规则在有效规则中必须恰好出现一次且顺序与文件一致）；定位不了时输出“与配置规则的先后无法判断（原因）”，不当作结论。
- **步骤**：
  1. 优先级（必须做两项，才能得到“通过”）：
     - `--precedence-test temp`：注入临时规则 `DOMAIN,<检测主机>,DIRECT`，尝试进入 VERIFY_ONLY 必须被拒绝（PRECEDENCE_VIOLATION），随后删除注入的规则。注入前工具读取当前临时规则：已有相同（按规范化文本比较）的用户规则、读不到列表或列表本次没有经过插入探测正向确认时不注入，该项记为“不完整”（工具按文本增删，注入会删掉或接管你自己的规则）；先在 Surge 中确认没有这条规则再重测。插入探测同样在已有相同规则时不探测。
     - `--precedence-test module`：按提示在 Surge「模块」中安装并启用测试配置目录下的 `SFE-P0-precedence.sgmodule`，同样必须被拒绝；之后按提示停用并移除模块。
  2. 主序列：`entry --strategy ruleset_resource --auto-reload-condition <on|off|any> --precedence-test temp,module`。工具先把 SFE-ROUTE 选为测试节点 A、布置 canary，然后依次切换 BLOCKED → VERIFY_ONLY → ACTIVE → NORMAL，每步写入后运行时读回，每个模式停留 `--dwell` 秒（默认 20）。
  3. BLOCKED 之后工具按候选路径结束 Safari 的连接（逐条记录，不影响其他应用）；VERIFY_ONLY 时 Safari 页面中回显应失败、检测服务应成功；ACTIVE 时回显应经过 p0-a，并按提示在 Safari 打开 `https://cloudflare-quic.com/cdn-cgi/trace` 刷新 3 次、输入 `http=` 的值。入口运行不询问扩展弹窗的「重新检测」：它在 P0 中由服务执行（不经过 Safari 入口），BLOCKED 与 VERIFY_ONLY 下显示相同，不能证明扩展页面请求的处理；扩展页面请求的覆盖见 3.8。
  4. 结束后工具读取 Surge 最近请求，把每条 Safari 请求映射到当时生效的入口位组合，检查有没有超出该状态允许的结果（放行窗口）。
- **通过条件**：所选策略下四种模式精确生效；每次切换位不发生配置重载、其他应用长连接与新请求不受影响；中间状态无放行窗口；本应用入口优先于启用的模块 DIRECT 规则与用户临时规则；AND(进程,域名) 与 AND(进程,UDP) 规则在该机制中可用；ruleset_resource 时 Safari 请求在 updateExternalResource(key) 后改变匹配。
- **判定细节**：检查项包括四种模式精确生效（读回）、Surge 记录中没有放行窗口、Safari 测试页在各模式下的表现、Chrome 不受影响、其他应用长连接与新请求不受影响（流或 WebSocket 重置、WebSocket 重连失败、短请求失败都算影响）、没有重载（§1.4）、AND(进程,域名) 与 AND(进程,UDP) 规则实际命中、优先于临时规则与模块 DIRECT 规则。任何一项没有数据时结论为“不完整”。
- **失败处理**：任一步失败时入口停在已确认的更严格状态（工具不会退回更宽松状态），按提示决定是否进入 NORMAL。两种策略都不通过时，记录不支持：NORMAL/BLOCKED/VERIFY_ONLY/ACTIVE 只是逻辑设计，激活门槛保持关闭；**不用后台反复重载主配置替代**。
- **证据**：`entry/<策略>-<时间>.json`（步骤时间线、每个模式的读回与证据、Surge 请求中 Safari 与测试主机的记录、canary 与重载信号、结束连接结果、H3 观察）、`entry/old-connections-evidence.json`、`servers/page.jsonl`、`servers/exit.jsonl`、`actions.jsonl`、`results/runtime_entry_modes.json`。期望节点为 SFE-N-P0-A；配置身份为测试配置；对照应用为 Chrome。
- **回退**：`entry --strategy <策略> --to NORMAL`；`rollback --execute`。

### 3.8 safari_udp_quic_handling（Safari UDP/QUIC 处理）

- **用途**：SOCKS5 链不支持 UDP；Safari 的 QUIC 必须被拒绝并回落 TCP，从不直连。
- **前置条件**：同 3.7。全局 `udp-policy-not-supported-behaviour` 只读取记录，不修改。
- **步骤**：与 3.7 的主序列同一次运行：VERIFY_ONLY 与 ACTIVE 期间的 Safari UDP 记录必须全部被 udp 规则拒绝；ACTIVE 下 H3 测试页显示 `http=http/2`（回落 TCP），对应的 TCP 请求经 SFE-ROUTE。逐协议覆盖全部来自测量：
  - http3_quic、http2：本次运行中 Safari 的 UDP 记录与 H3 测试主机回落的 TCP 记录（只接受直接测量）；
  - ipv4、http1：VERIFY_ONLY 下检测请求经 SFE-ROUTE；测试页回显在各模式下符合预期；
  - ipv6：Safari 轮询页每 5 轮请求一次 `api6.ipify.org`，Surge 中的记录在 BLOCKED/VERIFY_ONLY 下必须被拒绝、ACTIVE 下必须经 SFE-ROUTE；NORMAL 下 IPv6 检测也全部失败时记为 limitation（测试网络没有 IPv6）；
  - websocket：轮询页的 WebSocket 从 BLOCKED 确认后（留 2 秒稳定时间）到 VERIFY_ONLY 结束（含两者之间的切换）都不能建立；VERIFY_ONLY 结束之后到 ACTIVE 结束之间重新建立，且首条消息经过 p0-a。ACTIVE 一侧不加稳定时间：VERIFY_ONLY 下测试页每 2 秒重试，ACTIVE 生效后的第一次建立通常就在读回确认后 2 秒内，之后一直保持；切换途中建立的连接也计入，经过的节点不对同样不通过；
  - extension_page_fetch：入口运行不直接测量。扩展页面请求与轮询页请求出自同一 Safari 进程、访问同一检测主机，Surge 记录无法区分；弹窗「重新检测」由服务执行，不算证据。这一项只能由 3.2 的扩展步骤（扩展页面自己请求检测服务、按进程路径归属）按下一条补足；
  - 本次运行中没有直接观察到的非 UDP 项，只有当同一运行目录中有**同一进程路径、结论为“通过”**的 safari_process_attribution（3.2）且该项为 pass/limitation 时，记为 limitation 并注明“由 safari_process_attribution 覆盖”；否则为 not_tested 并写明缺什么，提议 supported 会被拒绝。
- **通过条件**：VERIFY_ONLY 与 ACTIVE 下 Safari 的 UDP/QUIC（H3 测试主机）被拒绝且从不直连，页面回落 TCP 经 SFE-ROUTE，出口一致。
- **失败处理**：UDP 有任何一条未被拒绝或被直连，记录不支持，激活门槛保持关闭。Safari 没有发起 QUIC 时写成“未测”，换一个支持 H3 的测试主机（`--h3-host`）重测。其他门槛项为 not_tested 时按备注补测（保持轮询页打开，或先完成 3.2，包括扩展步骤），不手工改写覆盖。
- **证据**：同 3.7；逐协议覆盖写在 `results/safari_udp_quic_handling.json`。
- **回退**：同 3.7。

### 3.9 entry_rules_after_restart（Surge 重启后入口规则生命周期）

- **用途**：Surge 重启后临时规则可能消失；控制器必须在一个对账周期内发现，而不是继续显示 ACTIVE。
- **前置条件**：3.7 通过。
- **步骤**：`entry --strategy <策略> --auto-reload-condition … --restart-test`。主序列结束后工具再次进入 ACTIVE，按提示在 Surge 菜单中退出 Surge 并重新打开，等待接管恢复后回车；工具立即读回入口并记录临时规则、规则集去留，再回到 NORMAL。
- **通过条件**：Surge 重启后入口规则的去留已记录，且控制器在一个对账周期内检测到丢失（入口记为 UNKNOWN 并暂停填充与自动打开）。
- **失败处理**：规则丢失但读回仍为 ACTIVE 时记录不通过（控制器会误报受控）；产品的对账逻辑必须修正后重测。
- **证据**：`entry/<策略>-<时间>.json` 中的 `restart`、Surge 进程启动时间、`results/entry_rules_after_restart.json`。
- **回退**：同 3.7；如重启后无法回到 NORMAL，按 §2 处理。

### 3.10 auto_reload_atomic_replace（自动重载与原子替换行为）

- **用途**：写入被引用文件之前必须知道它会不会触发整份配置重载。
- **前置条件**：测试配置；test-servers；在 Surge 设置中查看当前「自动重载」开关（工具读不到时由你声明）。
- **步骤**：`refresh --auto-reload off`（与 Surge 设置一致），然后在 Surge 中**手动**切换自动重载开关，再运行 `refresh --auto-reload on`。每次工具原子替换未刷新的 canary 规则集，等待 `--wait` 秒后检查 Surge 是否重新读取。
- **通过条件**：自动重载设置（开/关）下原子替换被引用文件的行为已实测：是否触发整份配置重载；记录验证时的设置值。
- **判定细节**：检查项“原子替换不触发重新读取”直接反映测量：canary 被重新读取时该次结论为“不通过”。`--auto-reload any` 只有开、关两种设置下都有“通过”（没有重新读取）、且任一设置下都没有“不通过”的测量时才可以提议：例如先用较短的 `--wait` 在“开”下得到通过、再用较长的等待观察到重新读取，较早的通过不能抵消较新的失败（反过来也一样），以更严格的结论为准。
- **失败处理**：这项是“测量”，两种结果都要记录。自动重载开启时原子替换会触发重载的：该次结论为“不通过”，不能作为 `--auto-reload on` 或 `any` 的支持证据。产品因此要求自动重载关闭：在 Surge 中切回关、再运行一次 `refresh --auto-reload off`，提议 `supported --working-profile any --auto-reload off`（提议总是使用该能力最近一次的结果）；否则发布与 ruleset_resource 入口都停在待部署/拒绝。
- **证据**：`results/auto_reload_atomic_replace.json`（声明的设置值）、`results/history/`、`snapshots/`、`refresh/traffic-*.json`。
- **回退**：把自动重载开关恢复为测试前的值（手动）；测试节点资源由命令自动恢复。

### 3.11 targeted_resource_refresh（节点资源定向刷新）

- **用途**：新增节点只刷新本应用资源，不重载、不更新全部。
- **前置条件**：同 3.10；建议另一个终端运行 `continuity`。
- **步骤**：`refresh --auto-reload off`。阶段 C：测试节点资源加入 SFE-N-P0-C → 原子替换 → 按枚举到的唯一 key 定向刷新 → 读回组成员、选择、资源错误、更新时间、节点详情；比较其他外部资源的更新时间。
- **通过条件**：按 key 定向刷新本应用节点资源后，经固定原语能读到组成员、资源错误与选择；不影响其他资源；执行器从不写入它无法读回的内容。
- **判定细节**：资源更新时间读不到时该项为“不完整”，并提示 ruleset_resource 入口策略无法确认刷新；节点详情读不到时读回级别为 partial。“资源没有错误”按刷新后 1 秒的读回判定，备注记录刷新前、刷新刚返回与 1 秒后的资源状态（正常 / 未就绪 / 有错误；Surge 报告 `ready` 不为 true 时记为未就绪，不算健康）。
- **失败处理**：新节点保持“已保存，待部署”；研究其他发布机制，**不自动重载兜底**。
- **证据**：`results/targeted_resource_refresh.json`、`snapshots/refresh-before-*.json`、`surge-calls.jsonl`（每次调用的原语与耗时）、`actions.jsonl`。
- **回退**：命令结束时自动恢复为只含 A、B 的资源并刷新、恢复原选择；失败时按打印的回退处理。

### 3.12 policy_path_reread（本地 policy-path 重新读取）

- **用途**：本地 policy-path 文件修改后经定向刷新被重新读取。
- **前置条件**：同 3.11。
- **步骤**：同一次 `refresh`：选择新节点 C 后经 `chain.p0.example.test` 请求，回显必须看到 p0-c；阶段 D（可用 `--skip-removal-fallback` 跳过）选中 C 后从资源移除并刷新，选择必须回落到首成员 REJECT，不能落到其他节点。
- **通过条件**：本地 policy-path 文件修改后经定向刷新被重新读取，新增成员可选、旧成员与选择保留。
- **失败处理**：记录不支持；发布门槛保持关闭。
- **证据**：`results/policy_path_reread.json`、`servers/echo.jsonl`（经过的测试节点）。
- **回退**：同 3.11。

### 3.13 fixed_profile_no_switch（固定配置日常不切换）

- **用途**：日常在环境之间切换只改 SFE-ROUTE 选择，不切配置、不重载。
- **前置条件**：同 3.10；Chrome 打开 `…/app/chrome` 轮询页。
- **步骤**：同一次 `refresh` 的阶段 B：SFE-ROUTE 依次选择 A、B、A，读回选择、经过的节点、当前配置名与重载信号；同时检查工具自身的长连接/短请求与 Chrome 测试页上报。
- **通过条件**：切换 SFE-ROUTE 选择时工作配置身份不变、不发生配置重载、Chrome 长连接与新请求不受影响。
- **失败处理**：不能以多配置切换替代；记录不支持，激活门槛保持关闭。
- **证据**：`results/fixed_profile_no_switch.json`、`servers/page.jsonl`（Chrome）。
- **回退**：同 3.11。

### 3.14 connection_continuity（其他应用连接连续性）

- **用途**：发布节点资源期间，其他应用（Chrome 与本工具模拟的应用）的长连接保持、新请求正常、出口不变。
- **前置条件**：测试配置；test-servers。
- **步骤**：
  1. 终端 A：`continuity --duration 600`（可加 `--public-url https://api.ipify.org` 只测经代理的新连接建立）。先保持 30 秒以上不做任何变更（对照）。
  2. 终端 B：运行 `refresh --auto-reload off`。终端 A 会自动合并资源刷新、选择等动作；也可以在终端 A 输入事件名标记。
  3. 在终端 A 输入 `q` 结束。
- **通过条件**：发布节点资源期间，其他应用的长连接保持、新请求正常、出口不变，并与未执行变更的对照比较。
- **判定细节**：对照时段本身出现重置、WebSocket 重连失败或短请求失败时结论为“不完整”（测试环境不稳定，不能比较）。WebSocket 打开失败（隧道或握手失败）按指数退避重连（2 秒起、最长 30 秒），每次失败只重连一次；握手没有成功的连接不算“重置”，但计为“重连失败”，同样算影响。提议摘要只逐行列出对照与有影响的时段，其余时段合并为一行。
- **失败处理**：不能称无中断发布；发布门槛保持关闭，新节点保持待部署。
- **证据**：`continuity/<时间>.json`（样本、标记、逐时段统计：成功率、延迟、最大间隔、重置、经过的节点）、`results/connection_continuity.json`。
- **回退**：只读（本命令不写 Surge）。

### 3.15 same_profile_reload_impact（同一配置维护重载影响）

- **用途**：维护流程（remerge）可能需要重载同一配置；用户需要知道影响后选择时间。
- **前置条件**：测试配置；test-servers；入口为 NORMAL。
- **步骤**：Surge 自动重载保持关闭。**单独**运行 `continuity --reload-test`（期间不要运行 refresh、entry 等命令）：工具先原子替换 canary 规则集（不刷新），作为“重载确实发生”的证据。对照至少 45 秒后，在终端 A 输入 `reload` 回车，再立即在 Surge 菜单中**手动**「重新加载配置」；等待恢复后再观察 30 秒，输入 `q`。
- **通过条件**：同一配置维护重载对其他应用的影响（连接重置、恢复时间、接管与模式是否不变）已测量。
- **判定细节**：
  - 影响按**整个观察窗口**统计（流与 WebSocket 重置、WebSocket 重连失败、短请求失败），不只统计标记之后：先点重载、后输入标记时，期间的中断同样计入；恢复时间从第一次中断算到各通道都恢复。
  - 必须有重载确实发生的正面证据：未刷新的 canary 已被重新读取（或临时规则丢失等 §1.4 信号），或标记附近出现中断。没有证据（例如没有加 `--reload-test`、实际没有重载、canary 在重载前已被读取）时“其他应用不受影响”为“不完整”，**不会**判定无影响；检测到 Surge 进程重启时也不算同一配置重载。
  - 第一次标记前 15 秒之前的对照必须至少 30 秒且没有任何中断；观察期间还有其他变更事件时同样为“不完整”。
- **失败处理**：这项是“测量”：有证据且无影响时提议支持；有影响时按“不支持（已测量影响）”提议，产品在维护预览中显示测得的影响，由用户选择时间。结论为“不完整”时按检查项备注重测。
- **证据**：`continuity/<时间>.json`、`results/same_profile_reload_impact.json`（重置数、失败数、恢复时间、接管与出站模式前后）。
- **回退**：无写入；确认接管与出站模式未变。

### 3.16 external_node_underlying_proxy（外部节点前置链路）

- **用途**：外部资源中的节点必须经主配置中的前置；前置不可达或缺失时失败而不是直连。
- **前置条件**：测试配置；test-servers；入口为 NORMAL。
- **步骤**：`chain`。工具在测试资源中加入 SFE-N-P0-DEAD（前置端口无服务）与 SFE-N-P0-MISSING（前置名不存在），刷新后依次选择 A、DEAD、MISSING，各经 `chain.p0.example.test` 请求一次。正面证据：前置服务记录 CONNECT 到出口服务、出口服务判定连接来自前置、回显看到 p0-a；DEAD 与 MISSING 不能到达出口，也不能出现 DIRECT 记录。
- **通过条件**：外部资源中的节点经 underlying-proxy 引用主配置前置时确实经过前置；前置不可达时连接失败而非直连；前置名缺失时节点被跳过或失败而非直连。
- **失败处理**：记录不支持，发布与激活门槛保持关闭。
- **证据**：`servers/front.jsonl`、`servers/exit.jsonl`、`results/external_node_underlying_proxy.json`。
- **回退**：命令自动恢复测试资源与选择。

### 3.17 independent_node_preflight（候选节点独立预检）

- **用途**：非活动环境的新节点能否不改变当前选择就做连通性测试。
- **前置条件**：测试配置；test-servers；`testPolicy` 有可用实现。
- **步骤**：`preflight`。SFE-ROUTE 选中 A 时对 B 执行 testPolicy（访问本机回显），回显必须看到 p0-b，测试后选择仍为 A。工具另外记录对 SFE-ROUTE 本身执行 testPolicy 时测的是不是当前选择（激活流程第 8 步依赖它）。
- **通过条件**：不改变当前选择即可对未选中的候选节点做连通性测试。
- **失败处理**：记录不支持；产品把预检记为 inconclusive，“不借当前选择组测试”非活动环境。
- **证据**：`servers/echo.jsonl`、`results/independent_node_preflight.json`。
- **回退**：命令恢复原选择。

### 3.18 first_request_and_old_connections（首请求与旧连接处理）

- **用途**：受控入口下首个业务请求已走新出口；旧环境的长连接、后台请求、恢复的标签页与扩展休眠场景不会继续用旧出口。
- **前置条件**：3.7 已运行（工具记录了结束 Safari 连接的结果）；扩展与宿主 App 已安装；测试环境只用测试节点。
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

### 3.19 open_profile_by_id（按场景 ID 打开 Safari，只记录）

- **用途**：受控入口能否直接打开指定场景；不通过时界面给出「在 Safari 切换到场景 <名称>，点击扩展图标」的引导，不称一键完成。
- **步骤**：查阅当期 Safari/macOS 的公开文档与 API，记录是否存在受支持的方式；不使用私有数据库或界面自动化。`checklist open_profile_by_id`。
- **通过条件**：存在可用的公开方式按场景 ID 打开 Safari 指定场景。
- **失败处理**：只记录，不影响其他门槛。
- **证据**：`results/open_profile_by_id.json`。
- **回退**：无。

### 3.20 profile_batch_create（批量创建 Safari 场景，只记录）

- **用途**：关联向导能否批量创建场景；不通过时向导逐个引导用户在 Safari 官方界面创建并启用扩展。
- **步骤**：同 3.19，并记录官方界面逐个创建与启用扩展的步骤。`checklist profile_batch_create`。
- **通过条件**：存在可用的公开方式批量创建 Safari 场景。
- **失败处理**：只记录。
- **证据**：`results/profile_batch_create.json`。
- **回退**：删除测试中创建的空白场景（在 Safari 设置中手动删除）。

### 3.21 凭据字符（不是能力项，决定 UNSAFE_CREDENTIAL_CHARS 的范围）

- **用途**：代理用户名/密码目前只允许 `[A-Za-z0-9._~-]`；其他字符逐类证明安全后才放宽 `SURGE_SAFE_CREDENTIAL_RE`。
- **步骤**：`charset`（可用 `--classes comma,hash` 只测部分类别）。每类一个合成节点，用户名与密码的开头、中间、结尾都含该类字符；工具 `--check`、定向刷新、逐个选择并经 SFE-ROUTE 请求，出口服务比较收到的值（只记录长度与判定）。入口必须是 NORMAL。
- **通过条件**：只有“出口收到的值与期望完全一致”的类别算已证明安全；`--check` 未通过、被 Surge 跳过、值被改变、没有到达出口的类别都不放宽。
- **证据**：`charset/result.json`、`charset-expect.json`（合成值）、`servers/exit.jsonl`。
- **回退**：命令自动恢复测试资源与选择。

## 4. 原语映射（adapterMechanism）

1. inventory 打印建议的映射：读原语取实测可用的实现（CLI 优先），主动原语（组选择、结束请求、资源刷新、临时规则增删、策略测试）取“CLI 帮助中有对应命令”或“模块 B 已实现且回环 HTTP API 可用”的实现，**未经测试命令证明前不能当作已通过**。`reloadProfile` 不由 P0 设置。
2. CLI 只执行签名校验通过的 `surge-cli`，并且只执行帮助中出现的命令；argv 中从不出现 switch-profile、reload、flush、stop、kill、outbound/enhanced/system-proxy 等全局动作。
3. 读原语的 JSON 输出（`--raw`）只接受已知结构：非 JSON、未知外层结构、任何一项缺少可识别字段（规则文本、资源 key 与位置、请求 id、策略名称）时读取直接失败，从不读成空列表或跳过该项；只有空白输出被当作“没有临时规则”。空白输出因此仍可能掩盖仍存在的规则，所以 `listTempRules: cli` 还需要 entry 的插入探测正向确认（见 3.7；inventory 在建议的映射说明中标出）后，才会被当作“规则已不存在”的证据。
4. 6.5 帮助中的临时规则增删命令与模块 B 的占位命令（`temp-rule add/remove`）不一致时，inventory 会显示 `not_in_help`；把 `inventory/surge-cli-help-relevant.txt` 中的相关行交给开发者更新服务的 CLI 原语表，**不要**手动改用帮助中的其他动词。
5. 各测试命令通过后，把映射写入数据目录的 `install.json` 的 `adapterMechanism` 字段（文件保持 0600；宿主 App 从不覆盖该字段）。映射变化会让依赖相应原语的能力回到待验证。

## 5. 提议与确认

```sh
npx tsx tools/p0/src/cli.ts propose <能力> supported --dry-run   # 先预览
npx tsx tools/p0/src/cli.ts propose <能力> supported              # 发送到 agent.sock
```

- 提议带：上下文（与服务运行时同一来源测得）、脱敏摘要、运行目录的带密钥证据摘要（`hmac-sha256:`，原始证据不离开本机）；safari_process_attribution 与 safari_udp_quic_handling 带全部门槛协议与 DNS/WebRTC/系统服务的覆盖；归属提议带进程完整路径；runtime_entry_modes 提议带入口策略。
- `supported` 只接受“通过”的结果；测量后上下文（Surge/macOS/Safari 版本、进程路径、原语映射等依赖字段）变化时拒绝，需要重测。
- 依赖工作配置身份的能力（fixed_profile_no_switch、targeted_resource_refresh、policy_path_reread、connection_continuity、auto_reload_atomic_replace、same_profile_reload_impact）是在测试配置上测得的，必须显式加 `--working-profile any`，摘要会注明“在 P0 测试配置（源配置副本）上测得”。
- 声明的 `--auto-reload`、`--takeover`、`--signing-identity` 必须有测量证据，对**每个**依赖该字段的能力都适用（不只是 auto_reload_atomic_replace）：具体值必须等于测量时的值（refresh 声明的自动重载设置，或测量时读到的值；测量时没有记录则不能声明）；`--auto-reload any` 需要本能力在自动重载开、关两种设置下的测量都得到与提议相同的结论，`--takeover any` 需要 enhanced、system_proxy、both 三种接管方式下都有，且这些测量的其余依赖上下文与当前一致；任一取值下另有相反结论的测量（不论先后）即拒绝，用作证据的测量次数与时间写入提议摘要。读不到的上下文字段记为 null，服务运行时同样读不到才会匹配；工具会提示。例外：Surge 版本与构建读不到（或不是 `6.5.0`、`10960` 这样的格式）时，依赖它们的能力不能提议，工具直接拒绝——这样的记录在服务中永远不会生效。
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
