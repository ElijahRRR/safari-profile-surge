# 2026-10-24 Mac P0 增量实测

## 测试对象与边界

- 已安装应用及 XCTest 来源：`6b776cd9313f02bc6738a294973869a6f5c1f5e6`。
- 本 PR 只修改 P0 inventory 的探测输入和回归测试，没有替换已安装应用或开放后台写 Surge 的映射。
- macOS 27.0.1 / 26A434，Safari 27.0.1 / 22625.1.29.11.28，Xcode 27.1。
- 运行中的 Surge 6.10.0 / 12500，Controller 协议 25；实例、磁盘包与 CLI 版本一致，签名验证通过。
- 测试沿用原活动配置，增强模式开、系统代理关、规则模式。没有切配置、全局代理、接管开关或全局 reload，没有结束其他应用连接。

## 本轮终态结果

| 项目 | 实际结果 | 证据边界 |
|---|---|---|
| 当前 Swift XCTest | 132 项，0 失败；xcodebuild 退出 0 | 新 DerivedData，CODE_SIGNING_ALLOWED=NO；编译并运行纯逻辑测试，未安装应用，不代表网络验收 |
| P0 instance | 退出 0；运行进程、启动时间、包信息、映像 inode/路径、签名、读取期间稳定性均通过 | V1–V5 正常实例路径；未测停止 Surge、跨版本升级等负面场景 |
| P0 inventory | 原版与修复版均退出 0 | 命令退出 0 不代表所有探测通过，须检查逐项结果 |
| 接管状态读取 | 工具结果 `takeover_state_readable: pass` | 三个状态均能经 CLI 读回；没有自动提交能力提议或更改运行中的门槛 |
| rule match | 原版 `.invalid` 输入失败；改用 `192.0.2.1` 成功 | 返回有效 rule/policy 字段，说明该原语可用；不证明 Safari 归属 |
| 临时规则 | 添加 A(REJECT) → 添加 B(DIRECT) → 删除 B 恢复 A → 删除 A 恢复基线，全部退出 0 | 仅匹配唯一合成域名，确认后加入优先和按完整文本精确撤销；不是全部入口模式测试 |
| 临时规则清理 | 前后均 0 条，主配置字节相同，profile/mode/features/start-time 相同 | 未声称其他应用长连接连续性已测 |
| 临时本地 RULE-SET 探索 | add 退出 0，但初次及延长至约 8 秒观察后均未命中文件内容，UI 出现文件加载失败警告 | 此路径不能作为绕过配置初始化的办法；尚未证明一般本地 RULE-SET 不受支持。两次规则均精确撤销、原规则求值恢复 |
| Safari 退出重开 | 确认主进程已退出后重新打开；扩展仍启用，真实弹窗读到同一合成环境和同一场景 ID 前缀 | 服务记录新的 getCurrentState/reportProfileState 成功；仅证明所测场景 |
| 自动重载设置 | 在 Surge 配置设置界面看到关闭 | 未修改开关；CLI inventory 仍读不到该设置 |
| 未激活候选配置 | 基于原配置只新增 26 行，未删除原行，`--check` 退出 0 | 资源、原配置副本及凭据仅保存在仓库外限权目录；没有激活；不代表链路连通 |

## 可复现的 inventory 误判

在含有需要目标 IP 的规则的真实配置上运行：

```text
surge-cli --raw rule match p0-inventory.invalid process-path=/usr/bin/true protocol=TCP dest-port=443
```

退出 1，错误类别为 DNS 空回答。`.invalid` 无法解析，求值还未到达 FINAL 就失败；inventory 因此把 `matchRule` 建议为 unavailable。

同一配置、不改规则，输入换为文档保留地址 `192.0.2.1`：退出 0，返回含 `rule` 和 `policy` 的 JSON。修复版 inventory 也读回 `matchRule: ok / cli`。这仅用于命令可用性探测，不发起目标连接，也不把 IP 规则结果当作域名/Safari 入站路由证据。

