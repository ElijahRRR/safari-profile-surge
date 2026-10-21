// 导入（docs/ARCHITECTURE.md §6.1、contract ImportRecord 注释）：预览把每行与数据库比对为 create/update/
// unchanged/conflict/invalid（同名从不按名称更新）；preview_digest 是对解析结果与选项的带密钥摘要。提交时重新解析，
// 摘要不一致整体拒绝（PREVIEW_STALE）；逐行按决定执行，单行版本冲突不影响其他行；一个批次操作 + 每行操作，
// 需要发布的行合并为一次发布。导入从不清除秘密；差异只显示“已修改/未修改”，登录账号打码。

import {
  SfeError,
  type ImportCommitRequest,
  type ImportCommitResult,
  type ImportPreview,
  type ImportPreviewRequest,
  type ImportRowPreview,
  type ImportRowStatus,
  type SecretChange,
  type SiteCode,
} from '@sfe/contract';
import type { Actor } from '../app.js';
import type { EnvironmentRecord, OperationRecord } from '../db/index.js';
import { environmentDiff, sameEnvironmentState, type DiffEntry, type EnvironmentDiffState } from '../domain/diff.js';
import { allocateEnvironmentNaming, labelOf, revisionNodeName } from '../domain/naming.js';
import { nodeLineChanged } from '../domain/node-line.js';
import { displayNameKey, parseImport, type ParsedImportRow } from '../importer/index.js';
import { fingerprint } from '../secrets/pepper.js';
import { keyedRequestDigest } from '../util/keyed-digest.js';
import { diffStateOf, insertOperation, type AcceptDeps } from './accept.js';
import type { Engine } from './context.js';
import { acceptedOf, findDuplicateOperation, requestDigest, requireRequestId } from './ledger.js';

interface RowPlan {
  parsed: ParsedImportRow;
  status: ImportRowStatus;
  env: EnvironmentRecord | null;
  frontId: string | null;
  before: EnvironmentDiffState | null;
  after: EnvironmentDiffState | null;
  errors: Array<{ field: string; message: string }>;
  candidates: Array<{ environment_id: string; label: string; revision: number }>;
}

function frontByRef(engine: Engine, ref: string): string | null {
  const byId = engine.repos.frontProxies.get(ref);
  if (byId && !byId.retired) return byId.id;
  const byName = engine.repos.frontProxies.byName(ref);
  if (byName && !byName.retired) return byName.id;
  return null;
}

function replaceOf(c: SecretChange | undefined): string | null {
  return c && c.action === 'replace' ? c.value : null;
}

/** 行的目标状态：更新时留空的字段保留现值；新建时用默认值。 */
function targetState(engine: Engine, pepper: Buffer, row: ParsedImportRow, env: EnvironmentRecord | null, frontId: string | null): EnvironmentDiffState {
  const n = row.normalized;
  const blank = new Set(n.blankFields);
  const input = n.input;
  const fp = (v: string) => fingerprint(pepper, v);
  const cur = env ? diffStateOf(engine, env) : null;
  const frontName = frontId ? (engine.repos.frontProxies.get(frontId)?.surgeName ?? null) : (cur?.frontProxyName ?? null);
  const u = replaceOf(input.proxy.username);
  const p = replaceOf(input.proxy.password);
  const ap = replaceOf(input.account?.password);
  return {
    displayName: input.displayName,
    site: cur && blank.has('site') ? cur.site : input.site,
    autoOpenOrders: cur && blank.has('auto_open_orders') ? cur.autoOpenOrders : (input.autoOpenOrders ?? true),
    autoFillLogin: cur && blank.has('auto_fill_login') ? cur.autoFillLogin : (input.autoFillLogin ?? false),
    protocol: 'socks5',
    host: input.proxy.host,
    port: input.proxy.port,
    usernameFp: u !== null ? fp(u) : (cur?.usernameFp ?? null),
    passwordFp: p !== null ? fp(p) : (cur?.passwordFp ?? null),
    frontProxyName: frontName,
    expectedExitIp: cur && blank.has('expected_exit_ip') ? cur.expectedExitIp : (input.proxy.expectedExitIp ?? null),
    accountLabel: cur && blank.has('account_label') ? cur.accountLabel : (input.account?.label ?? null),
    loginIdentifier: cur && blank.has('login_identifier') ? cur.loginIdentifier : (input.account?.loginIdentifier ?? null),
    accountPasswordFp: ap !== null ? fp(ap) : (cur?.accountPasswordFp ?? null),
  };
}

