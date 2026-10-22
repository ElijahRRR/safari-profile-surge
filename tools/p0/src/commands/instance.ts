// instance（只读）：读取运行中的 Surge 实例——与服务同一读取器（surge/running-instance.ts）——逐条打印规则结果，
// 把完整证据（每条规则的结果与耗时、ctime 与启动时间之差、lsof 是否匹配、codesign 退出码、被排除的其他 Surge 进程）
// 写入运行目录 instance/<时间>.json。从不执行 surge-cli、从不写 Surge 或它的文件，也从不触发更新（P0-RUNBOOK V1–V10）。
// 能确认时退出 0；无法确认时退出 3（失败原因已打印）。
// --self-test-bundle <运行目录内的 .app>：V6 自测——用同一组规则核对你在运行目录中做的临时 App（不碰 Surge），
// 包标识必须是 SELF_TEST_BUNDLE_ID；结果只写证据，从不进入能力上下文。

import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Output } from '../io.js';
import { EXIT, P0Error, refused, type ExitCode } from '../errors.js';
import {
  RUNNING_INSTANCE_FAILURE_TEXT,
  createRunningInstanceReader,
  defaultRunningInstanceDeps,
  isRunningInstanceFailure,
  type RunningInstanceReport,
  type RunningInstanceRule,
  type RunningInstanceStep,
} from '../deps.js';
import type { RunDir } from '../run-dir.js';
import { SURGE_APP, appVersion } from '../system.js';
import { createRun, openRun, readSurgeInstance, type Ctx } from './common.js';

/** V6 自测 App 的包标识（P0-RUNBOOK §1.5）。 */
export const SELF_TEST_BUNDLE_ID = 'test.sfe.p0.instance-selftest';

export const INSTANCE_RULE_LABELS: Readonly<Record<RunningInstanceRule, string>> = {
  platform: '平台',
  process: '进程（V1）',
  bundle_executable: '主程序（V1/V2）',
  start_time: '启动时间（V1）',
  info_plist: '包信息（V2）',
  not_modified: '启动后未修改（V3）',
  running_image: '运行映像（V4）',
  signature: '签名（V5）',
  stable: '读取期间未变化',
};

const OUTCOME_LABELS: Readonly<Record<RunningInstanceStep['outcome'], string>> = { pass: '通过', fail: '不通过', cached: '沿用缓存' };

