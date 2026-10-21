// 维护：初始化固定工作配置与重新合并受管理段（docs/ARCHITECTURE.md §5.3）。预览只读；提交重新计算摘要，
// 不一致返回 PREVIEW_STALE。初始化只写入新文件（目标必须不存在），由用户在 Surge 中手动切换一次；
// 重新合并受维护写门槛约束、入口必须是 NORMAL，只写受管理段，按 P0 结论生效（自动重载或经确认的同一配置重载），
// 只有维护处理器能拿到 MaintenanceSurge。恢复本应用节点资源走发布路径（受发布门槛约束）。

import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CAPABILITY_GATES,
  CAPABILITY_MEASURED_GATES,
  ENTRY_RULESET_FILES,
  NODE_RESOURCE_FILE,
  ROUTE_GROUP_NAME,
  SfeError,
  WORKING_PROFILE_NAME,
  type Accepted,
  type InitCommitRequest,
  type InitPreviewRequest,
  type InitPreviewResponse,
  type RemergeCommitRequest,
  type RemergePreviewResponse,
} from '@sfe/contract';
import type { Actor } from '../app.js';
import type { OperationRecord } from '../db/index.js';
import { ENTRY_BITS_IN_ORDER, entryRuleSetBlockLines, entryRuleSetFileContent, groupBlockLines, resourceFile } from '../surge/generate.js';
import { parseHttpApiLine } from '../surge/http-adapter.js';
import {
  detectManagedConfigHeader,
  dominantEol,
  findForeignSfeObjects,
  findManagedBlock,
  findSections,
  insertInitialBlocks,
  listRelativeReferences,
  listRemoteSourceHosts,
  parseProfile,
  replaceManagedBlock,
  serializeProfile,
  stripManagedConfigHeader,
  unifiedDiff,
} from '../surge/profile.js';
import { redactProfileText, redactProxyLine } from '../surge/redact-profile.js';
import { classifyDirectoryRisk, createExclusivePrivateFile, ensurePrivateDir, isInsideGitWorkTree } from '../util/secure-files.js';
import { hmacHex, keyedRequestDigest } from '../util/keyed-digest.js';
import { insertOperation, type AcceptDeps } from './accept.js';
import { checkCandidate } from './candidate.js';
import type { Engine } from './context.js';
import { acceptedOf, findDuplicateOperation, requestDigest, requireRequestId } from './ledger.js';
import { registerInitialObjects, segmentDigest, SEGMENT_KIND, type SegmentName } from './ownership.js';
import { generateResource, type ResourceEntry } from './resource.js';
import { unmeasuredFrom } from './capabilities.js';

const MAX_REMERGE_BACKUPS = 5;
const REMOTE_NOTICE = '源配置的远端更新不再自动应用到工作配置；之后需要通过“重新合并”手动接入';

