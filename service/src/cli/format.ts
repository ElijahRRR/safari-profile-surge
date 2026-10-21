// sfe 的人类可读输出：中文表格（按东亚宽字符计算列宽）与状态文案。所有来自服务的文本先去掉控制字符，
// 防止终端转义序列注入。--json 时不经过这里。

import {
  CAPABILITY_LABELS,
  environmentLabel,
  type Accepted,
  type AccountDetail,
  type ApiErrorBody,
  type CapabilityStatus,
  type CapabilityView,
  type EntryMode,
  type EnvironmentReadiness,
  type EnvironmentView,
  type FrontProxyView,
  type ImportCommitResult,
  type ImportPreview,
  type ImportRowStatus,
  type NeedsConfirmationDetails,
  type OperationKind,
  type OperationPhase,
  type OperationStatus,
  type OperationView,
  type RoutePhase,
  type RouteWarning,
  type SettingsView,
  type Snapshot,
} from '@sfe/contract';

// ---------- 文本安全与宽度 ----------

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** 去掉控制字符与双向覆盖字符（换行与制表除外再统一换成空格），避免终端注入与错位。 */
export function clean(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(CONTROL_RE, '?').replace(/[\r\n\t]+/g, ' ');
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return w;
}

function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function renderTable(headers: string[], rows: unknown[][]): string {
  const cells = rows.map((r) => headers.map((_, i) => clean(r[i] ?? '')));
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...cells.map((r) => displayWidth(r[i]!))));
  const line = (r: string[]): string => r.map((c, i) => (i === r.length - 1 ? c : padEnd(c, widths[i]!))).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n') + '\n';
}

export function renderPairs(pairs: Array<[string, unknown]>): string {
  const width = Math.max(...pairs.map(([k]) => displayWidth(k)));
  return pairs.map(([k, v]) => `${padEnd(k, width)}  ${clean(v)}`).join('\n') + '\n';
}

// ---------- 文案 ----------

export const READINESS_TEXT: Record<EnvironmentReadiness, string> = {
  invalid: '数据有误',
  needs_binding: '待关联',
  waiting_deployment: '待部署',
  deploying: '同步中',
  sync_failed: '同步失败',
  proxy_unavailable: '代理不可用',
  deployed_unverified: '已部署，待实测',
  ready: '可使用',
  activating: '切换中',
  active: '使用中',
  needs_reverify: '需要重新核验',
};

export const PHASE_TEXT: Record<OperationPhase, string> = {
  SAVED: '已保存',
  VALIDATING: '校验中',
  WAITING_DEPLOYMENT: '待部署',
  DEPLOYING: '部署中',
  DEPLOYED_UNVERIFIED: '已部署，未验证',
  PREFLIGHT_OK: '预检通过',
  READY_FOR_NEXT_OPEN: '可供下次打开',
  WAITING_ROUTE: '等待场景打开',
  SAFARI_BLOCKED: 'Safari 已阻断',
  VERIFY_ONLY: '等待 Safari 实测',
  ACTIVE_VERIFIED: '已生效',
  NORMAL_RESTORED: '已恢复普通模式',
  COMPLETED: '已完成',
  RECONCILING: '核对中',
  ROLLING_BACK: '回滚中',
  FAILED: '失败',
  SUPERSEDED: '已被取代',
  BLOCKED_NEEDS_ATTENTION: '已阻断，需要处理',
};

export const STATUS_TEXT: Record<OperationStatus, string> = {
  queued: '排队中',
  running: '执行中',
  waiting: '等待中',
  succeeded: '已完成',
  parked: '待继续',
  failed: '失败',
  superseded: '已被取代',
  needs_attention: '需要处理',
};

export const KIND_TEXT: Record<OperationKind, string> = {
  'environment.create': '新建环境',
  'environment.update': '修改环境',
  'environment.delete': '删除环境',
  'binding.bind': '关联场景',
  'binding.unbind': '解除绑定',
  'import.batch': '导入',
  'deploy.publish': '发布节点',
  'front.replace': '更换前置',
  'front.verify': '核验前置',
  'route.activate': '切换环境',
  'route.normal': '进入普通模式',
  'probe.preflight': '代理预检',
  'probe.safari': 'Safari 重测',
  'maintenance.init': '初始化工作配置',
  'maintenance.remerge': '重新合并',
  'maintenance.reconcile': '对账',
};