function planRows(engine: Engine, pepper: Buffer, rows: readonly ParsedImportRow[], defaultFront: string | null): RowPlan[] {
  const { repos } = engine;
  const existing = repos.environments.list();
  return rows.map((row): RowPlan => {
    const n = row.normalized;
    const errors = [...n.errors];
    const plan: RowPlan = { parsed: row, status: 'invalid', env: null, frontId: null, before: null, after: null, errors, candidates: [] };
    let frontId: string | null = null;
    if (n.frontProxyRef !== null) {
      frontId = frontByRef(engine, n.frontProxyRef);
      if (frontId === null) errors.push({ field: `rows[${row.row}].front_proxy`, message: '前置代理未登记或已停用：导入不会隐式登记前置' });
    }
    if (n.environmentId !== null) {
      const env = repos.environments.get(n.environmentId);
      if (!env || env.deletedAt) errors.push({ field: `rows[${row.row}].environment_id`, message: '环境编号不存在或已删除' });
      else plan.env = env;
    } else if (frontId === null && n.frontProxyRef === null) {
      frontId = defaultFront;
      if (frontId === null && errors.length === 0) errors.push({ field: `rows[${row.row}].front_proxy`, message: '没有可用的前置代理：请在文件中填写，或先设置默认前置' });
    }
    if (errors.length > 0) return plan;
    plan.frontId = frontId;
    if (plan.env) {
      plan.before = diffStateOf(engine, plan.env);
      plan.after = targetState(engine, pepper, row, plan.env, frontId);
      plan.status = sameEnvironmentState(plan.before, plan.after) ? 'unchanged' : 'update';
      return plan;
    }
    const key = displayNameKey(n.input.displayName);
    const same = existing.filter((e) => displayNameKey(e.displayName) === key);
    plan.after = targetState(engine, pepper, row, null, frontId);
    if (row.duplicateNameInFile || same.length > 0) {
      plan.status = 'conflict';
      plan.candidates = same.map((e) => ({ environment_id: e.id, label: labelOf(e), revision: e.revision }));
      return plan;
    }
    plan.status = 'create';
    return plan;
  });
}

function rowPreview(plan: RowPlan): ImportRowPreview {
  const diff: DiffEntry[] = plan.after ? environmentDiff(plan.before, plan.after) : [];
  return {
    row: plan.parsed.row,
    status: plan.status,
    environment_id: plan.env?.id ?? null,
    current_revision: plan.env?.revision ?? null,
    displayName: plan.parsed.normalized.input.displayName || null,
    diff,
    errors: plan.errors,
    conflictCandidates: plan.candidates,
  };
}

function defaultFrontFor(engine: Engine, requested: string | null | undefined): string | null {
  if (requested !== undefined && requested !== null) {
    const f = engine.repos.frontProxies.get(requested);
    if (!f || f.retired) throw new SfeError('VALIDATION_FAILED', '导入失败：默认前置未登记或已停用', { fieldErrors: [{ field: 'default_front_proxy_id', message: '前置代理未登记或已停用' }] });
    return f.id;
  }
  return engine.repos.settings.defaultFrontProxyId();
}

function previewDigest(previewKey: Buffer, req: ImportPreviewRequest, rows: readonly ParsedImportRow[], fileErrors: unknown): string {
  // 对解析结果与选项做带密钥摘要：秘密值在规范化前已替换为 HMAC，不含当前数据库版本（版本冲突逐行报告）
  return keyedRequestDigest(previewKey, {
    format: req.format,
    default_front_proxy_id: req.default_front_proxy_id ?? null,
    default_site: req.default_site ?? null,
    fileErrors,
    rows: rows.map((r) => ({
      row: r.row,
      environmentId: r.normalized.environmentId,
      frontProxyRef: r.normalized.frontProxyRef,
      input: r.normalized.input,
      blankFields: [...r.normalized.blankFields].sort(),
      errors: r.normalized.errors,
      duplicateNameInFile: r.duplicateNameInFile,
    })),
  });
}

