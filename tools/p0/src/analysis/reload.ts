// “是否发生了配置重载或重启”的信号比较（纯函数）。P0 定义的未重载信号（Surge Mac 6.10）：
// 1. 配置 canary：原子替换测试配置（主配置）中的一行 canary 规则——主配置不在文件监视之内，只在配置重载时被读取；
//    之后若 Surge 已按新内容匹配，说明发生了配置重载（6.9.0 起 reload 只应用差异，也会读取这一行）。
//    不再用规则集做重载检测：本地规则集文件由文件监视自动重新读取（规则集文档：“Local files are watched and reloaded
//    automatically when they change.”），它是 refresh 测量的对象，不是重载的证据；
// 2. 引擎运行时长（getRuntimeInfo：`dump performance` 的 uptime 或 /v1/metrics 的 surge_uptime_seconds）变小：引擎重启
//    （restart-engine，或 6.9.0+ 的 reload 在需要时“Automatically performs a full engine restart”）；
// 3. Surge 进程启动时间（ps lstart）变化：Surge 退出重开；
// 4. 本工具之外的临时规则减少（引擎重启与退出都清空临时规则；reload 保留它们）；
// 5. 当前配置名变化。
// 没有任何变化且配置 canary 明确未被读取时才判定“未重载”；配置 canary 不可用时结论为未知。

export interface ReloadSignals {
  at: string;
  /** 配置 canary 是否已按新内容生效；没有布置或无法判断为 null。 */
  profileCanaryLoaded: boolean | null;
  surgeStart: string | null;
  /** 引擎运行时长（秒）；读不到为 null。 */
  engineUptimeSeconds: number | null;
  tempRules: string[] | null;
  profileName: string | null;
}

export interface SignalComparison {
  /** 发生了配置重载或重启；无法判断为 null。 */
  reloaded: boolean | null;
  reasons: string[];
  /** Surge 进程启动时间变化（退出重开）。 */
  processRestarted: boolean;
  /** 引擎运行时长变小（进程未变时只重启了引擎）；读不到为 null。 */
  engineRestarted: boolean | null;
}

export function compareSignals(before: ReloadSignals, after: ReloadSignals): SignalComparison {
  const reasons: string[] = [];
  if (after.profileCanaryLoaded === true) reasons.push('配置 canary 已被重新读取（发生了配置重载）');
  const processRestarted = before.surgeStart !== null && after.surgeStart !== null && before.surgeStart !== after.surgeStart;
  if (processRestarted) reasons.push('Surge 进程启动时间变化（重启）');
  const engineRestarted = before.engineUptimeSeconds === null || after.engineUptimeSeconds === null ? null : after.engineUptimeSeconds < before.engineUptimeSeconds;
  if (engineRestarted === true) reasons.push('引擎运行时长回落（引擎重启）');
  if (before.tempRules !== null && after.tempRules !== null) {
    const now = new Set(after.tempRules);
    const lost = before.tempRules.filter((r) => !now.has(r));
    if (lost.length > 0) reasons.push(`临时规则减少 ${lost.length} 条`);
  }
  if (before.profileName !== null && after.profileName !== null && before.profileName !== after.profileName) reasons.push('当前配置变化');
  if (reasons.length > 0) return { reloaded: true, reasons, processRestarted, engineRestarted };
  return { reloaded: after.profileCanaryLoaded === false ? false : null, reasons, processRestarted, engineRestarted };
}