export const ENTRY_MODE_TEXT: Record<EntryMode, string> = {
  NORMAL: '普通模式',
  BLOCKED: '已阻断',
  VERIFY_ONLY: '仅允许检测',
  ACTIVE: '受控',
  UNKNOWN: '未知',
};

export const ROUTE_PHASE_TEXT: Record<RoutePhase, string> = {
  idle: '空闲',
  switching: '切换中',
  awaiting_safari_verify: '等待 Safari 实测',
  active_verified: '已验证',
  rolling_back: '回滚中',
  failed: '切换失败',
  external_change: '外部修改',
  attention: '需要处理',
};

export const WARNING_TEXT: Record<RouteWarning, string> = {
  old_windows_kept_open: '旧环境窗口未关闭，其后续请求将使用当前出口',
  managed_windows_on_original_rules: '旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）',
  old_session_unproven: '旧环境的后台请求与长连接是否已停止尚未经实测证明',
  launch_unverified: '本次打开未经启动验证',
  launch_order_unverified: '启动顺序未经实测：首个业务请求是否已走新出口尚未证明',
  external_selection_change: 'SFE-ROUTE 的选择在 Surge 中被外部修改，当前未验证',
  external_profile_change: 'Surge 已切到其他配置，当前未验证',
  surge_unreachable: '无法连接 Surge，路由状态无法确认',
  surge_restarted: 'Surge 已重启，入口规则需要重新确认',
  takeover_lost: 'Surge 接管已关闭，Safari 请求不再经过 Surge',
  takeover_unknown: '接管状态无法读取',
  outbound_mode_changed: 'Surge 出站模式不是规则模式，本应用入口不生效',
  entry_unverified: '入口规则未能读回确认',
  precedence_violation: '有其他规则排在本应用入口之前，可能抢先匹配 Safari 请求',
  front_missing: '前置代理在 Surge 中已不存在',
  managed_segments_changed: '受管理段或本应用文件被外部修改，已停止同步',
  rollback_needs_reverify: '切换失败，已恢复原节点并保持阻断，需要重新核验',
  probe_expired: 'Safari 实测已过期，显示的是上次结果',
  probe_failed: '最近一次 Safari 实测失败，已停止自动打开订单与填充',
  exit_ip_mismatch: '实测出口与预期出口不一致，已停止自动打开订单与填充',
};

export const CAPABILITY_STATUS_TEXT: Record<CapabilityStatus, string> = {
  supported: '已通过',
  unsupported: '不支持',
  unverified: '待验证',
};

export const IMPORT_STATUS_TEXT: Record<ImportRowStatus | 'skipped' | 'revision_conflict', string> = {
  create: '新建',
  update: '更新',
  unchanged: '无变化',
  conflict: '同名冲突',
  invalid: '无效',
  skipped: '已跳过',
  revision_conflict: '版本冲突',
};

const BINDING_TEXT: Record<EnvironmentView['binding']['state'], string> = {
  unbound: '未关联',
  bound: '已关联',
  bound_unverified_id: '已关联（场景编号待验证）',
};

const FRONT_STATE_TEXT: Record<FrontProxyView['state'], string> = {
  unverified: '待核验',
  ok: '正常',
  missing: '已不存在',
  failed: '异常',
};

const text = <K extends string>(map: Record<K, string>, key: K | null | undefined): string => (key ? (map[key] ?? clean(key)) : '—');
const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : clean(v));
const yesNo = (v: boolean | null | undefined): string => (v === true ? '是' : v === false ? '否' : '—');

function envName(env: Pick<EnvironmentView, 'displayName' | 'code'>): string {
  return environmentLabel(clean(env.displayName), clean(env.code));
}

// ---------- 渲染 ----------

export function formatError(body: ApiErrorBody): string {
  const lines = [clean(body.message)];
  for (const f of body.fieldErrors ?? []) lines.push(`  - ${clean(f.field)}：${clean(f.message)}`);
  lines.push(`（错误码 ${clean(body.code)}）`);
  return lines.join('\n') + '\n';
}

