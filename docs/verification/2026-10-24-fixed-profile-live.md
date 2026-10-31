# 2026-10-24 固定配置初始化与真实 Surge 测量

## 版本与授权

- 初次真实网络测量工具 SHA：`62b3d4906d780486a87af0a9d09b6f364583e861`；已安装应用仍为 `6b776cd9313f02bc6738a294973869a6f5c1f5e6`。
- 本报告及修复基于开发分支 `e254cfad36466e721061f1fc5db59405b7f3fbca`（已合并 PR #11），没有更新已安装应用。
- Surge Mac 6.10.0 / build 12500，Controller 25；自动重载在 UI 中为关闭，未修改该开关。
- 用户在本次维护窗口明确允许一次初始化及必要回退。原活动配置副本只新增 26 行，差异及离线检查已审阅；首次成功切换到固定配置 `SFE-P0-测试`，之后没有再切换。
- 新增项仅含默认 REJECT 的测试组、关闭的 Safari 入口、本机合成测试节点和仅回环监听的认证管理接口。没有启用应用后台的 Surge 写操作映射。
- 原 `Surge.conf` 字节保持不变；前后 mode、features、Surge 启动时间、版本相同。没有 reload、全局代理或接管开关变化，没有清空连接。

## 本轮实际结论

| 项目 | 实际观察 | 判定边界 |
|---|---|---|
| 固定配置与组选择 | A → B → A 读回正确；真实合成 HTTP 请求分别经 p0-a → p0-b → p0-a，三次均经前置 | 配置身份、引擎运行时长及 canary 表明无重载；Safari 专属路由未测 |
| 本地节点资源 | 原子替换加入 C 后，8 秒内仍只有 REJECT/A/B；单 key update 报 skipped，额外轮询后仍未变化 | `policy_path_reread` 与 `targeted_resource_refresh` 不通过；不能将落盘当作发布 |
| 本地规则集 | 原子替换 canary 规则集，8 秒内未读取；单 key update 同样 skipped | `auto_reload_atomic_replace` 在当前自动重载关闭条件下不通过；没有开启自动重载或用主配置 reload 兜底 |
| 主配置 canary | 原子替换只影响合成域名的一行，后续请求仍命中旧规则 | 符合 UI 自动重载关闭的观察，不代表资源会单独刷新 |
| 其他应用连续性 | 300 秒观察；152 秒基线内 151/151 短请求成功；后续各窗口短请求成功，流与 WebSocket 重置均 0，始终 p0-plain | 只证明本轮文件写入尝试、组选择期间未中断；新增节点实际没有发布，完整发布连续性仍不完整 |
| Chrome 对照 | 同一 300 秒窗口有 207/207 合成 echo 成功、207/207 检测请求成功、1 次 WS 打开且无 ws_close；页面曾显示持续 WS 消息 | 原工具的组选择时间窗仅约 0.3 秒，未收到窗口内上报而判不完整。不能把完整窗口统计悄悄写成原工具通过 |
| IPv6 对照 | Chrome 页 41 次 ipv6_poll 均失败 | 未建立可用 IPv6 对照，不能声称 IPv6 路由验收完成；DNS/QUIC/WebRTC 也未验收 |
| 前置正向链路 | A/B 的合成回显均记录 throughFront=true，前置有到出口的 CONNECT | 正向链路有证据；坏前置/缺失前置测试需要加载新节点，受资源重新读取阻塞，整个能力未通过 |
| 现有 HTTP 独立预检 | 按外部节点名称调用 `/v1/policies/test` 返回 HTTP 200、空响应，合成回显没有对应请求 | 当前应用实现不通过；HTTP 200 不代表探测成功 |
| 按标识符的候选路线 | CLI `http probe <synthetic-url> <POLICY identifier>` 可到达 B；组前后均 REJECT。修正合成服务 HEAD 后得到 200，回显记录 HEAD/p0-b/throughFront=true | 可行的基础原语，尚未接入服务实现，不能改现有预检门槛为通过；标识符必须实时读取，不能硬编码 |

## 实测暴露的测试工具问题与修复

### 连续性错误通过

在本地资源不重新读取时，refresh 已明确报告失败，但 continuity 只检测 `test_file_written:sfe-nodes.list`，仍给出 `connection_continuity: pass`。本轮真实出现了这种矛盾。

修复：refresh 只有在新增 C 被自动读回、选中，且真实请求成功经过 C 后，才写入 `node_publication_verified`。continuity 要求同一观察窗口内先写入、再取得这条真实证据；旧窗口、操作员标记、单独的文件写入和 update 调用均不满足。缺失时结论为 incomplete，流量统计仍保留。

已用修复后的判定对本轮原始动作时间线离线复核，最新连续性结果改为 incomplete，原工具结果保留在本地 history。这是证据复核，不是重新执行网络测试，也未提交线上 supported 提议。

### 合成回显不支持 HEAD

Surge CLI `http probe` 使用 HEAD；原合成 `/ip` 仅支持 GET，即使请求正确经过 B 和前置，仍返回 404。修复为 GET/HEAD 都支持，HEAD 无响应体但保留脱敏服务端链路记录。真机复验得到 HTTP 200，仍保持组选择 REJECT。

HTTP API 的另一个差异尚未修复：传入外部节点 identifier 后不再空响应，但实际尝试默认测试地址，而非给定的合成地址。出口白名单拒绝该目标，返回 SOCKS 错误；没有扩大测试服务的公网白名单。现有 API 适配器还假定响应以传入 policy 字符串为键，需要在采用 identifier/CLI 路线时一起处理。

官方资料：[HTTP API](https://manual.nssurge.com/tools/http-api.html)、[Testing](https://manual.nssurge.com/tools/testing.html)。官方文档是接口参考；上述结论以本机实际命令、回显和状态读回为依据。没有因新版文档内容自动升级 Surge。

## 验证与终态

- P0 回归：23 文件 / 386 项全部通过，TypeScript 检查通过。
- 包含“未读取资源不得通过”、新节点真实请求后的正面标记、过期/无配对/窗口外证据拒绝、HEAD 状态及空响应体检查。
- 早前本机 XCTest 132 项通过仍有效，本次只改 P0 工具，无新应用部署。
- 所有临时服务已结束，测试 Chrome 页已关闭，合成监听端口确认无监听。
- SFE-ROUTE 恢复为 REJECT，加载成员及磁盘节点资源均为 A/B，临时规则 0 条。
- 四份入口仍是 `/var/empty/sfe-entry-witness` 的关闭规则；没有真实 Safari/WebKit 进程规则。
- 按固定工作配置约定保留 `SFE-P0-测试` 为活动配置。保留其本机认证接口、合成资源及仅合成域名的 canary；测试服务停止后合成节点不可用，Safari 入口保持关闭。原配置和限权备份保留用于后续必要回退。
- 未导入真实买家资料、自动提交登录或下单；敏感配置、管理密钥及原始请求日志未加入仓库。

## 尚未达到完整功能验收

当前主要阻塞是：稳定的 Safari 精确归属、无主配置重载的资源重新读取、独立预检适配。入口模式、首请求与旧连接、普通模式恢复、真实 HTTP/HTTPS 出口与策略双重核对、负面前置和恢复场景仍不能宣称通过。不能以组选择成功、离线测试或本轮合成正向链路替代这些验收。