function registerRowSecrets(engine: Engine, rows: readonly ParsedImportRow[]): void {
  for (const r of rows) {
    const input = r.normalized.input;
    for (const c of [input.proxy.username, input.proxy.password, input.account?.password]) {
      const v = replaceOf(c);
      if (v !== null) engine.scrubber.register(v);
    }
  }
}

function parse(engine: Engine, req: ImportPreviewRequest) {
  if (typeof req !== 'object' || req === null) throw new SfeError('BAD_REQUEST', '导入失败：请求格式不正确');
  const parsed = parseImport({ format: req.format, content_base64: req.content_base64, records: req.records, default_site: (req.default_site ?? null) as SiteCode | null });
  registerRowSecrets(engine, parsed.rows);
  return parsed;
}

export async function importPreview(deps: AcceptDeps, req: ImportPreviewRequest, _actor: Actor): Promise<ImportPreview> {
  const { engine } = deps;
  const parsed = parse(engine, req);
  const keys = await engine.keys();
  const defaultFront = defaultFrontFor(engine, req.default_front_proxy_id);
  const plans = parsed.fileErrors.length > 0 ? [] : planRows(engine, keys.pepper, parsed.rows, defaultFront);
  const rows = plans.map(rowPreview);
  const totals: Record<ImportRowStatus, number> = { create: 0, update: 0, unchanged: 0, conflict: 0, invalid: 0 };
  for (const r of rows) totals[r.status]++;
  return {
    preview_digest: previewDigest(keys.preview, req, parsed.rows, parsed.fileErrors),
    rows,
    totals,
    fileErrors: parsed.fileErrors,
  };
}

interface RowSecrets {
  username?: { ref: string; fp: string };
  password?: { ref: string; fp: string };
  account?: { ref: string; fp: string };
}

