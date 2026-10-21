// “是否发生了配置重载”的信号比较（纯函数）。P0 定义的未重载信号：
// 1. canary：引用的测试规则集被原子替换但没有刷新——之后若 Surge 已按新内容匹配，说明发生了整体重新读取；
// 2. Surge 进程启动时间（ps lstart）变化说明 Surge 重启；
// 3. 本工具之外的临时规则减少（重载/重启可能清空临时规则）；
// 4. 当前配置名变化。
// 没有任何变化且 canary 明确未被读取时才判定“未重载”；canary 不可用时结论为未知。

export interface ReloadSignals {
  at: string;
  canaryLoaded: boolean | null;
  surgeStart: string | null;
  tempRules: string[] | null;
  profileName: string | null;
}

export function compareSignals(before: ReloadSignals, after: ReloadSignals): { reloaded: boolean | null; reasons: string[] } {
  const reasons: string[] = [];
  if (after.canaryLoaded === true) reasons.push('未刷新的 canary 规则集已被重新读取');
  if (before.surgeStart !== null && after.surgeStart !== null && before.surgeStart !== after.surgeStart) reasons.push('Surge 进程启动时间变化（重启）');
  if (before.tempRules !== null && after.tempRules !== null) {
    const now = new Set(after.tempRules);
    const lost = before.tempRules.filter((r) => !now.has(r));
    if (lost.length > 0) reasons.push(`临时规则减少 ${lost.length} 条`);
  }
  if (before.profileName !== null && after.profileName !== null && before.profileName !== after.profileName) reasons.push('当前配置变化');
  if (reasons.length > 0) return { reloaded: true, reasons };
  return { reloaded: after.canaryLoaded === false ? false : null, reasons };
}