export function formatAccepted(acc: Accepted): string {
  const parts = [`已受理：操作 ${clean(acc.operation_id)}`];
  if (acc.environment_id) parts.push(`环境 ${clean(acc.environment_id)}`);
  if (acc.revision !== null && acc.revision !== undefined) parts.push(`版本 ${acc.revision}`);
  const lines = [parts.join('，') + '。'];
  if (acc.duplicate) lines.push('同一请求已提交过，返回的是原操作。');
  lines.push(`受理不代表已生效：用 sfe op ${clean(acc.operation_id)} --wait 查看进度。`);
  return lines.join('\n') + '\n';
}

export function formatEnvironmentList(envs: EnvironmentView[]): string {
  if (envs.length === 0) return '还没有环境。\n';
  return renderTable(
    ['编号', '环境', '站点', '关联', '状态', '已部署', '使用中', '实测出口'],
    envs.map((e) => [
      e.id,
      envName(e),
      e.site,
      text(BINDING_TEXT, e.binding?.state),
      text(READINESS_TEXT, e.readiness),
      e.proxy?.deployed ? `v${e.proxy.deployed.revision}` : '—',
      e.proxy?.active ? `v${e.proxy.active.revision}` : '—',
      dash(e.probes?.safari?.exitIp),
    ]),
  );
}

export function formatEnvironment(e: EnvironmentView): string {
  const proxy = e.proxy?.desired ?? e.proxy?.deployed ?? null;
  const pairs: Array<[string, unknown]> = [
    ['编号', e.id],
    ['环境', envName(e)],
    ['站点', e.site],
    ['状态', text(READINESS_TEXT, e.readiness)],
    ['关联', `${text(BINDING_TEXT, e.binding?.state)}${e.binding?.profileIdShort ? `（场景 ${clean(e.binding.profileIdShort)}）` : ''}`],
    ['代理', proxy ? `${clean(proxy.protocol)} ${clean(proxy.host)}:${proxy.port}` : '—'],
    ['代理用户名', proxy ? (proxy.hasUsername ? '已设置' : '未设置') : '—'],
    ['代理密码', proxy ? (proxy.hasPassword ? '已设置' : '未设置') : '—'],
    ['前置', proxy ? dash(proxy.frontProxyName) : '—'],
    ['期望版本', e.proxy?.desired ? `v${e.proxy.desired.revision}` : '—'],
    ['已部署版本', e.proxy?.deployed ? `v${e.proxy.deployed.revision}（${clean(e.proxy.deployed.nodeName)}）` : '—'],
    ['使用中版本', e.proxy?.active ? `v${e.proxy.active.revision}` : '—'],
    ['预期出口', dash(e.expectedExitIp)],
    ['实测出口', e.probes?.safari ? `${dash(e.probes.safari.exitIp)}（${clean(e.probes.safari.observedAt)}）` : '—'],
    ['买家号', dash(e.account?.label)],
    ['登录账号', dash(e.account?.loginIdentifierMasked)],
    ['自动打开订单', yesNo(e.autoOpenOrders)],
    ['自动填充登录', yesNo(e.autoFillLogin)],
    ['数据版本', e.revision],
  ];
  let out = renderPairs(pairs);
  if (e.lastError) out += `最近错误：${clean(e.lastError.message)}\n`;
  if (e.nextActions?.length) out += `下一步：\n${e.nextActions.map((a) => `  - ${clean(a.message)}`).join('\n')}\n`;
  return out;
}

