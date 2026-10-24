// propose <能力> supported|unsupported：用本次运行的测量结果构造 ProposeCapabilityRequest（上下文、脱敏摘要、
// 原始证据的带密钥摘要，必要时带逐协议覆盖、进程路径、入口策略），发送到服务 agent.sock。
// 工具只能提议；确认必须由用户在网页后台「能力门槛」页完成。--dry-run 只打印不发送。

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITY_CONTEXT_DEPS, type CapabilityKey, type CapabilityStatus } from '@sfe/contract';
import { parseCapabilityKey } from '../args.js';
import type { ContextOverrides } from '../context.js';
import { NdjsonClientError, RUNNING_INSTANCE_FAILURE_TEXT, SURGE_VERSION_CHECK_FAILURE_TEXT, ndjsonRequest, serviceLimitsExceeded, versionContextErrors } from '../deps.js';
import { failed, refused, usage, type ExitCode } from '../errors.js';
import { computeEvidenceManifest } from '../evidence.js';
import { buildProposal } from '../proposal.js';
import { readResult, readResultHistory } from '../results.js';
import { DEFAULT_HOST_APP, codesignTeamId } from '../system.js';
import { measureContextWithInstance, openRun, openSession, type Ctx, type Session } from './common.js';
import { serviceLimitText } from './instance.js';

function serviceDataDir(ctx: Ctx): string {
  if (ctx.args.strings['data-dir']) return ctx.args.strings['data-dir'];
  return ctx.deps.platform === 'darwin'
    ? join(ctx.deps.home, 'Library', 'Application Support', 'SafariProfileSurge')
    : join(ctx.deps.home, '.local', 'share', 'safari-profile-surge');
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
  const { context: current, instance, versionCheck } = await measureContextWithInstance(ctx, session, state, {
    entryStrategy: result?.entryStrategy ?? null,
    processPaths: result?.processPaths ?? state.processPaths,
    signingIdentity,
  });
  // 依赖 Surge 版本/构建的能力：读不到运行中 Surge 的版本（或读到的不是版本，或服务的读取器在它的时限内读不到），
  // 或与 `surge-cli --raw version` 交叉核对不通过（不一致、低于最低支持版本 6.10.0（12500）、Controller 协议 < 22）时
  // 拒绝，而不是提示后照样提议——这样的记录在服务端永远不会生效（版本读不到即待验证，不再匹配记录的 null 或 any）。
  const versionErrors = versionContextErrors(key, current);
  if (versionErrors.length > 0) {
    const over = serviceLimitsExceeded(instance);
    const why = !instance.result.ok
      ? `运行中的 Surge 无法确认：${RUNNING_INSTANCE_FAILURE_TEXT[instance.result.reason]}。`
      : over.length > 0
        ? `读到了运行中 Surge 的版本，但服务在它的时限内读不到：${serviceLimitText(over)}。`
        : versionCheck !== null && !versionCheck.ok
          ? `版本交叉核对未通过：${SURGE_VERSION_CHECK_FAILURE_TEXT[versionCheck.reason]}。`
          : '';
    throw refused(
      `生成提议失败：${versionErrors.map((e) => e.message).join('；')}。${why}依赖 Surge 版本的能力要在运行中 Surge 的版本与构建号可读、且与 surge-cli --raw version 一致（getVersion 映射为 cli）后才能提议（运行 instance 与 inventory 查看逐条检查）`,
    );
  }
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
    history: readResultHistory(dir, key),
    note: ctx.args.strings.note ?? null,
    home,
    exists: (p) => existsSync(p),
  });
  if (req.context.autoReload === null && deps.includes('autoReload')) out.warn('自动重载设置读不到：服务运行时同样读不到，只有记录为 any 的能力才会匹配');
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
