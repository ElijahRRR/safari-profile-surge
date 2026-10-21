// propose <能力> supported|unsupported：用本次运行的测量结果构造 ProposeCapabilityRequest（上下文、脱敏摘要、
// 原始证据的带密钥摘要，必要时带逐协议覆盖、进程路径、入口策略），发送到服务 agent.sock。
// 工具只能提议；确认必须由用户在网页后台「能力门槛」页完成。--dry-run 只打印不发送。

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITY_CONTEXT_DEPS, type CapabilityKey, type CapabilityStatus } from '@sfe/contract';
import { parseCapabilityKey } from '../args.js';
import type { ContextOverrides } from '../context.js';
import { NdjsonClientError, ndjsonRequest } from '../deps.js';
import { failed, refused, usage, type ExitCode } from '../errors.js';
import { computeEvidenceManifest } from '../evidence.js';
import { buildProposal } from '../proposal.js';
import { readResult, type CapabilityResult } from '../results.js';
import type { RunDir } from '../run-dir.js';
import { DEFAULT_HOST_APP, codesignTeamId } from '../system.js';
import { measureContext, openRun, openSession, type Ctx, type Session } from './common.js';

function serviceDataDir(ctx: Ctx): string {
  if (ctx.args.strings['data-dir']) return ctx.args.strings['data-dir'];
  return ctx.deps.platform === 'darwin'
    ? join(ctx.deps.home, 'Library', 'Application Support', 'SafariProfileSurge')
    : join(ctx.deps.home, '.local', 'share', 'safari-profile-surge');
}

/** 历史结果中 auto_reload_atomic_replace 在各声明设置下是否通过。 */
export function autoReloadPassed(dir: RunDir): { on: boolean; off: boolean } {
  const out = { on: false, off: false };
  for (const f of dir.listFiles('results/history')) {
    if (!f.includes('auto_reload_atomic_replace-')) continue;
    const r = dir.readJson<CapabilityResult>(f);
    if (r?.verdict === 'pass' && (r.declaredAutoReload === 'on' || r.declaredAutoReload === 'off')) out[r.declaredAutoReload] = true;
  }
  return out;
}

export async function runPropose(ctx: Ctx): Promise<ExitCode> {
  const { out, home } = ctx.deps;
  const key: CapabilityKey = parseCapabilityKey(ctx.args.positionals[0]);
  const status = ctx.args.positionals[1] as Exclude<CapabilityStatus, 'unverified'>;
  if (status !== 'supported' && status !== 'unsupported') throw usage('参数检查失败：结论只能是 supported 或 unsupported');
  const { dir, state } = openRun(ctx);
  const result = readResult(dir, key);
  const deps = CAPABILITY_CONTEXT_DEPS[key];
  let session: Session | null = null;
  if (state.mechanism && deps.some((f) => f.startsWith('surge') || f === 'autoReload' || f === 'takeoverMode' || f === 'adapterMechanism')) {
    session = await openSession(ctx, dir, state, { needTestProfile: false }).catch(() => null);
  }
  const signingIdentity = deps.includes('signingIdentity') ? await codesignTeamId(ctx.deps.exec, ctx.args.strings['app-path'] ?? DEFAULT_HOST_APP) : null;
  const current = await measureContext(ctx, session, state, {
    entryStrategy: result?.entryStrategy ?? null,
    processPaths: result?.processPaths ?? state.processPaths,
    signingIdentity,
  });
  const overrides: ContextOverrides = {};
  if (ctx.args.strings['working-profile'] === 'any') overrides.workingProfileId = 'any';
  if (ctx.args.strings['auto-reload']) overrides.autoReload = ctx.args.strings['auto-reload'] as 'on' | 'off' | 'any';
  if (ctx.args.strings.takeover) overrides.takeoverMode = ctx.args.strings.takeover as 'enhanced' | 'system_proxy' | 'both' | 'any';
  if (ctx.args.strings['signing-identity']) {
    if (!/^[A-Z0-9]{10}$/.test(ctx.args.strings['signing-identity'])) throw usage('参数检查失败：--signing-identity 是 10 位 Team ID');
    overrides.signingIdentity = ctx.args.strings['signing-identity'];
  }
  const manifest = computeEvidenceManifest(dir);
  const requestId = `p0-${dir.id}-${key}-${randomUUID().slice(0, 8)}`;
  const req = buildProposal({
    key,
    status,
    result,
    current,
    overrides,
    evidenceDigest: manifest.digest,
    runId: dir.id,
    requestId,
    autoReloadPassed: autoReloadPassed(dir),
    note: ctx.args.strings.note ?? null,
    home,
    exists: (p) => existsSync(p),
  });
  if (req.context.autoReload === null && deps.includes('autoReload')) out.warn('自动重载设置读不到：服务运行时同样读不到，只有记录为 any 的能力才会匹配');
  if (req.context.surgeVersion === null && deps.includes('surgeVersion')) out.warn('Surge 版本读不到（getVersion 不可用）：记录为 null，只有服务运行时也读不到时才匹配');
  dir.writeJson(`proposals/${requestId}.json`, { request: req, manifest });

  out.heading(`能力提议：${key} → ${status}`);
  out.json({ ...req, summary: req.summary.split('\n') });
  if (ctx.args.booleans['dry-run']) {
    out.line('--dry-run：没有发送。');
    return 0;
  }
  const socket = join(serviceDataDir(ctx), 'agent.sock');
  let response: unknown;
  try {
    response = await ndjsonRequest({ path: socket }, { v: 1, op: 'proposeCapability', args: req }, { maxResponseBytes: 1024 * 1024, timeoutMs: 30_000 });
  } catch (e) {
    throw failed(`发送提议失败：无法连接服务 agent.sock（${e instanceof NdjsonClientError ? e.kind : 'error'}）。确认后台服务正在运行`);
  }
  const r = response as { ok?: boolean; data?: { proposal_id?: string }; error?: { code?: string; message?: string } };
  if (!r?.ok) throw refused(`发送提议失败：${r?.error?.code ?? 'UNKNOWN'} ${r?.error?.message ?? ''}`.trim());
  out.line(`提议已提交：${r.data?.proposal_id ?? '（未返回编号）'}`);
  out.line('请在网页后台「能力门槛」页核对上下文、摘要与覆盖后确认；工具不能确认，也不会改变任何设置。');
  return 0;
}