function requireWebOrAdmin(actor: Actor, action: string): void {
  if (actor.kind !== 'web' && actor.kind !== 'admin') throw new SfeError('BAD_REQUEST', `${action}失败：该通道无权执行此操作`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function fileDigest(engine: Engine, content: string): string {
  return hmacHex(engine.keysLoaded()!.file, `sfe-file\0${content}`);
}

// ---------- 初始化 ----------

interface InitPlan {
  response: InitPreviewResponse;
  sourceText: string;
  candidateText: string;
  overrides: Map<string, string>;
  targetPath: string;
  directory: string;
  blocking: { code: 'UNSAFE_LOCATION' | 'NAME_COLLISION' | 'SURGE_CHECK_FAILED' | 'VALIDATION_FAILED'; message: string } | null;
}

function entryFiles(engine: Engine): Map<string, string> | null {
  const strategy = engine.repos.settings.get('entryStrategy');
  const cfg = engine.entryConfig();
  if (strategy !== 'ruleset_resource' || cfg.processPaths.length === 0) return null;
  const out = new Map<string, string>();
  for (const bit of ENTRY_BITS_IN_ORDER) out.set(ENTRY_RULESET_FILES[bit], entryRuleSetFileContent(bit, false, cfg));
  return out;
}

async function buildInitPlan(engine: Engine, req: InitPreviewRequest): Promise<InitPlan> {
  const keys = await engine.keys();
  await engine.readBasicFacts();
  if (!engine.facts.reachable) throw new SfeError('SURGE_UNREACHABLE', '初始化失败：无法连接 Surge');
  const profile = await engine.surge.getCurrentProfile();
  if (!profile.path) throw new SfeError('VALIDATION_FAILED', '初始化失败：无法取得 Surge 当前配置的文件路径');
  const sourcePath = resolve(profile.path);
  const directory = dirname(sourcePath);
  if (req?.targetDirectory && resolve(req.targetDirectory) !== directory) {
    throw new SfeError('VALIDATION_FAILED', '初始化失败：工作配置必须与源配置位于同一目录', { fieldErrors: [{ field: 'targetDirectory', message: '必须是当前配置所在目录' }] });
  }
  let sourceText: string;
  try {
    sourceText = await readFile(sourcePath, 'utf8');
  } catch {
    throw new SfeError('UNSAFE_LOCATION', '初始化失败：无法读取当前配置文件');
  }
  const targetPath = join(directory, `${WORKING_PROFILE_NAME}.conf`);
  const risk = classifyDirectoryRisk(directory, engine.deps.paths.homedir);
  const inGit = isInsideGitWorkTree(directory);
  const header = detectManagedConfigHeader(sourceText);
  const remote = listRemoteSourceHosts(sourceText);
  const refs = listRelativeReferences(sourceText);
  const referencedFiles: InitPreviewResponse['referencedFiles'] = [];
  for (const r of refs) referencedFiles.push({ relativePath: r.value, present: await exists(resolve(directory, r.value)) });

  // 名称与文件冲突
  const collisions = new Set<string>();
  for (const o of findForeignSfeObjects(sourceText, { names: [], files: [] })) collisions.add(`${o.name}（第 ${o.line} 行）`);
  try {
    const policies = await engine.surge.listPolicies();
    for (const n of [...policies.proxies, ...policies.groups]) if (/^SFE-/i.test(n)) collisions.add(n);
  } catch {
    // 读不到策略列表时只按配置文本判断
  }
  try {
    for (const name of await readdir(directory)) if (/^sfe-/i.test(name)) collisions.add(name);
  } catch {
    // 目录不可读在下方检查中报告
  }
  if (await exists(targetPath)) collisions.add(basename(targetPath));
  try {
    for (const r of await engine.surge.listExternalResources()) {
      if (/(^|\/)sfe-[^/]*$/i.test(r.location)) collisions.add(`外部资源 ${basename(r.location)}`);
    }
  } catch {
    // 忽略
  }

  const strategy = engine.repos.settings.get('entryStrategy');
  const entry = strategy === 'ruleset_resource' && engine.entryConfig().processPaths.length > 0 ? entryRuleSetBlockLines() : null;
  let candidateText = sourceText;
  let insertError: string | null = null;
  try {
    candidateText = insertInitialBlocks(header ? stripManagedConfigHeader(sourceText) : sourceText, { group: groupBlockLines(), entry, general: null });
  } catch (err) {
    insertError = err instanceof SfeError ? err.message : '初始化失败：无法插入受管理段';
  }
  const overrides = new Map<string, string>([[NODE_RESOURCE_FILE, resourceFile(0, [])]]);
  for (const [k, v] of entryFiles(engine) ?? new Map<string, string>()) overrides.set(k, v);

  const checks: InitPreviewResponse['checks'] = [];
  checks.push({ name: 'directory', ok: risk === 'none', message: risk === 'none' ? '配置目录不在同步或受保护位置' : risk === 'synced' ? '配置目录位于 iCloud 或云盘同步位置：默认拒绝' : '配置目录位于文稿、桌面或下载等受保护位置：默认拒绝' });
  checks.push({ name: 'git', ok: !inGit, message: inGit ? '配置目录位于 Git 工作树内：请确认不会提交含凭据的文件' : '配置目录不在 Git 工作树内' });
  checks.push({ name: 'access', ok: true, message: '服务以当前运行方式可以读取该目录；LaunchAgent 下是否出现 TCC 提示需在测试 Mac 上确认' });
  checks.push({ name: 'collisions', ok: collisions.size === 0 && insertError === null, message: insertError ?? (collisions.size === 0 ? '没有名称或文件冲突' : '存在非本应用的 SFE- 名称或 sfe-* 文件') });
  if (strategy === 'ruleset_resource' && entry === null) checks.push({ name: 'entry', ok: true, message: 'Safari 进程路径尚未确认：入口规则集将在之后的重新合并中写入' });

  let checkOk = false;
  let checkMessage = '未执行';
  if (insertError === null) {
    try {
      const r = await checkCandidate(engine, { profileText: candidateText, profileFileName: basename(targetPath), sourceDirectory: directory, overrides });
      checkOk = r.ok;
      checkMessage = r.ok ? '候选配置校验通过' : `候选配置校验失败：${r.message}`;
    } catch (err) {
      checkMessage = engine.errorBody(err, '候选配置校验失败').message;
    }
  }
  checks.push({ name: 'check', ok: checkOk, message: checkMessage });

  const api = parseHttpApiLine(sourceText);
  const refDigests: Array<{ path: string; digest: string | null }> = [];
  for (const r of refs) {
    try {
      refDigests.push({ path: r.value, digest: fileDigest(engine, await readFile(resolve(directory, r.value), 'utf8')) });
    } catch {
      refDigests.push({ path: r.value, digest: null });
    }
  }
  const digest = keyedRequestDigest(keys.preview, {
    kind: 'maintenance.init',
    source: fileDigest(engine, sourceText),
    sourcePath,
    targetPath,
    refs: refDigests,
    candidate: fileDigest(engine, candidateText),
  });
  const blocking: InitPlan['blocking'] =
    risk !== 'none'
      ? { code: 'UNSAFE_LOCATION', message: '初始化失败：配置目录位于同步或受保护位置' }
      : insertError !== null || collisions.size > 0
        ? { code: 'NAME_COLLISION', message: insertError ?? '初始化失败：存在非本应用的 SFE- 名称或 sfe-* 文件' }
        : !checkOk
          ? { code: 'SURGE_CHECK_FAILED', message: checkMessage }
          : null;
  const response: InitPreviewResponse = {
    preview_digest: digest,
    sourceProfileName: profile.name,
    sourceProfilePath: sourcePath,
    workingProfilePath: targetPath,
    backupDirectory: join(engine.deps.paths.backupsDir, 'init'),
    managedDiff: unifiedDiff(redactProfileText(sourceText), redactProfileText(candidateText), 1, ['当前配置', '工作配置']),
    referencedFiles,
    managedConfigDetected: header !== null,
    profileDirectoryRisk: risk,
    autoReloadEnabled: engine.facts.autoReload,
    takeover: { ...engine.facts.takeover },
    httpApi: api ? { configured: true, loopbackOnly: api.loopbackOnly } : { configured: false, loopbackOnly: null },
    remoteSources: remote,
    remoteUpdatesNotice: remote.length > 0 || header !== null ? REMOTE_NOTICE : null,
    checks,
    nameCollisions: [...collisions],
  };
  return { response, sourceText, candidateText, overrides, targetPath, directory, blocking };
}

export async function initPreview(deps: AcceptDeps, req: InitPreviewRequest, actor: Actor): Promise<InitPreviewResponse> {
  requireWebOrAdmin(actor, '初始化');
  if (deps.engine.workingProfile()) throw new SfeError('NAME_COLLISION', '初始化失败：已有固定工作配置；更换需要卸载并清空数据后重新初始化');
  return (await buildInitPlan(deps.engine, req ?? {})).response;
}

export async function initCommit(deps: AcceptDeps, req: InitCommitRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  requireWebOrAdmin(actor, '初始化');
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'initCommit', null, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  if (engine.workingProfile()) throw new SfeError('NAME_COLLISION', '初始化失败：已有固定工作配置');
  const plan = await buildInitPlan(engine, {});
  if (plan.response.preview_digest !== req.preview_digest) throw new SfeError('PREVIEW_STALE', '初始化失败：配置或引用文件已变化，请重新预览');
  if (plan.blocking) throw new SfeError(plan.blocking.code, plan.blocking.message);
  const op = engine.repos.tx(() =>
    insertOperation(engine, { kind: 'maintenance.init', requestId, digest, actor, payload: { previewDigest: req.preview_digest }, step: '已受理初始化固定工作配置' }),
  );
  deps.kick();
  engine.emit({ operations: [op.id] });
  return acceptedOf(op, false);
}

async function backup(engine: Engine, reason: 'init' | 'remerge', sourcePath: string, sourceText: string, directory: string): Promise<string> {
  const stamp = engine.nowIso().replace(/[:.]/g, '-');
  const dir = join(engine.deps.paths.backupsDir, `${reason}-${stamp}`);
  await ensurePrivateDir(engine.deps.paths.backupsDir);
  await ensurePrivateDir(dir);
  const files: Array<{ relativePath: string; digest: string }> = [];
  await createExclusivePrivateFile(join(dir, basename(sourcePath)), sourceText);
  files.push({ relativePath: basename(sourcePath), digest: fileDigest(engine, sourceText) });
  for (const r of listRelativeReferences(sourceText)) {
    const src = resolve(directory, r.value);
    if (!src.startsWith(`${directory}/`)) continue;
    let content: string;
    try {
      content = await readFile(src, 'utf8');
    } catch {
      continue;
    }
    const dest = join(dir, r.value);
    await ensurePrivateDir(dirname(dest));
    try {
      await createExclusivePrivateFile(dest, content);
      files.push({ relativePath: r.value, digest: fileDigest(engine, content) });
    } catch {
      // 同一文件被多次引用
    }
  }
  const t = engine.facts.takeover;
  engine.repos.backups.insert({
    id: engine.ids.next('bak'),
    reason,
    sourcePath,
    backupDirectory: dir,
    files,
    runtimeSwitches: { enhancedMode: t.enhancedMode, systemProxy: t.systemProxy, outboundMode: t.outboundMode, autoReload: engine.facts.autoReload, httpApiConfigured: engine.facts.httpApi.configured },
  });
  if (reason === 'remerge') {
    // 保留初始备份 + 最近 5 次维护备份
    const old = engine.repos.backups.list({ reason: 'remerge' }).slice(MAX_REMERGE_BACKUPS);
    for (const b of old) {
      await rm(b.backupDirectory, { recursive: true, force: true }).catch(() => undefined);
      engine.repos.backups.delete(b.id);
    }
  }
  return dir;
}

export async function runInit(engine: Engine, op: OperationRecord): Promise<void> {
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始初始化：重新核对预览');
  try {
    if (engine.workingProfile()) throw new SfeError('NAME_COLLISION', '初始化失败：已有固定工作配置');
    const plan = await buildInitPlan(engine, {});
    const expected = (op.payload as { previewDigest?: string }).previewDigest;
    if (plan.response.preview_digest !== expected) throw new SfeError('PREVIEW_STALE', '初始化失败：配置或引用文件已变化，请重新预览');
    if (plan.blocking) throw new SfeError(plan.blocking.code, plan.blocking.message);
    engine.updateOp(op.id, { phase: 'DEPLOYING' }, '备份当前配置与引用文件');
    const sourcePath = plan.response.sourceProfilePath;
    const dir = await backup(engine, 'init', sourcePath, plan.sourceText, plan.directory);
    engine.step(op.id, `已备份到 ${dir}`);
    // 只写新文件（目标必须不存在）
    await createExclusivePrivateFile(plan.targetPath, plan.candidateText);
    for (const [name, content] of plan.overrides) await createExclusivePrivateFile(join(plan.directory, name), content);
    engine.repos.tx(() => {
      engine.repos.settings.set('workingProfilePath', plan.targetPath);
      engine.repos.settings.set('workingProfileName', WORKING_PROFILE_NAME);
    });
    const files = engine.profileFiles()!;
    await registerInitialObjects(engine.repos, { profileText: plan.candidateText, digestContent: files.digestContent, fileDigest: (n) => files.digest(n), operationId: op.id });
    engine.updateOp(op.id, { phase: 'COMPLETED', status: 'succeeded' }, `已创建工作配置「${WORKING_PROFILE_NAME}」：请在 Surge 中手动切换到该配置一次（本应用从不切换配置）`, { settings: true, surge: true });
  } catch (err) {
    const body = engine.errorBody(err, '初始化失败：内部错误');
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
  }
}

// ---------- 重新合并 ----------

interface RemergePlan {
  response: RemergePreviewResponse;
  currentText: string;
  candidateText: string;
  profileFile: string;
  directory: string;
  restoreResource: string | null;
  restoreEntry: Map<string, string>;
  blocking: { code: 'CAPABILITY_UNVERIFIED' | 'ENVIRONMENT_ACTIVE' | 'BASELINE_CHANGED' | 'SURGE_CHECK_FAILED'; message: string } | null;
}

function insertMissingBlock(text: string, name: SegmentName, inner: readonly string[]): string {
  const parsed = parseProfile(text);
  const eol = dominantEol(parsed);
  const block = [{ text: `# SFE-BEGIN ${name} v1`, eol }, ...inner.map((t) => ({ text: t, eol })), { text: `# SFE-END ${name}`, eol }];
  const sectionName = name === 'group' ? 'Proxy Group' : name === 'entry' ? 'Rule' : 'General';
  const sec = findSections(parsed, sectionName)[0];
  if (!sec) throw new SfeError('BASELINE_CHANGED', `重新合并失败：配置缺少 [${sectionName}] 段`);
  let at: number;
  if (name === 'entry') at = sec.header! + 1;
  else {
    let last = sec.header!;
    for (let i = sec.start; i < sec.end; i++) if (parsed.lines[i]!.text.trim() !== '') last = i;
    at = last + 1;
  }
  const lines = [...parsed.lines.slice(0, at), ...block, ...parsed.lines.slice(at)];
  if (at > 0 && lines[at - 1]!.eol === '') lines[at - 1]!.eol = eol;
  return serializeProfile(lines);
}

async function lastPublishedResource(engine: Engine): Promise<string | null> {
  const d = engine.repos.deployments.latestWithState(['verified', 'published']);
  if (!d) return resourceFile(0, []);
  const entries: ResourceEntry[] = [];
  for (const m of d.nodeManifest) {
    const rev = engine.repos.proxyRevisions.get(m.environmentId, m.proxyRevision);
    if (!rev) return null;
    entries.push({ environmentId: m.environmentId, proxyRevision: m.proxyRevision, revision: rev });
  }
  const fronts = new Map(engine.repos.frontProxies.list().map((f) => [f.id, f]));
  const g = await generateResource(engine, d.generation, entries, fronts);
  return g.errors.size > 0 ? null : g.content;
}

const redactLines = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((l) => (l.startsWith('#') || l.trim() === '' ? l : redactProxyLine(l)))
    .join('\n');

async function buildRemergePlan(engine: Engine): Promise<RemergePlan> {
  const keys = await engine.keys();
  const wp = engine.workingProfile();
  if (!wp) throw new SfeError('RESOURCE_MISSING', '重新合并失败：尚未初始化固定工作配置');
  await engine.readBasicFacts();
  const files = engine.profileFiles()!;
  let currentText: string;
  try {
    currentText = await readFile(wp.path, 'utf8');
  } catch {
    throw new SfeError('EXTERNAL_PROFILE', '重新合并失败：无法读取工作配置');
  }
  let candidate = currentText;
  let blockError: string | null = null;
  const desired: Array<{ name: SegmentName; lines: string[] | null }> = [
    { name: 'group', lines: groupBlockLines() },
    { name: 'entry', lines: engine.repos.settings.get('entryStrategy') === 'ruleset_resource' && engine.entryConfig().processPaths.length > 0 ? entryRuleSetBlockLines() : null },
  ];
  for (const d of desired) {
    if (d.lines === null) continue;
    const block = findManagedBlock(parseProfile(candidate), d.name);
    try {
      if (block === 'ambiguous') throw new SfeError('BASELINE_CHANGED', `重新合并失败：受管理段 ${d.name} 的边界不明确，请手动修复`);
      candidate = block === 'missing' ? insertMissingBlock(candidate, d.name, d.lines) : replaceManagedBlock(candidate, d.name, d.lines);
    } catch (err) {
      blockError = err instanceof SfeError ? err.message : '重新合并失败：无法生成受管理段';
    }
  }
  // 本应用文件：节点资源恢复为上次发布内容；入口规则集恢复为普通模式内容
  const currentResource = await files.read(NODE_RESOURCE_FILE);
  const published = await lastPublishedResource(engine);
  const restoreResource = published !== null && published !== currentResource ? published : null;
  const restoreEntry = new Map<string, string>();
  for (const [name, content] of entryFiles(engine) ?? new Map<string, string>()) {
    const cur = await files.read(name);
    if (cur !== content) restoreEntry.set(name, content);
  }
  let filesDiff = '';
  if (restoreResource !== null) filesDiff += unifiedDiff(redactLines(currentResource ?? ''), redactLines(restoreResource), 1, [`${NODE_RESOURCE_FILE}（当前）`, `${NODE_RESOURCE_FILE}（上次发布）`]);
  for (const [name, content] of restoreEntry) filesDiff += unifiedDiff((await files.read(name)) ?? '', content, 1, [`${name}（当前）`, `${name}（恢复）`]);

  const views = engine.capabilityViews();
  const gateMissing = engine.missing(CAPABILITY_GATES.maintenanceWrite);
  const unmeasured = unmeasuredFrom(views, CAPABILITY_MEASURED_GATES.maintenanceWrite);
  const route = engine.repos.routeState.get();
  const requiresReload = candidate !== currentText;
  const overrides = new Map<string, string>();
  if (restoreResource !== null) overrides.set(NODE_RESOURCE_FILE, restoreResource);
  for (const [k, v] of restoreEntry) overrides.set(k, v);
  let checkOk = false;
  let checkMessage = '未执行';
  if (blockError === null) {
    try {
      const r = await checkCandidate(engine, { profileText: candidate, profileFileName: basename(wp.path), sourceDirectory: wp.directory, overrides });
      checkOk = r.ok;
      checkMessage = r.ok ? '候选配置校验通过' : `候选配置校验失败：${r.message}`;
    } catch (err) {
      checkMessage = engine.errorBody(err, '候选配置校验失败').message;
    }
  }
  const impact = views.find((v) => v.key === 'same_profile_reload_impact');
  const checks: RemergePreviewResponse['checks'] = [
    { name: 'gate', ok: gateMissing.length === 0 && unmeasured.length === 0, message: gateMissing.length === 0 && unmeasured.length === 0 ? '维护写入门槛已满足' : '维护写入门槛未满足：自动重载与原子替换行为、同一配置重载影响需要先实测' },
    { name: 'entry', ok: route.entryMode === 'NORMAL', message: route.entryMode === 'NORMAL' ? '入口为普通模式' : '入口不是普通模式：请先进入普通模式' },
    { name: 'segments', ok: blockError === null, message: blockError ?? '受管理段可以合并' },
    { name: 'check', ok: checkOk, message: checkMessage },
  ];
  const api = parseHttpApiLine(currentText);
  const digest = keyedRequestDigest(keys.preview, {
    kind: 'maintenance.remerge',
    current: fileDigest(engine, currentText),
    candidate: fileDigest(engine, candidate),
    resource: currentResource === null ? null : fileDigest(engine, currentResource),
    restoreResource: restoreResource === null ? null : fileDigest(engine, restoreResource),
    restoreEntry: [...restoreEntry.keys()].sort(),
  });
  const blocking: RemergePlan['blocking'] =
    gateMissing.length > 0 || unmeasured.length > 0
      ? { code: 'CAPABILITY_UNVERIFIED', message: '重新合并失败：维护写入门槛未满足' }
      : route.entryMode !== 'NORMAL'
        ? { code: 'ENVIRONMENT_ACTIVE', message: '重新合并失败：入口不是普通模式，请先进入普通模式' }
        : blockError !== null
          ? { code: 'BASELINE_CHANGED', message: blockError }
          : !checkOk
            ? { code: 'SURGE_CHECK_FAILED', message: checkMessage }
            : null;
  return {
    response: {
      preview_digest: digest,
      workingProfilePath: wp.path,
      backupDirectory: join(engine.deps.paths.backupsDir, 'remerge'),
      managedDiff: unifiedDiff(redactProfileText(currentText), redactProfileText(candidate), 1, ['当前工作配置', '合并后']),
      referencedFiles: await Promise.all(listRelativeReferences(currentText).map(async (r) => ({ relativePath: r.value, present: await exists(resolve(wp.directory, r.value)) }))),
      profileDirectoryRisk: classifyDirectoryRisk(wp.directory, engine.deps.paths.homedir),
      autoReloadEnabled: engine.facts.autoReload,
      takeover: { ...engine.facts.takeover },
      httpApi: api ? { configured: true, loopbackOnly: api.loopbackOnly } : { configured: false, loopbackOnly: null },
      remoteSources: listRemoteSourceHosts(currentText),
      remoteUpdatesNotice: listRemoteSourceHosts(currentText).length > 0 ? REMOTE_NOTICE : null,
      checks,
      nameCollisions: findForeignSfeObjects(candidate, { names: [ROUTE_GROUP_NAME], files: [NODE_RESOURCE_FILE, ...Object.values(ENTRY_RULESET_FILES)] }).map((o) => `${o.name}（第 ${o.line} 行）`),
      managedFilesDiff: filesDiff,
      requiresReload,
      measuredReloadImpact: impact && impact.effectiveStatus !== 'unverified' ? impact.note : null,
    },
    currentText,
    candidateText: candidate,
    profileFile: basename(wp.path),
    directory: wp.directory,
    restoreResource,
    restoreEntry,
    blocking,
  };
}

export async function remergePreview(deps: AcceptDeps, actor: Actor): Promise<RemergePreviewResponse> {
  requireWebOrAdmin(actor, '重新合并');
  return (await buildRemergePlan(deps.engine)).response;
}

export async function remergeCommit(deps: AcceptDeps, req: RemergeCommitRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  requireWebOrAdmin(actor, '重新合并');
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'remergeCommit', null, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const plan = await buildRemergePlan(engine);
  if (plan.blocking?.code === 'CAPABILITY_UNVERIFIED') throw new SfeError('CAPABILITY_UNVERIFIED', plan.blocking.message);
  if (plan.blocking?.code === 'ENVIRONMENT_ACTIVE') throw new SfeError('ENVIRONMENT_ACTIVE', plan.blocking.message);
  if (plan.response.preview_digest !== req.preview_digest) throw new SfeError('PREVIEW_STALE', '重新合并失败：工作配置或本应用文件已变化，请重新预览');
  if (plan.blocking) throw new SfeError(plan.blocking.code, plan.blocking.message);
  const op = engine.repos.tx(() =>
    insertOperation(engine, { kind: 'maintenance.remerge', requestId, digest, actor, payload: { previewDigest: req.preview_digest }, step: '已受理重新合并' }),
  );
  deps.kick();
  engine.emit({ operations: [op.id] });
  return acceptedOf(op, false);
}

export async function runRemerge(engine: Engine, op: OperationRecord, enqueuePublish: () => void): Promise<void> {
  const { repos } = engine;
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始重新合并：重新核对预览');
  try {
    const plan = await buildRemergePlan(engine);
    if ((op.payload as { previewDigest?: string }).previewDigest !== plan.response.preview_digest) throw new SfeError('PREVIEW_STALE', '重新合并失败：工作配置或本应用文件已变化，请重新预览');
    if (plan.blocking) throw new SfeError(plan.blocking.code, plan.blocking.message);
    const files = engine.profileFiles()!;
    const wp = engine.workingProfile()!;
    const before = { ...engine.facts.takeover };
    engine.updateOp(op.id, { phase: 'DEPLOYING' }, '备份当前工作配置');
    await backup(engine, 'remerge', wp.path, plan.currentText, plan.directory);
    if (plan.candidateText !== plan.currentText) {
      await files.writeAtomic(plan.profileFile, plan.candidateText, files.digestContent(plan.currentText));
      engine.step(op.id, '已写入受管理段');
      if (engine.facts.autoReload !== true) {
        // 经用户确认的同一配置重载（只有维护处理器能调用）
        await engine.maintenanceSurge.reloadProfile();
        engine.step(op.id, '已重载同一工作配置');
      } else {
        engine.step(op.id, '自动重载已开启：由 Surge 自动加载同一配置');
      }
      await engine.readBasicFacts();
      const after = engine.facts.takeover;
      if (after.enhancedMode !== before.enhancedMode || after.systemProxy !== before.systemProxy || after.outboundMode !== before.outboundMode) {
        throw new SfeError('READBACK_MISMATCH', '重新合并读回不一致：接管、系统代理或出站模式在重载后发生变化，请检查 Surge');
      }
      if (engine.facts.onWorkingProfile !== true) throw new SfeError('EXTERNAL_PROFILE', '重新合并读回不一致：Surge 当前配置不是固定工作配置');
    }
    const parsed = parseProfile(plan.candidateText);
    repos.tx(() => {
      for (const name of ['group', 'entry'] as const) {
        const block = findManagedBlock(parsed, name);
        if (typeof block !== 'object') continue;
        const d = segmentDigest(files.digestContent, name, block.version, block.lines);
        repos.managedObjects.upsertIntent({ kind: SEGMENT_KIND[name], identity: name, contentDigest: d, state: 'pending_add', createdByOperation: op.id });
        repos.managedObjects.setState(SEGMENT_KIND[name], name, 'present', { contentDigest: d });
      }
    });
    // 入口规则集（入口为 NORMAL）：恢复为占位内容
    for (const [name, content] of plan.restoreEntry) {
      const cur = await files.digest(name);
      if (cur === null) await createExclusivePrivateFile(join(plan.directory, name), content);
      else await files.writeAtomic(name, content, cur);
      const d = await files.digest(name);
      repos.managedObjects.upsertIntent({ kind: 'entry_ruleset_file', identity: name, contentDigest: d, state: 'pending_add', createdByOperation: op.id });
      repos.managedObjects.setState('entry_ruleset_file', name, 'present', { contentDigest: d });
    }
    // 节点资源：受发布门槛约束；恢复为上次发布内容后由一次发布定向刷新并读回
    if (plan.restoreResource !== null) {
      if (engine.missing(CAPABILITY_GATES.publish).length > 0) {
        engine.step(op.id, '节点资源与上次发布不一致：恢复需要发布能力，已跳过');
      } else {
        const cur = await files.digest(NODE_RESOURCE_FILE);
        if (cur === null) await createExclusivePrivateFile(join(plan.directory, NODE_RESOURCE_FILE), plan.restoreResource);
        else await files.writeAtomic(NODE_RESOURCE_FILE, plan.restoreResource, cur);
        const d = files.digestContent(plan.restoreResource);
        repos.managedObjects.upsertIntent({ kind: 'resource_file', identity: NODE_RESOURCE_FILE, contentDigest: d, state: 'pending_add', createdByOperation: op.id });
        repos.managedObjects.setState('resource_file', NODE_RESOURCE_FILE, 'present', { contentDigest: d });
        enqueuePublish();
        engine.step(op.id, '已恢复节点资源文件，并发起一次发布以定向刷新和读回');
      }
    }
    // 受管理段恢复后，清除“被修改”警告需要用户重新激活；这里只记录结果
    engine.updateOp(op.id, { phase: 'COMPLETED', status: 'succeeded' }, '重新合并完成', { surge: true });
  } catch (err) {
    const body = engine.errorBody(err, '重新合并失败：内部错误');
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
  }
}