function seconds(ms: unknown): string {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(3)} 秒` : '未知';
}

/** 一条规则的说明（只用计数、代码、版本与时间差；路径等由输出层脱敏）。 */
export function describeInstanceStep(step: RunningInstanceStep): string {
  const d = step.detail as Record<string, unknown>;
  const reason = isRunningInstanceFailure(d.reason) ? RUNNING_INSTANCE_FAILURE_TEXT[d.reason] : null;
  const parts: string[] = [];
  switch (step.rule) {
    case 'process':
      parts.push(`ps 共 ${String(d.lines ?? '?')} 行；期望包内主程序进程 ${String(d.inBundle ?? '?')} 个；排除其他 Surge 相关进程 ${Array.isArray(d.others) ? d.others.length : 0} 个`);
      if (typeof d.code === 'number') parts.push(`ps 退出码 ${d.code}`);
      break;
    case 'bundle_executable':
      parts.push(`CFBundleExecutable ${d.executable === null || d.executable === undefined ? '读不到' : String(d.executable)}；匹配 ${String(d.matching ?? 0)} 个；其他位置的 Surge.app ${String(d.otherSurgeApps ?? 0)} 个`);
      break;
    case 'start_time':
      parts.push(d.startedAt ? `pid ${String(d.pid)}，启动于 ${String(d.startedAt)}（UTC）` : `pid ${String(d.pid)}`);
      break;
    case 'info_plist':
      if (d.bundleId) parts.push(`${String(d.bundleId)} ${String(d.version ?? '?')}（${String(d.build ?? '?')}）`);
      if (Array.isArray(d.missing)) parts.push(`读不到 ${d.missing.join('、')}`);
      break;
    case 'not_modified': {
      const p = d.plist as Record<string, unknown> | undefined;
      const e = d.executable as Record<string, unknown> | undefined;
      if (p && e) {
        parts.push(`Info.plist ctime ${seconds(p.ctimeMinusStartMs)}、birthtime ${seconds(p.birthtimeMinusStartMs)}；主程序 ctime ${seconds(e.ctimeMinusStartMs)}、birthtime ${seconds(e.birthtimeMinusStartMs)}（相对启动，负数为早于启动）`);
      }
      break;
    }
    case 'running_image':
      parts.push(`lsof 退出码 ${String(d.code)}，映射 ${String(d.entries ?? 0)} 项；inode ${d.inodeMatch ? '一致' : '不一致'}，路径 ${d.pathMatch ? '一致' : '不一致'}${d.sameEntry === false && d.inodeMatch && d.pathMatch ? '（不是同一项）' : ''}`);
      break;
    case 'signature':
      if (d.invalidTeamId) parts.push('--surge-team-id 不是 10 位 Team ID，未执行 codesign');
      else if (typeof d.code === 'number') parts.push(`codesign 退出码 ${d.code}${d.teamRequirement ? '（含 Team ID 要求）' : '（未提供 Team ID，只做 --verify --strict）'}`);
      break;
    default:
      break;
  }
  if (reason) parts.unshift(reason);
  return parts.join('；');
}

export function printInstanceReport(out: Output, report: RunningInstanceReport): void {
  out.table([['规则', '结果', '耗时', '说明'], ...report.steps.map((s) => [INSTANCE_RULE_LABELS[s.rule], OUTCOME_LABELS[s.outcome], `${s.ms} ms`, describeInstanceStep(s)])]);
  const others = report.steps.find((s) => s.rule === 'process')?.detail.others;
  if (Array.isArray(others) && others.length > 0) {
    out.line('已排除的其他 Surge 相关进程：');
    for (const o of others as Array<{ pid: number; uid: number; path: string; excluded: string }>) out.line(`  pid ${o.pid}（uid ${o.uid}）${o.excluded}：${o.path}`);
  }
}

export function instanceSummaryText(report: RunningInstanceReport): string {
  const r = report.result;
  return r.ok
    ? `${r.instance.version}（${r.instance.build}）· pid ${r.instance.pid} · 启动于 ${r.instance.startedAt}${report.cached ? ' · 包信息与签名沿用缓存' : ''}`
    : `无法确认（${RUNNING_INSTANCE_FAILURE_TEXT[r.reason]}）：依赖 Surge 版本的能力按待验证处理`;
}

/** 写入运行目录的证据：读取结果、逐条规则、磁盘上 Surge.app 的版本（defaults read，只作旁证）及两者是否一致。 */
export function instanceEvidence(at: string, report: RunningInstanceReport, onDisk: { version: string | null; build: string | null }): Record<string, unknown> {
  const r = report.result;
  const differs = r.ok && onDisk.version !== null && onDisk.build !== null ? onDisk.version !== r.instance.version || onDisk.build !== r.instance.build : null;
  return { at, result: r, cached: report.cached, steps: report.steps, onDisk: { ...onDisk, source: 'defaults read（只作旁证，不是运行实例版本）' }, runningDiffersFromOnDisk: differs };
}

export function warnOnDiskDifference(out: Output, report: RunningInstanceReport, onDisk: { version: string | null; build: string | null }): void {
  const r = report.result;
  if (!r.ok || onDisk.version === null || onDisk.build === null) return;
  if (onDisk.version !== r.instance.version || onDisk.build !== r.instance.build) {
    out.warn(
      `磁盘上的 Surge.app（defaults read）是 ${onDisk.version}（${onDisk.build}），运行实例读取到 ${r.instance.version}（${r.instance.build}）：两者不一致，以运行实例为准；请记录并在 Surge 稳定后重新运行 instance`,
    );
  }
}

function openOrCreateRun(ctx: Ctx): ReturnType<typeof openRun> {
  if (ctx.args.strings.run) return openRun(ctx);
  try {
    return openRun(ctx);
  } catch (e) {
    // 还没有任何运行：新建一个（只读命令也需要放证据的限权目录）
    if (e instanceof P0Error && e.code === 'refused') return createRun(ctx);
    throw e;
  }
}

/** 自测 App 必须是运行目录内的 .app（按真实路径判断），避免把规则指向其他应用。 */
function selfTestBundle(dir: RunDir, path: string): string {
  if (!isAbsolute(path) || !path.endsWith('.app')) throw refused('自测失败：--self-test-bundle 必须是运行目录内 .app 的绝对路径');
  let real: string;
  let root: string;
  try {
    real = realpathSync(path);
    root = realpathSync(dir.path);
  } catch {
    throw refused('自测失败：--self-test-bundle 指向的 App 不存在');
  }
  if (!real.startsWith(`${root}/`)) throw refused('自测失败：--self-test-bundle 必须位于本次运行目录内');
  return path;
}

async function selfTestReport(ctx: Ctx, bundle: string): Promise<RunningInstanceReport> {
  const deps = defaultRunningInstanceDeps({ platform: ctx.deps.platform, uid: process.getuid?.() ?? -1, exec: ctx.deps.exec });
  return createRunningInstanceReader(deps, { expectedBundle: bundle, bundleIds: [SELF_TEST_BUNDLE_ID], teamId: null }).inspect();
}

export async function runInstance(ctx: Ctx): Promise<ExitCode> {
  const { out, now, exec } = ctx.deps;
  const { dir } = openOrCreateRun(ctx);
  const at = now().toISOString();
  const selfTest = ctx.args.strings['self-test-bundle'];
  if (selfTest !== undefined) {
    const bundle = selfTestBundle(dir, selfTest);
    out.heading(`运行实例规则自测（临时 App，不是 Surge） · 运行 ${dir.id}`);
    const report = await selfTestReport(ctx, bundle);
    const file = `instance/selftest-${at.replace(/[:.]/g, '')}.json`;
    dir.writeJson(file, { ...instanceEvidence(at, report, { version: null, build: null }), selfTest: { bundle } });
    printInstanceReport(out, report);
    out.line(`自测结果：${report.result.ok ? `通过（${report.result.instance.version}（${report.result.instance.build}））` : `${report.result.reason}（${RUNNING_INSTANCE_FAILURE_TEXT[report.result.reason]}）`}`);
    out.line(`证据：${dir.file(file)}`);
    return report.result.ok ? EXIT.OK : EXIT.REFUSED;
  }
  out.heading(`运行中的 Surge（只读） · 运行 ${dir.id}`);
  const report = await readSurgeInstance(ctx);
  const onDisk = await appVersion(exec, SURGE_APP);
  const file = `instance/${at.replace(/[:.]/g, '')}.json`;
  dir.writeJson(file, instanceEvidence(at, report, onDisk));
  printInstanceReport(out, report);
  out.line(`运行中的 Surge：${instanceSummaryText(report)}`);
  out.line(`磁盘上的 Surge.app（旁证）：${onDisk.version ?? '读不到'}（${onDisk.build ?? '读不到'}）`);
  warnOnDiskDifference(out, report, onDisk);
  out.line(`证据：${dir.file(file)}`);
  return report.result.ok ? EXIT.OK : EXIT.REFUSED;
}