export async function importCommit(deps: AcceptDeps, req: ImportCommitRequest, actor: Actor): Promise<ImportCommitResult> {
  const { engine } = deps;
  const { repos } = engine;
  const requestId = requireRequestId(req?.request_id);
  const parsed = parse(engine, req);
  const digest = await requestDigest(engine, 'importCommit', null, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) {
    const stored = (dup.result as { commit?: ImportCommitResult } | null)?.commit;
    if (stored) return stored;
    return { batch_id: dup.id, operation_id: dup.id, items: [] };
  }
  const keys = await engine.keys();
  if (typeof req.preview_digest !== 'string' || previewDigest(keys.preview, req, parsed.rows, parsed.fileErrors) !== req.preview_digest) {
    throw new SfeError('PREVIEW_STALE', '导入失败：文件或选项与预览不一致，请重新预览');
  }
  if (parsed.fileErrors.length > 0) throw new SfeError('IMPORT_REJECTED', '导入失败：文件有错误，不能提交', { fieldErrors: parsed.fileErrors });
  const defaultFront = defaultFrontFor(engine, req.default_front_proxy_id);
  const plans = planRows(engine, keys.pepper, parsed.rows, defaultFront);
  const byRow = new Map(plans.map((p) => [p.parsed.row, p]));

  // 决定校验（同步拒绝，不创建操作）
  if (!Array.isArray(req.decisions)) throw new SfeError('VALIDATION_FAILED', '导入失败：缺少逐行决定', { fieldErrors: [{ field: 'decisions', message: '必须是列表' }] });
  const decisions = new Map<number, ImportCommitRequest['decisions'][number]>();
  const fieldErrors: Array<{ field: string; message: string }> = [];
  for (const d of req.decisions) {
    const plan = d && typeof d.row === 'number' ? byRow.get(d.row) : undefined;
    if (!plan) {
      fieldErrors.push({ field: 'decisions', message: `第 ${String(d?.row)} 行不在导入文件中` });
      continue;
    }
    if (decisions.has(d.row)) fieldErrors.push({ field: `decisions[${d.row}]`, message: '同一行有多个决定' });
    if (d.action === 'create' && plan.status !== 'create' && plan.status !== 'conflict') fieldErrors.push({ field: `decisions[${d.row}]`, message: '该行不能新建' });
    if (d.action === 'update') {
      const allowed = plan.status === 'update' || plan.status === 'unchanged' ? plan.env?.id === d.environment_id : plan.status === 'conflict' && plan.candidates.some((c) => c.environment_id === d.environment_id);
      if (!allowed || typeof d.expected_revision !== 'number') fieldErrors.push({ field: `decisions[${d.row}]`, message: '该行不能更新这个环境，或缺少 expected_revision' });
    }
    const action: unknown = d.action;
    if (action !== 'create' && action !== 'update' && action !== 'skip') fieldErrors.push({ field: `decisions[${plan.parsed.row}]`, message: '决定只能是 create、update 或 skip' });
    decisions.set(d.row, d);
  }
  if (fieldErrors.length > 0) throw new SfeError('VALIDATION_FAILED', '导入失败：逐行决定不正确', { fieldErrors });

  // 写钥匙串（主事务之外）
  const batchId = engine.ids.next('batch');
  const secrets = new Map<number, RowSecrets>();
  const created: string[] = [];
  const fp = (v: string) => fingerprint(keys.pepper, v);
  try {
    for (const plan of plans) {
      const d = decisions.get(plan.parsed.row);
      if (!d || d.action === 'skip' || plan.status === 'invalid') continue;
      const target = d.action === 'update' ? repos.environments.get(d.environment_id) : null;
      const cur = target ? diffStateOf(engine, target) : null;
      const input = plan.parsed.normalized.input;
      const rs: RowSecrets = {};
      const make = async (value: string | null, kind: 'proxy' | 'account', curFp: string | null | undefined): Promise<{ ref: string; fp: string } | undefined> => {
        if (value === null || fp(value) === (curFp ?? null)) return undefined;
        const ref = await engine.secrets.createSecret(value, kind, { kind: 'import', id: batchId });
        created.push(ref);
        return { ref, fp: fp(value) };
      };
      rs.username = await make(replaceOf(input.proxy.username), 'proxy', cur?.usernameFp);
      rs.password = await make(replaceOf(input.proxy.password), 'proxy', cur?.passwordFp);
      rs.account = await make(replaceOf(input.account?.password), 'account', cur?.accountPasswordFp);
      secrets.set(plan.parsed.row, rs);
    }
  } catch (err) {
    for (const ref of created) await engine.secrets.discard(ref).catch(() => false);
    throw err;
  }

  const items: ImportCommitResult['items'] = [];
  const childIds: string[] = [];
  const touchedEnvs = new Set<string>();
  let batchOp: OperationRecord;
  try {
    batchOp = repos.tx(() => {
      const batch = insertOperation(engine, {
        kind: 'import.batch',
        requestId,
        digest,
        actor,
        payload: { batchId },
        enqueue: false,
        step: `已受理导入批次（${plans.length} 行）`,
      });
      for (const plan of plans) {
        const row = plan.parsed.row;
        const d = decisions.get(row);
        if (plan.status === 'invalid') {
          items.push({ row, environment_id: plan.env?.id ?? null, status: 'invalid', operation_id: null, error: { code: 'VALIDATION_FAILED', message: '该行数据无效', fieldErrors: plan.errors } });
          continue;
        }
        if (!d || d.action === 'skip') {
          items.push({ row, environment_id: plan.env?.id ?? null, status: 'skipped', operation_id: null });
          continue;
        }
        const rs = secrets.get(row) ?? {};
        const childRequestId = `${requestId}#${row}`;
        if (d.action === 'create') {
          const res = createFromRow(engine, plan, rs, { requestId: childRequestId, digest, actor, parent: batch.id });
          items.push({ row, environment_id: res.envId, status: 'create', operation_id: res.opId });
          childIds.push(res.opId);
          touchedEnvs.add(res.envId);
          continue;
        }
        const env = repos.environments.get(d.environment_id);
        if (!env || env.deletedAt) {
          items.push({ row, environment_id: d.environment_id, status: 'invalid', operation_id: null, error: { code: 'NOT_FOUND', message: '环境不存在或已删除' } });
          continue;
        }
        const after = targetState(engine, keys.pepper, plan.parsed, env, plan.frontId);
        if (env.revision !== d.expected_revision) {
          items.push({
            row,
            environment_id: env.id,
            status: 'revision_conflict',
            operation_id: null,
            error: { code: 'REVISION_CONFLICT', message: '该环境已被其他界面修改，请重新预览' },
            diff: environmentDiff(diffStateOf(engine, env), after),
          });
          continue;
        }
        if (sameEnvironmentState(diffStateOf(engine, env), after)) {
          items.push({ row, environment_id: env.id, status: 'unchanged', operation_id: null });
          continue;
        }
        const res = updateFromRow(engine, env, plan, after, rs, { requestId: childRequestId, digest, actor, parent: batch.id, expected: d.expected_revision });
        items.push({ row, environment_id: env.id, status: 'update', operation_id: res.opId });
        if (res.queued) childIds.push(res.opId);
        touchedEnvs.add(env.id);
      }
      const result = { batchId, commit: { batch_id: batchId, operation_id: batch.id, items } };
      if (childIds.length > 0) {
        repos.operations.update(batch.id, { payload: { batchId, children: childIds }, result });
        repos.outbox.enqueue(batch.id, null, engine.now());
        repos.operations.appendStep(batch.id, 'SAVED', `${childIds.length} 行需要同步到 Surge，将合并为一次发布`);
      } else {
        repos.operations.update(batch.id, { phase: 'COMPLETED', status: 'succeeded', result });
        repos.operations.appendStep(batch.id, 'COMPLETED', '导入完成：没有需要同步到 Surge 的修改');
      }
      return repos.operations.get(batch.id)!;
    });
  } catch (err) {
    for (const ref of created) await engine.secrets.discard(ref).catch(() => false);
    throw err;
  }
  // 未被使用的钥匙串项（版本冲突的行）
  for (const ref of created) {
    if (!repos.secretRefs.isReferenced(ref)) await engine.secrets.discard(ref).catch(() => false);
  }
  if (childIds.length > 0) deps.kick();
  engine.emit({ operations: [batchOp.id, ...items.map((i) => i.operation_id).filter((x): x is string => x !== null)], environments: touchedEnvs });
  void acceptedOf;
  return { batch_id: batchId, operation_id: batchOp.id, items };
}