回归：P0 测试 22 文件 / 377 项全部通过；P0 TypeScript 检查通过；仓库扫描通过。XCTest 132 项与这次 TypeScript 修改无关，单独报告。

## 19 项能力验收矩阵

“部分”表示有真实观察，但不满足完整判定；不是 supported。以下只更新证据，不修改线上能力状态。

| 能力 | 证据状态 | 尚缺内容或阻塞 |
|---|---|---|
| safari_process_attribution | 阻塞 | 既有 Safari 与独立 WKWebView 对照仍不能给出稳定的 Safari 专属规则路径；不使用通用 WebKit 规则冒充精确识别 |
| native_profile_id | 部分 | 已有跨场景、重开/重启等观察；需按 checklist 汇总默认场景、各命名场景、重新启用、重新签名的全部行为 |
| native_bridge_ipc | 部分 | 本轮 Safari 退出重开往返成功；既有系统重启与后台卸载后闹钟唤醒证据。升级/服务生命周期及未出现的系统提示分支不能虚填通过 |
| extension_install_persistence | 部分 | 正常签名和 Safari/系统重启观察已有；安装 8 天项尚未到期，重装是否需重新启用也不能当作通过 |
| fixed_profile_no_switch | 未验证 | 需要在初始化后的固定配置内切换组并证明请求所经节点 |
| runtime_entry_modes | 未验证 | 临时规则基础语义已测，但四种模式及 Safari 精确入口仍缺 |
| entry_rules_after_restart | 未验证 | 未重启 Surge，也未测试本应用入口的完整生命周期 |
| safari_udp_quic_handling | 未验证 | 需要 Safari 专属入口和真实 UDP/QUIC 对照 |
| targeted_resource_refresh | 未验证 | 需要固定配置正式引用测试资源，读取实际 key 后做定向操作 |
| policy_path_reread | 未验证 | 需要初始化 SFE-ROUTE 及其本地 policy-path |
| external_node_underlying_proxy | 未验证 | 需要前置 + SOCKS5 正/负实际链路证据，不能用 mock 替代 |
| connection_continuity | 未验证 | 需建立并持续观察其他应用长连接，覆盖组选择/文件更新窗口 |
| auto_reload_atomic_replace | 部分前提 | UI 确认自动重载关闭；未原子替换活动主配置或其受管资源 |
| first_request_and_old_connections | 未验证 | 首业务请求、旧 WebSocket、后台窗口和恢复标签都依赖可靠入口 |
| independent_node_preflight | 未验证 | 真实候选节点与独立预检机制尚未运行 |
| takeover_state_readable | 实测通过 | 本轮 P0 正式结果通过；尚未提交网页确认，不等于线上状态已改 |
| same_profile_reload_impact | 未验证 | 按用户约束未主动重载主配置；只做记录，不能以 reload 兜底 |
| open_profile_by_id | 未验证/只记录 | 没有可验收实现 |
| profile_batch_create | 未验证/只记录 | 没有可验收实现 |

## 后续前提

现有 P0 工具要求活动配置名为 `SFE-P0-测试`，并要求测试资源实际加载。不能把默认操作提示“切到测试配置、结束再切回来”当作日常流程。已为用户准备一次初始化差异和回退：原配置副本成为固定工作配置，Safari 入口全关，合成节点与规则只用于测试。首次激活可能影响现有连接，待用户安排后才执行。随后不按场景切配置、不更新全部资源、不全局重载。

另外，inventory 仍因 Incoming 路径存在提示“待重启”；设备此前已实际重启，该提示只按路径存在判断，不能据此要求用户反复重启，也不能据此证明 Safari 专属路径安全。

本轮没有导入真实买家账号、提交登录或订单。DNS、IPv6、QUIC、WebSocket、WebRTC 的路由验收均未完成。不能报告完整功能通过。