export function formatStatus(s: Snapshot): string {
  const route = s.route;
  const active = route?.activeEnvironmentId ? s.environments?.find((e) => e.id === route.activeEnvironmentId) : undefined;
  const surge = s.surge;
  const pairs: Array<[string, unknown]> = [
    ['服务版本', `${clean(s.serviceVersion)}${s.demoMode ? '（演示模式，不代表任何网络事实）' : ''}`],
    ['入口模式', route ? `${text(ENTRY_MODE_TEXT, route.entryMode)} · ${text(ROUTE_PHASE_TEXT, route.phase)}` : '—'],
    ['当前环境', active ? `${envName(active)}（版本 v${route!.activeProxyRevision ?? '—'}）` : route?.activeEnvironmentId ? clean(route.activeEnvironmentId) : '无（普通模式或未使用）'],
    ['SFE-ROUTE 选择', dash(route?.selectedNode)],
    [
      'Surge',
      surge ? (surge.reachable ? `已连接 ${dash(surge.version)}${surge.build ? ` (${clean(surge.build)})` : ''} · 配置 ${dash(surge.currentProfileName)}` : '无法连接') : '—',
    ],
    ['环境', `共 ${s.environments?.length ?? 0} 个`],
  ];
  let out = renderPairs(pairs);
  if (route?.warnings?.length) out += `警告：\n${route.warnings.map((w) => `  - ${text(WARNING_TEXT, w)}`).join('\n')}\n`;
  if (s.pendingOperations?.length) {
    out += `进行中的操作：\n${s.pendingOperations.map((o) => `  ${clean(o.id)}  ${text(KIND_TEXT, o.kind)}  ${text(PHASE_TEXT, o.phase)}`).join('\n')}\n`;
  }
  return out;
}

export function formatOperation(op: OperationView): string {
  const pairs: Array<[string, unknown]> = [
    ['操作', op.id],
    ['类型', text(KIND_TEXT, op.kind)],
    ['阶段', text(PHASE_TEXT, op.phase)],
    ['状态', text(STATUS_TEXT, op.status)],
    ['环境', dash(op.environmentId)],
    ['更新时间', dash(op.updatedAt)],
  ];
  let out = renderPairs(pairs);
  if (op.error) out += `错误：${clean(op.error.message)}（${clean(op.error.code)}）\n`;
  if (op.result?.readbackLevel === 'partial') out += '已部署，读回不完整。\n';
  if (op.steps?.length) out += `步骤：\n${op.steps.map((st) => `  ${clean(st.at)}  ${text(PHASE_TEXT, st.phase)}  ${clean(st.message)}`).join('\n')}\n`;
  return out;
}

export function formatOperationProgress(op: OperationView): string {
  return `${text(PHASE_TEXT, op.phase)}（${text(STATUS_TEXT, op.status)}）\n`;
}

export function formatImportPreview(p: ImportPreview): string {
  const totals = (Object.keys(IMPORT_STATUS_TEXT) as Array<keyof typeof IMPORT_STATUS_TEXT>)
    .filter((k) => k in (p.totals ?? {}))
    .map((k) => `${IMPORT_STATUS_TEXT[k]} ${p.totals[k as ImportRowStatus] ?? 0}`)
    .join('，');
  let out = `预览：${totals || '没有数据行'}。\n`;
  for (const f of p.fileErrors ?? []) out += `文件错误：${clean(f.field)}：${clean(f.message)}\n`;
  if (p.rows?.length) {
    out += renderTable(
      ['行', '结果', '环境', '名称', '变化', '问题'],
      p.rows.map((r) => [
        r.row,
        text(IMPORT_STATUS_TEXT, r.status),
        dash(r.environment_id),
        dash(r.displayName),
        (r.diff ?? []).map((d) => `${clean(d.field)}: ${dash(d.before)} → ${dash(d.after)}`).join('；') || '—',
        [
          ...(r.errors ?? []).map((e) => `${clean(e.field)}：${clean(e.message)}`),
          ...(r.conflictCandidates?.length ? [`同名：${r.conflictCandidates.map((c) => `${clean(c.environment_id)}（${clean(c.label)}，v${c.revision}）`).join('、')}`] : []),
        ].join('；') || '—',
      ]),
    );
  }
  return out;
}

export function formatImportCommit(r: ImportCommitResult): string {
  let out = `已提交：批次 ${clean(r.batch_id)}，操作 ${clean(r.operation_id)}。\n`;
  out += renderTable(
    ['行', '结果', '环境', '操作', '问题'],
    (r.items ?? []).map((i) => [i.row, text(IMPORT_STATUS_TEXT, i.status), dash(i.environment_id), dash(i.operation_id), i.error ? clean(i.error.message) : '—']),
  );
  return out;
}

