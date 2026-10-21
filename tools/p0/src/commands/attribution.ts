// attribution（引导式）：Safari 空白测试场景、Safari 扩展页面、Chrome、其他 WebKit 应用依次访问测试页与测试主机；
// 每步结束读取 Surge 最近请求，按时间窗与测试主机归到对应应用，统计各自的进程完整路径。
// 只有在 Chrome 与其他应用中从未出现的路径才成为候选；原始记录只保留测试主机（其他主机记为 null）。

import { existsSync } from 'node:fs';
import { CAPABILITY_CRITERIA, VERIFY_ENDPOINTS } from '@sfe/contract';
import { analyzeAttribution, type AttributionApp, type AttributionRecord, type PageEvent } from '../analysis/attribution.js';
import { DEFAULT_H3_HOST, DEFAULT_IPV6_HOST, SERVER_LOGS } from '../constants.js';
import type { SurgeRequestRecord } from '../deps.js';
import { refused, type ExitCode } from '../errors.js';
import { check, logAction, verdictLabel, writeResult } from '../results.js';
import { saveState } from '../state.js';
import { ECHO_HOST } from '../test-profile.js';
import { measureContext, openRun, openSession, printResult, requireServers, type Ctx } from './common.js';

const STUN_HOST = 'stun.l.google.com';

interface Step {
  app: AttributionApp;
  title: string;
  instructions: string[];
}

function steps(port: number, h3Host: string): Step[] {
  const page = (app: string): string => `http://${ECHO_HOST}:${port}/attr/${app}`;
  return [
    {
      app: 'safari',
      title: 'Safari 空白测试场景',
      instructions: [
        '在 Safari 中切换到一个空白测试场景（没有登录任何账号），新建窗口。',
        `打开 ${page('safari')}`,
        '依次点击：HTTP/1.1、IPv4、IPv6、WebSocket（连接后等待约 5 秒）、WebRTC。',
        `点击「打开 HTTP/2 · HTTP/3 测试页」，在新标签页（https://${h3Host}/cdn-cgi/trace）刷新 3 次，记下最后一次 http= 的值。`,
      ],
    },
    {
      app: 'safari-extension',
      title: 'Safari 扩展页面请求（需要已安装并启用扩展）',
      instructions: ['在同一测试场景点击扩展图标，在弹窗中点击「重新检测」，或打开准备页，让扩展页面请求检测服务。', '扩展尚未安装时输入 skip 跳过。'],
    },
    {
      app: 'chrome',
      title: 'Chrome 对照',
      instructions: [`在 Chrome 打开 ${page('chrome')}`, '依次点击：HTTP/1.1、IPv4、IPv6、WebSocket、WebRTC；再打开 HTTP/2 · HTTP/3 测试页并刷新 3 次。'],
    },
    {
      app: 'other',
      title: '其他 WebKit 应用对照',
      instructions: [
        `在另一个使用 WebKit 的应用中访问 ${page('other')}（例如在「邮件」草稿中粘贴该链接后用快速查看预览，或在「快捷指令」中用「获取 URL 内容」）。`,
        '能点击按钮时点击 HTTP/1.1 与 IPv4；不能时只加载页面即可。',
      ],
    },
  ];
}

function toRecord(app: AttributionApp, r: SurgeRequestRecord, testHosts: Set<string>): AttributionRecord {
  const host = r.remoteHost?.toLowerCase() ?? null;
  return { app, processPath: r.processPath, host: host !== null && testHosts.has(host) ? host : null, protocol: r.protocol, policy: r.policyName };
}