interface ChildContext {
  requestId: string;
  digest: string;
  actor: Actor;
  parent: string;
}

function createFromRow(engine: Engine, plan: RowPlan, rs: RowSecrets, ctx: ChildContext): { envId: string; opId: string } {
  const { repos } = engine;
  const input = plan.parsed.normalized.input;
  const naming = allocateEnvironmentNaming(repos.meta, input.site);
  const id = engine.ids.next('env');
  const env = repos.environments.insert({
    id,
    seq: naming.seq,
    code: naming.code,
    nodeTag: naming.nodeTag,
    displayName: input.displayName,
    site: input.site,
    autoOpenOrders: input.autoOpenOrders ?? true,
    autoFillLogin: input.autoFillLogin ?? false,
    revision: 1,
    desiredProxyRevision: 1,
    deployedProxyRevision: null,
    lastVerifiedProxyRevision: null,
    expectedExitIp: input.proxy.expectedExitIp ?? null,
    bindingStage: 'awaiting_profile',
  });
  repos.proxyRevisions.insert({
    environmentId: id,
    revision: 1,
    protocol: 'socks5',
    host: input.proxy.host,
    port: input.proxy.port,
    usernameRef: rs.username?.ref ?? null,
    usernameFp: rs.username?.fp ?? null,
    passwordRef: rs.password?.ref ?? null,
    passwordFp: rs.password?.fp ?? null,
    frontProxyId: plan.frontId!,
    nodeName: revisionNodeName(env, 1),
    state: 'desired',
  });
  const acc = input.account;
  if (acc && (acc.label || acc.loginIdentifier || rs.account)) {
    repos.accounts.insert({ environmentId: id, label: acc.label ?? null, loginIdentifier: acc.loginIdentifier ?? null, passwordRef: rs.account?.ref ?? null, passwordFp: rs.account?.fp ?? null });
  }
  for (const s of [rs.username, rs.password, rs.account]) if (s) engine.secrets.markCommitted(s.ref);
  const op = insertOperation(engine, {
    kind: 'environment.create',
    requestId: ctx.requestId,
    digest: ctx.digest,
    actor: ctx.actor,
    environmentId: id,
    resultRevision: 1,
    payload: { targets: [{ environmentId: id, proxyRevision: 1 }], parentOperationId: ctx.parent },
    enqueue: false,
    step: '导入：已保存新环境，等待批次发布',
  });
  return { envId: id, opId: op.id };
}

