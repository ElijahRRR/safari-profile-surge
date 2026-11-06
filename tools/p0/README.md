# P0 能力门槛实测工具（tools/p0）

在测试 Mac 上证明或否定每一项能力门槛，并把结论作为“提议”提交给本机服务，由用户在网页后台确认。操作步骤、顺序、通过条件与回退见 [docs/P0-RUNBOOK.md](../../docs/P0-RUNBOOK.md)；验收记录模板见 [docs/ACCEPTANCE.md](../../docs/ACCEPTANCE.md)。

```sh
npx tsx tools/p0/src/cli.ts help
npx vitest run tools/p0/test     # 离线测试（只证明工具逻辑，不证明任何网络行为；也可加 --project p0）
```

要点：

- 目标 Surge Mac 6.10.0（12500），最低支持 6.10.0、构建 12500、Controller 协议 22（`service/src/surge/running-instance.ts` 的 `SURGE_MINIMUM`）。版本取自运行中的 Surge 实例，并与 `surge-cli --raw version` 交叉核对；低于最低版本、两者不一致或读不到时，依赖版本的能力不能提议。命令、参数与输出假设都以官方文档为准，文档没有写明的标为 TODO(P0)，失败即关闭。
- 复用服务的 Surge 适配层（`service/src/surge`）：同一受限原语集合与 CLI argv 允许清单，没有切换配置、重载、重启引擎、更新全部、flush、接管或出站写入；外面再加一层写入守卫（只选择 SFE-ROUTE、只对本工具登记过的单个资源 key 调用 update、只增删先登记的精确临时规则、只结束已确认 Safari 路径的请求）。调用记录、动作时间线与快照中，含读取令牌或回环地址路径的资源 key 一律遮盖。
- 测试节点与正式产品一样由本机回环资源服务提供（D10）：`resource-server` 就是产品的处理程序（`createResourceHost` + `tcpBinder`，只监听 127.0.0.1），读取令牌只在运行目录的 0600 文件中；`loopback --setup` 只改写测试配置中受管理的 SFE-ROUTE 一行（你手动重新加载一次）。发布 = 服务提供新一代 → 恰好一次单 key 更新（从不 update all，结果不明时从不重放；key 可能含令牌时只经 HTTP）→ 按产品的 `assessResourceReadback` 读回；故障场景只在产品处理程序接受了令牌正确的请求之后才改变答复。
- 规则集是本地文件，不经 `external-resource update` 刷新（HTTP API 文档：“Local resources are skipped.”）：写入后有界轮询等待 Surge 的文件监视重新读取（规则集文档：“Local files are watched and reloaded automatically when they change.”）。本地 policy-path 在自动重载关闭时不被重新读取（2026-10-24 实测），节点不再用本地文件发布。
- 配置重载用测试配置中的“配置 canary”行检测（主配置只在重载时被读取），引擎重启用引擎运行时长回落检测（6.9.0 起 reload 可能自动升级为完整引擎重启）。
- inventory 读取顶层 `--help` 与逐条 `help <command>`（6.9.0 起顶层帮助只列命令组），取词的并集决定哪些原语可以经 CLI 探测。
- 切换 Surge 配置、重启 Surge、手动重载配置都由用户在 Surge 菜单中完成；写入前打印快照与精确回退。
- 原始证据写到仓库外的限权目录（默认 `~/Library/Application Support/SafariProfileSurge/p0/<运行编号>/`，0700/0600）；终端与提议只含脱敏摘要；提议中的证据摘要是带运行密钥的 HMAC。
- 测试代理（回显、SOCKS5 出口、SOCKS5 前置）只监听 127.0.0.1，只转发测试主机与少数固定的检测主机；测试凭据是合成的。
- 结论失败即关闭：没有证据（对照应用没有测试主机记录、没有重载证据、对照时段本身不稳定、协议没有观察到）记为“不完整”或 not_tested，从不当作通过；提议中的 any 与其他声明必须有对应的测量，any 的任一取值下另有相反结论的测量即拒绝。操作员对服务执行的动作的读数（例如扩展弹窗「重新检测」）不作为协议覆盖的证据。

| 文件 | 内容 |
|---|---|
| `src/cli.ts`、`src/args.ts` | 入口与参数解析（拒绝形似凭据的参数） |
| `src/commands/*` | 各命令：inventory、test-servers、make-test-profile、attribution、resource-server、loopback（--setup、--rollback）、loopback-auth、loopback-restart、loopback-crash、charset、refresh、continuity、entry、chain、preflight、checklist、propose、rollback |
| `src/commands/loopback-ops.ts` | 回环测试资源的识别、key 安全检查、发布（publishGeneration）与读回（confirmCommitted） |
| `src/loopback-state.ts` | 读取令牌、测试资源服务的状态文件、场景集合、请求与审计记录 |
| `src/servers/*` | 回显/WebSocket/测试页、SOCKS5 出口与前置、连接登记、测试资源服务与端口占用者 |
| `src/analysis/*` | 归属、入口放行窗口、rule match 矩阵（Safari TCP/UDP/QUIC 与 Chrome 对照）、UDP/QUIC 逐协议覆盖、连续性与同一配置重载影响、重载与重启信号的纯函数分析 |
| `src/test-profile.ts` | 测试配置生成（纯函数） |
| `src/proposal.ts`、`src/context.ts` | 提议构造与上下文 |
| `src/surge-access.ts` | 适配器组合、写入守卫、原语映射建议 |
| `test/support/mini-surge.ts` | 离线测试用的 FakeSurge + 迷你代理端口（不代表真实 Surge 行为） |
| `test/support/loopback.ts` | 离线测试用的回环接线：同一处理程序同时绑定真实端口与进程内注册表，FakeSurge 经它下载 |
| `test/support/help-610.ts` | 离线测试用的 Surge 6.10 帮助文字样本（实际输出以 inventory 保存的原文为准） |