export async function runAttribution(ctx: Ctx): Promise<ExitCode> {
  const { out, prompt, now } = ctx.deps;
  const { dir, state: initial } = openRun(ctx);
  let state = initial;
  const servers = await requireServers(ctx, state);
  const session = await openSession(ctx, dir, state, { needTestProfile: true });
  if (session.mechanism.listRecentRequests === 'unavailable') throw refused('前置条件不满足：没有可用的 listRecentRequests 原语，无法按进程归属');
  const h3Host = ctx.args.strings['h3-host'] ?? servers.h3Host ?? DEFAULT_H3_HOST;
  const ipv6Host = ctx.args.strings['ipv6-host'] ?? DEFAULT_IPV6_HOST;
  const grace = (ctx.args.numbers.grace ?? 3) * 1000;
  const skip = new Set(ctx.args.lists.skip ?? []);
  const hosts = { echo: ECHO_HOST, ipv4: VERIFY_ENDPOINTS[0]!.host, ipv6: ipv6Host, h3: h3Host, verify: VERIFY_ENDPOINTS.map((e) => e.host), stun: STUN_HOST };
  const testHosts = new Set([hosts.echo, hosts.ipv4, hosts.ipv6, hosts.h3, hosts.stun, ...hosts.verify].map((h) => h.toLowerCase()));

  out.heading('Safari 进程归属（引导式）');
  out.line(`通过条件：${CAPABILITY_CRITERIA.safari_process_attribution}`);
  out.line('每一步完成后按回车；输入 skip 跳过该步。不要在测试期间用这些应用访问其他网站。');

  const records: AttributionRecord[] = [];
  const skipped: AttributionApp[] = [];
  const windows: Array<{ app: AttributionApp; from: number; to: number }> = [];
  let h3Observed: string | null = null;
  for (const step of steps(servers.echoPort, h3Host)) {
    if (skip.has(step.app)) {
      skipped.push(step.app);
      continue;
    }
    out.heading(step.title);
    step.instructions.forEach((l, i) => out.line(`${i + 1}. ${l}`));
    const from = now().getTime();
    const answer = await prompt.ask('完成后按回车（跳过输入 skip）：');
    const to = now().getTime();
    if (answer === 'skip') {
      skipped.push(step.app);
      continue;
    }
    if (step.app === 'safari') {
      const v = await prompt.ask('HTTP/3 测试页最后一次显示的 http= 值（例如 http/3 或 http/2；未测直接回车）：');
      h3Observed = v && /^http\/[23]$/.test(v.trim()) ? v.trim() : null;
    }
    let recent: SurgeRequestRecord[] = [];
    try {
      recent = await session.adapter.listRecentRequests();
    } catch {
      out.warn('读取 Surge 最近请求失败：本步没有记录');
    }
    const inWindow = recent.filter((r) => r.startedAt !== null && r.startedAt.getTime() >= from - grace && r.startedAt.getTime() <= to + grace);
    // 只保留测试主机，或 Safari/WebKit 相关进程（主机记为 null），不保存其他浏览记录。
    const kept = inWindow
      .map((r) => toRecord(step.app, r, testHosts))
      .filter((r) => r.host !== null || (r.processPath !== null && /safari|webkit/i.test(r.processPath)));
    records.push(...kept);
    windows.push({ app: step.app, from, to });
    dir.writeJson(`attribution/${step.app}-records.json`, { from, to, records: kept });
    out.line(`本步记录到 ${kept.filter((r) => r.host !== null).length} 条测试请求。`);
  }

  // 测试页上报（按应用标签），只取本次运行的时间窗。
  const start = windows[0]?.from ?? 0;
  const pageEvents: PageEvent[] = dir
    .readJsonl<{ app: string; events: Array<Record<string, unknown>> }>(SERVER_LOGS.page)
    .flatMap((b) => (Array.isArray(b.events) ? b.events.map((e) => ({ ...e, app: b.app }) as Record<string, unknown>) : []))
    .filter((e) => typeof e.t === 'number' && (e.t as number) >= start - grace)
    .map((e) => ({ app: String(e.app), kind: String(e.kind), ok: Boolean(e.ok), ipVersion: typeof e.ipVersion === 'number' ? e.ipVersion : null }));

  const result = analyzeAttribution({ records, hosts, pageEvents, h3Observed, skipped, exists: (p) => existsSync(p) });
  dir.writeJson('attribution/analysis.json', { ...result, h3Observed, skipped, windows });
  const context = await measureContext(ctx, session, state, { processPaths: result.candidates });
  const saved = writeResult(dir, {
    key: 'safari_process_attribution',
    command: 'attribution',
    at: now().toISOString(),
    checks: [...result.checks, check('Safari 步骤已完成', !skipped.includes('safari'))],
    summary: [
      `通过条件：${CAPABILITY_CRITERIA.safari_process_attribution}`,
      `候选进程路径：${result.candidates.join('；') || '无'}`,
      `与 Chrome/其他应用共用（已排除）：${result.conflicts.join('；') || '无'}`,
      `Chrome 路径数 ${result.perApp.chrome.length}，其他 WebKit 应用路径数 ${result.perApp.other.length}`,
      ...Object.entries(result.coverage).map(([k, v]) => `覆盖 ${k}：${v!.result}${v!.note ? `（${v!.note}）` : ''}`),
    ],
    context,
    coverage: result.coverage,
    processPaths: result.candidates,
  });
  if (result.candidates.length > 0 && result.invalid.length === 0) state = { ...state, processPaths: result.candidates, lastContext: context };
  saveState(dir, state);
  logAction(dir, { at: now().toISOString(), command: 'attribution', action: 'attribution_analyzed', detail: { candidates: result.candidates.length } });

  out.heading(`归属结论：${verdictLabel(saved.verdict)}`);
  out.table([['应用', '命中测试主机的进程路径'], ...(['safari', 'safari-extension', 'chrome', 'other'] as const).map((a) => [a, result.perApp[a].join('\n') || '-'])]);
  out.line(`候选（只属于 Safari）：${result.candidates.join('；') || '无'}`);
  if (result.conflicts.length > 0) out.warn(`以下路径同时出现在 Chrome 或其他应用中，已排除，不能扩成通用规则：${result.conflicts.join('；')}`);
  for (const e of result.invalid) out.warn(`候选路径未通过服务校验：${e.message}`);
  out.table([['协议', '结果', '说明'], ...Object.entries(result.coverage).map(([k, v]) => [k, v!.result, v!.note ?? ''])]);
  printResult(out, saved);
  return 0;
}