function updateFromRow(
  engine: Engine,
  env: EnvironmentRecord,
  plan: RowPlan,
  after: EnvironmentDiffState,
  rs: RowSecrets,
  ctx: ChildContext & { expected: number },
): { opId: string; queued: boolean } {
  const { repos } = engine;
  const curRev = env.desiredProxyRevision !== null ? repos.proxyRevisions.get(env.id, env.desiredProxyRevision) : null;
  const frontId = plan.frontId ?? curRev?.frontProxyId ?? null;
  const next = {
    protocol: 'socks5' as const,
    host: after.host,
    port: after.port,
    usernameFp: after.usernameFp,
    passwordFp: after.passwordFp,
    frontProxyId: frontId ?? '',
  };
  const changed = curRev ? nodeLineChanged({ protocol: curRev.protocol, host: curRev.host, port: curRev.port, usernameFp: curRev.usernameFp, passwordFp: curRev.passwordFp, frontProxyId: curRev.frontProxyId }, next) : true;
  const newRevision = env.revision + 1;
  const patch: Partial<EnvironmentRecord> = {
    revision: newRevision,
    displayName: after.displayName,
    site: after.site as SiteCode,
    autoOpenOrders: after.autoOpenOrders,
    autoFillLogin: after.autoFillLogin,
    expectedExitIp: after.expectedExitIp,
  };
  // 账号
  const acc = repos.accounts.get(env.id);
  const identityChanged = (acc?.loginIdentifier ?? null) !== after.loginIdentifier || rs.account !== undefined;
  if (acc) {
    const accPatch: Record<string, unknown> = { label: after.accountLabel, loginIdentifier: after.loginIdentifier };
    if (rs.account) {
      if (acc.passwordRef) engine.secrets.orphan(acc.passwordRef);
      accPatch.passwordRef = rs.account.ref;
      accPatch.passwordFp = rs.account.fp;
    }
    if (identityChanged) accPatch.changedSincePageCheck = true;
    repos.accounts.update(env.id, accPatch);
  } else if (after.accountLabel || after.loginIdentifier || rs.account) {
    repos.accounts.insert({ environmentId: env.id, label: after.accountLabel, loginIdentifier: after.loginIdentifier, passwordRef: rs.account?.ref ?? null, passwordFp: rs.account?.fp ?? null, changedSincePageCheck: identityChanged });
  }
  if (rs.account) engine.secrets.markCommitted(rs.account.ref);
  let queued = false;
  let newProxyRevision: number | null = null;
  if (changed && frontId) {
    newProxyRevision = repos.proxyRevisions.maxRevision(env.id) + 1;
    repos.proxyRevisions.insert({
      environmentId: env.id,
      revision: newProxyRevision,
      protocol: 'socks5',
      host: after.host,
      port: after.port,
      usernameRef: rs.username ? rs.username.ref : (curRev?.usernameRef ?? null),
      usernameFp: after.usernameFp,
      passwordRef: rs.password ? rs.password.ref : (curRev?.passwordRef ?? null),
      passwordFp: after.passwordFp,
      frontProxyId: frontId,
      nodeName: revisionNodeName(env, newProxyRevision),
      state: 'desired',
    });
    for (const s of [rs.username, rs.password]) if (s) engine.secrets.markCommitted(s.ref);
    if (curRev && curRev.state === 'desired' && curRev.revision !== env.deployedProxyRevision && curRev.revision !== env.lastVerifiedProxyRevision) {
      repos.proxyRevisions.updateState(env.id, curRev.revision, 'superseded');
    }
    patch.desiredProxyRevision = newProxyRevision;
    queued = true;
  }
  repos.environments.update(env.id, patch);
  const op = insertOperation(engine, {
    kind: 'environment.update',
    requestId: ctx.requestId,
    digest: ctx.digest,
    actor: ctx.actor,
    environmentId: env.id,
    expectedRevision: ctx.expected,
    resultRevision: newRevision,
    payload: queued ? { targets: [{ environmentId: env.id, proxyRevision: newProxyRevision! }], parentOperationId: ctx.parent } : { parentOperationId: ctx.parent },
    phase: queued ? 'SAVED' : 'COMPLETED',
    status: queued ? 'queued' : 'succeeded',
    enqueue: false,
    step: queued ? '导入：已保存代理新版本，等待批次发布' : '导入：已保存（不涉及 Surge 节点）',
  });
  return { opId: op.id, queued };
}
