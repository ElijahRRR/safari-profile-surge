# P0 能力门槛实测工具（tools/p0）

在测试 Mac 上证明或否定每一项能力门槛，并把结论作为“提议”提交给本机服务，由用户在网页后台确认。操作步骤、顺序、通过条件与回退见 [docs/P0-RUNBOOK.md](../../docs/P0-RUNBOOK.md)；验收记录模板见 [docs/ACCEPTANCE.md](../../docs/ACCEPTANCE.md)。

```sh
npx tsx tools/p0/src/cli.ts help
npx vitest run tools/p0/test     # 离线测试（只证明工具逻辑，不证明任何网络行为；也可加 --project p0）
```

要点：

- 复用服务的 Surge 适配层（`service/src/surge`）：同一受限原语集合，没有切换配置、重载全部、更新全部、flush、接管或出站写入；外面再加一层写入守卫（只选择 SFE-ROUTE、只刷新本工具创建的测试资源、只增删先登记的精确临时规则、只结束已确认 Safari 路径的请求）。
- 切换 Surge 配置、重启 Surge、手动重载配置都由用户在 Surge 菜单中完成；写入前打印快照与精确回退。
- 原始证据写到仓库外的限权目录（默认 `~/Library/Application Support/SafariProfileSurge/p0/<运行编号>/`，0700/0600）；终端与提议只含脱敏摘要；提议中的证据摘要是带运行密钥的 HMAC。
- 测试代理（回显、SOCKS5 出口、SOCKS5 前置）只监听 127.0.0.1，只转发测试主机与少数固定的检测主机；测试凭据是合成的。

| 文件 | 内容 |
|---|---|
| `src/cli.ts`、`src/args.ts` | 入口与参数解析（拒绝形似凭据的参数） |
| `src/commands/*` | 各命令：inventory、test-servers、make-test-profile、attribution、charset、refresh、continuity、entry、chain、preflight、checklist、propose、rollback |
| `src/servers/*` | 回显/WebSocket/测试页、SOCKS5 出口与前置、连接登记 |
| `src/analysis/*` | 归属、入口放行窗口、连续性、重载信号的纯函数分析 |
| `src/test-profile.ts` | 测试配置生成（纯函数） |
| `src/proposal.ts`、`src/context.ts` | 提议构造与上下文 |
| `src/surge-access.ts` | 适配器组合、写入守卫、原语映射建议 |
| `test/support/mini-surge.ts` | 离线测试用的 FakeSurge + 迷你代理端口（不代表真实 Surge 行为） |