export function formatCapabilities(list: CapabilityView[]): string {
  return renderTable(
    ['能力', '名称', '记录结论', '有效结论', '过期原因'],
    list.map((c) => [c.key, CAPABILITY_LABELS[c.key] ?? c.label, text(CAPABILITY_STATUS_TEXT, c.status), text(CAPABILITY_STATUS_TEXT, c.effectiveStatus), c.staleReasons?.join('、') || '—']),
  );
}

export function formatFrontProxies(list: FrontProxyView[]): string {
  if (list.length === 0) return '还没有登记前置代理。\n';
  return renderTable(
    ['编号', 'Surge 节点', '状态', '默认', '已停用', '依赖环境'],
    list.map((f) => [f.id, f.surgeName, text(FRONT_STATE_TEXT, f.state), yesNo(f.isDefault), yesNo(f.retired), f.dependentEnvironmentIds?.length ?? 0]),
  );
}

export function formatFrontProxy(f: FrontProxyView): string {
  return `已登记前置：${clean(f.surgeName)}（${clean(f.id)}${f.isDefault ? '，默认' : ''}）。\n`;
}

export function formatSettings(s: SettingsView): string {
  return renderPairs([
    ['Surge CLI 路径', dash(s.surgeCliPath)],
    ['工作配置', dash(s.workingProfilePath)],
    ['入口策略', dash(s.entryStrategy)],
    ['Safari 进程路径', s.safariProcessPaths?.length ? s.safariProcessPaths.map(clean).join('、') : '—'],
    ['检测服务', dash(s.verifyEndpointId)],
    ['默认前置', dash(s.defaultFrontProxyId)],
    ['场景到达等待（秒）', s.profileArrivalTimeoutSec],
    ['Safari 实测等待（秒）', s.safariVerifyTimeoutSec],
    ['实测有效期（秒）', s.probeTtlSec],
    ['对账间隔（秒）', s.reconcileIntervalSec],
  ]);
}

export function formatAccount(a: AccountDetail): string {
  return renderPairs([
    ['环境', a.environment_id],
    ['买家号', dash(a.label)],
    ['登录账号', dash(a.loginIdentifier)],
    ['登录密码', a.hasPassword ? '已设置' : '未设置'],
  ]);
}

const POLICY_FLAG = { closed_confirmed: 'closed', keep_open_acknowledged: 'keep' } as const;

/** NEEDS_CONFIRMATION：说明情况，并给出可以原样重新执行的完整命令。 */
export function formatNeedsConfirmation(details: Partial<NeedsConfirmationDetails> | undefined, rerunBase: string[]): string {
  const lines: string[] = [];
  const reason = details?.reason;
  if (reason === 'other_environment_active') lines.push(`需要确认：当前正在使用环境「${dash(details?.currentEnvironmentLabel ?? details?.currentEnvironmentId)}」。`);
  else if (reason === 'managed_environment_active') lines.push(`需要确认：托管环境「${dash(details?.currentEnvironmentLabel ?? details?.currentEnvironmentId)}」正在使用。`);
  else if (reason === 'other_profiles_open') lines.push('需要确认：其他场景有打开的窗口。');
  else lines.push('需要确认旧窗口的处理方式。');
  const others = details?.otherProfilesOpen ?? [];
  if (others.length) lines.push(`最近上报有打开窗口的场景：${others.map((o) => `${clean(o.profileIdShort)}${o.environmentLabel ? `（${clean(o.environmentLabel)}）` : ''}`).join('、')}`);
  if (details?.limitation) lines.push(`限制：${clean(details.limitation)}`);
  const confirmed = details?.currentEnvironmentId ? clean(details.currentEnvironmentId) : 'none';
  const options = details?.options?.length ? details.options : (['closed_confirmed', 'keep_open_acknowledged'] as const);
  for (const opt of options) {
    const label = opt === 'closed_confirmed' ? '已手动关闭旧环境窗口后继续' : '不关闭旧窗口，直接继续（旧窗口之后的请求不再受原环境控制）';
    const flag = POLICY_FLAG[opt as keyof typeof POLICY_FLAG];
    if (!flag) continue;
    lines.push(`${label}：`);
    lines.push(`  ${[...rerunBase, '--old-windows', flag, '--confirmed-env', confirmed].map(shellQuote).join(' ')}`);
  }
  return lines.join('\n') + '\n';
}

export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
