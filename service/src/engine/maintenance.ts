// 维护：初始化固定工作配置与重新合并受管理段（docs/ARCHITECTURE.md §5.3）。预览只读；提交重新计算摘要，
// 不一致返回 PREVIEW_STALE。初始化只写入新文件（目标必须不存在），由用户在 Surge 中手动切换一次；
// 重新合并受维护写门槛约束、入口必须是 NORMAL，只写受管理段，按 P0 结论生效（自动重载或经确认的同一配置重载），
// 只有维护处理器能拿到 MaintenanceSurge。
// 节点资源（D10）由本机资源服务提供（engine/node-resource.ts）：初始化写入指向本服务当前地址的节点组定义、已提交第 0 代
// （只含占位行），从不创建本地 sfe-nodes.list；重新合并恢复节点组定义，需要时重新提供已提交版本、要求刷新并排入一次节点资源
// 发布（单 key 更新并读回，受发布门槛约束）；仍引用旧的本地节点文件时只在 resourceServe 门槛满足后改用本机资源服务，读回确认
// 之后删除旧文件；选项“更换本机资源地址”生成新的读取令牌与端口（清除“令牌可能已泄露”的唯一方式）。预览从不生成令牌或端口，
// 端口在启动时已选定、令牌已存在，所以预览、提交与执行得到同一候选。地址含读取令牌：只写进工作配置，差异中遮盖。
// Surge 6.9+ 的重载只应用差异，但必要时会自动升级为完整的引擎重启（关闭全部连接、清空临时规则）：网页预览与操作步骤都写明，
// 重载后读引擎运行时长报告是否发生了完整重启。重载只在这里、只经用户确认。

import { lstat, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CAPABILITY_GATES,
  CAPABILITY_MEASURED_GATES,
  EMPTY_PLACEHOLDER_NODE,
  ENTRY_RULESET_FILES,
  LEGACY_NODE_GROUP_LINE,
  NODE_RESOURCE_FILE,
  ROUTE_GROUP_NAME,
  SfeError,
  WORKING_PROFILE_NAME,
  nodeResourceUrl,
  type Accepted,
  type InitCommitRequest,
  type InitPreviewRequest,
  type InitPreviewResponse,
  type RemergeCommitRequest,
  type RemergePreviewRequest,
  type RemergePreviewResponse,
} from '@sfe/contract';
import type { Actor } from '../app.js';
import type { OperationRecord } from '../db/index.js';
import { payloadOf } from '../domain/operations.js';
import type { SurgeExternalResource } from '../ports.js';
import {
  readNeedsRefresh,
  readServedPointer,
  readTokenSuspect,
  rotateResourceToken,
  writeAuditState,
  writeNeedsRefresh,
  writeServedPointer,
  writeTokenSuspect,
  type ResourceHost,
} from '../resource/index.js';
import { ENTRY_BITS_IN_ORDER, entryRuleSetBlockLines, entryRuleSetFileContent, loopbackGroupBlockLines, resourceBody, rewriteLoopbackForCheck } from '../surge/generate.js';
import { parseHttpApiLine } from '../surge/http-adapter.js';
import {
  detectManagedConfigHeader,
  dominantEol,
  findForeignSfeObjects,
  findManagedBlock,
  findSections,
  foreignSfePolicyNames,
  insertInitialBlocks,
  listRelativeReferences,
  listRemoteSourceHosts,
  parseProfile,
  replaceManagedBlock,
  serializeProfile,
  stripManagedConfigHeader,
  unifiedDiff,
} from '../surge/profile.js';
import { redactProfileText } from '../surge/redact-profile.js';
import { classifyDirectoryRisk, createExclusivePrivateFile, ensurePrivateDir, isInsideGitWorkTree } from '../util/secure-files.js';
import { hmacHex, keyedRequestDigest } from '../util/keyed-digest.js';
import { insertOperation, type AcceptDeps } from './accept.js';
import { checkCandidate } from './candidate.js';
import { readRuntimeSample, surgeRestartedBetween, type Engine } from './context.js';
import { acceptedOf, commitOperation, findDuplicateOperation, requestDigest, requireRequestId } from './ledger.js';
import {
  adoptResourceHost,
  classifyGroupLine,
  committedNodeNames,
  createEngineResourceHost,
  ensureListeningBeforeInit,
  findOurResource,
  generalPorts,
  listenOnNewPort,
  loopbackPortOfLocation,
  loopbackPortsIn,
  membersMatchCommitted,
  readGroupLine,
  resourceErrorOf,
  serveCommittedGeneration,
  serveCommittedOn,
  SYSTEM_REFRESH_KEY,
} from './node-resource.js';
import { registerInitialObjects, segmentDigest, SEGMENT_KIND, type SegmentName } from './ownership.js';
import { unmeasuredFrom } from './capabilities.js';

const MAX_REMERGE_BACKUPS = 5;

/**
 * 同一配置重载的影响说明（网页预览 RemergeCard 显示同一段文字）。surge-cli 6.10 的 reload 说明：“Reload the main profile
 * and apply only the changed sections. Unaffected connections, caches and temporary rules are preserved. Automatically
 * performs a full engine restart if a change requires one.”；restart-engine 说明：“All connections are closed, and all
 * caches and temporary rules are cleared.”。哪些修改会触发完整重启没有写入文档。
 */
export const RELOAD_FULL_RESTART_NOTICE =
  'Surge 6.9 起重载只应用变化的部分，但在修改需要时会自动执行完整的引擎重启（文档：“Automatically performs a full engine restart if a change requires one.”）：完整重启会关闭全部连接并清空临时规则与缓存，哪些修改会触发它没有写入文档';
const REMOTE_NOTICE = '源配置的远端更新不再自动应用到工作配置；之后需要通过“重新合并”手动接入';

/** 工作配置仍引用旧的本地节点文件、resourceServe 门槛未满足时重新合并的说明（预览检查与操作步骤）。 */
export const LEGACY_LINE_KEPT_TEXT = '本机资源服务补测通过后才能改用本机资源服务（当前保持原有本地节点文件引用）';

/** 更换本机资源地址的预览中，节点组定义新地址的显示（只用于差异；新端口与令牌在提交时才生成）。 */
const ROTATED_LINE_DISPLAY = `${ROUTE_GROUP_NAME} = select, REJECT, policy-path=http://127.0.0.1:<新端口>/***`;

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

/**
 * 维护提交在操作中记下的预览核对（docs/ARCHITECTURE.md §0「秘密的存放」、§4）。预览摘要按 pepper 派生的密钥对含秘密的内容计算
 * （工作配置中用户自己的节点凭据与本机资源服务地址中的读取令牌），持久保存它会让拿到数据目录副本的人离线核对猜测的旧凭据（已替换、
 * 已清扫的代理密码）。操作中只保存它在本进程随机密钥下的 HMAC 与进程标识（engine.requestEphemeral，从不持久保存）：进程结束之后
 * 任何人都无法再用它核对。
 */
interface PreviewCheck {
  epoch: string;
  mac: string;
}

function previewCheckOf(engine: Engine, previewDigest: string): PreviewCheck {
  const { key, epoch } = engine.requestEphemeral;
  return { epoch, mac: hmacHex(key, `preview-check\0${previewDigest}`) };
}

/**
 * 执行时重新计算的预览摘要是否就是受理时核对过的那一个。受理之后服务重新启动（进程标识不同，随机密钥已丢失）时无法核对：
 * 按预览已过期处理（PREVIEW_STALE，what 写明是哪一项维护），用户重新预览后再提交。
 */
function requirePreviewCheck(engine: Engine, op: OperationRecord, previewDigest: string, what: string, changed: string): void {
  const check = (op.payload as { previewCheck?: Partial<PreviewCheck> }).previewCheck;
  if (!check || typeof check.mac !== 'string' || check.epoch !== engine.requestEphemeral.epoch) {
    throw new SfeError('PREVIEW_STALE', `${what}失败：服务在受理之后重新启动，无法再核对预览，请重新预览后再提交`);
  }
  if (check.mac !== previewCheckOf(engine, previewDigest).mac) throw new SfeError('PREVIEW_STALE', changed);
}

/**
 * 初始化与重新合并共同的前提：本机资源服务存在（读取令牌读得到）且端口已选定（启动时选定并保存）——节点组定义中的地址由它们
 * 得出。否则拒绝（SECRET_STORE_FAILED / RESOURCE_SERVER_UNAVAILABLE），不生成任何候选。
 */
function requireResourceHost(engine: Engine, what: string): { host: ResourceHost; url: string; port: number } {
  const host = engine.resource;
  if (host === null) {
    throw new SfeError('SECRET_STORE_FAILED', `${what}失败：本机资源服务的读取令牌读不到，无法生成节点组定义`, { details: { reason: 'token_unavailable' } });
  }
  const url = engine.resourceUrl();
  const port = engine.repos.settings.get('resourcePort');
  if (url === null || port === null) {
    throw new SfeError('RESOURCE_SERVER_UNAVAILABLE', `${what}失败：本机资源服务尚未选定端口`, { details: { reason: 'no_port' } });
  }
  return { host, url, port };
}

/** 资源服务在已设置的端口监听。 */
function listeningOn(host: ResourceHost, port: number): boolean {
  return host.listening() && host.port() === port;
}

/** 写入或重载工作配置之前：节点资源指针不能有候选版本（发布中途）。 */
function assertNoCandidate(engine: Engine, what: string): void {
  if (readServedPointer(engine.kv)?.candidate) {
    throw new SfeError('RESOURCE_SERVER_UNAVAILABLE', `${what}失败：本机资源服务有尚未提交的候选版本（节点资源发布尚未结束），请稍后再试`, { details: { reason: 'candidate_pending' } });
  }
}

// ---------- 初始化 ----------

interface InitPlan {
  response: InitPreviewResponse;
  sourceText: string;
  candidateText: string;
  /** 初始化创建的本应用文件（只有入口规则集；节点资源由本机资源服务提供，从不创建 sfe-nodes.list）。 */
  files: Map<string, string>;
  targetPath: string;
  directory: string;
  blocking: { code: 'UNSAFE_LOCATION' | 'NAME_COLLISION' | 'SURGE_CHECK_FAILED' | 'VALIDATION_FAILED' | 'RESOURCE_SERVER_UNAVAILABLE'; message: string } | null;
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
  // 尚未初始化：已选定的端口被其他程序占用时改选一个（地址还没有写进任何配置）
  await ensureListeningBeforeInit(engine);
  const { host, url, port } = requireResourceHost(engine, '初始化');
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
  const remote = listRemoteSourceHosts(sourceText, url);
  const refs = listRelativeReferences(sourceText);
  const referencedFiles: InitPreviewResponse['referencedFiles'] = [];
  for (const r of refs) referencedFiles.push({ relativePath: r.value, present: await exists(resolve(directory, r.value)) });

  // 名称与文件冲突（含源配置与 Surge 外部资源中对本机资源服务端口的引用）
  const collisions = new Set<string>();
  /** 读不到的 Surge 列表：不能确认模块等配置文本之外没有同名对象，按冲突处理（不放行）。 */
  const unreadable: string[] = [];
  for (const o of findForeignSfeObjects(sourceText, { names: [], files: [], resourceUrl: url })) collisions.add(`${o.name}（第 ${o.line} 行）`);
  try {
    const policies = await engine.surge.listPolicies();
    for (const n of foreignSfePolicyNames([...policies.proxies, ...policies.groups], new Set())) collisions.add(n);
  } catch {
    unreadable.push('策略列表');
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
      // 已有外部资源指向本机资源服务的端口（127.0.0.1:端口）：Surge 会把它与本应用的资源混淆，也可能有其他程序占用该端口
      if (loopbackPortOfLocation(r.location) === port) collisions.add('外部资源指向本机资源服务的端口');
    }
  } catch {
    unreadable.push('外部资源列表');
  }

  const strategy = engine.repos.settings.get('entryStrategy');
  const entry = strategy === 'ruleset_resource' && engine.entryConfig().processPaths.length > 0 ? entryRuleSetBlockLines() : null;
  let candidateText = sourceText;
  let insertError: string | null = null;
  try {
    candidateText = insertInitialBlocks(header ? stripManagedConfigHeader(sourceText) : sourceText, { group: loopbackGroupBlockLines(url), entry, general: null });
  } catch (err) {
    insertError = err instanceof SfeError ? err.message : '初始化失败：无法插入受管理段';
  }
  // 初始化创建的文件（入口规则集）与 --check 的覆盖分开：节点资源只作为 --check 的候选副本（SFE-ROUTE 改指相对的占位列表），
  // 从不写进 Surge 配置目录
  const createFiles = entryFiles(engine) ?? new Map<string, string>();

  const checks: InitPreviewResponse['checks'] = [];
  checks.push({ name: 'directory', ok: risk === 'none', message: risk === 'none' ? '配置目录不在同步或受保护位置' : risk === 'synced' ? '配置目录位于 iCloud 或云盘同步位置：默认拒绝' : '配置目录位于文稿、桌面或下载等受保护位置：默认拒绝' });
  checks.push({ name: 'git', ok: !inGit, message: inGit ? '配置目录位于 Git 工作树内：请确认不会提交含凭据的文件' : '配置目录不在 Git 工作树内' });
  checks.push({ name: 'access', ok: true, message: '服务以当前运行方式可以读取该目录；LaunchAgent 下是否出现 TCC 提示需在测试 Mac 上确认' });
  const listening = listeningOn(host, port);
  checks.push({
    name: 'resource_server',
    ok: listening,
    message: listening ? '本机资源服务正在已设置的端口监听：SFE-ROUTE 将指向它（地址含读取令牌，只写进工作配置）' : '本机资源服务没有在已设置的端口监听（端口可能被占用）：初始化需要它先监听',
  });
  checks.push({ name: 'collisions', ok: collisions.size === 0 && insertError === null, message: insertError ?? (collisions.size === 0 ? '没有名称或文件冲突' : '存在非本应用的 SFE- 名称、sfe-* 文件或指向本机资源服务端口的引用') });
  const unreadableMessage = unreadable.length > 0 ? `无法读取 Surge 的${unreadable.join('与')}：不能确认模块或其他配置中没有同名的 SFE- 对象` : null;
  checks.push({ name: 'surge_names', ok: unreadableMessage === null, message: unreadableMessage ?? '已读取 Surge 的策略与外部资源列表' });
  if (strategy === 'ruleset_resource' && entry === null) checks.push({ name: 'entry', ok: true, message: 'Safari 进程路径尚未确认：入口规则集将在之后的重新合并中写入' });

  let checkOk = false;
  let checkMessage = '未执行';
  if (insertError === null) {
    try {
      // --check 从不接触本机资源服务：SFE-ROUTE 的 policy-path 换成相对的候选列表（第 0 代，只含占位行）
      const rewrite = rewriteLoopbackForCheck(candidateText, resourceBody(0, []), url);
      const overrides = new Map<string, string>(rewrite.overrides);
      for (const [k, v] of createFiles) overrides.set(k, v);
      const r = await checkCandidate(engine, { profileText: rewrite.text, profileFileName: basename(targetPath), sourceDirectory: directory, overrides });
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
      : !listening
        ? { code: 'RESOURCE_SERVER_UNAVAILABLE', message: '初始化失败：本机资源服务没有在已设置的端口监听（端口可能被占用），未写入任何内容' }
        : insertError !== null || collisions.size > 0
          ? { code: 'NAME_COLLISION', message: insertError ?? '初始化失败：存在非本应用的 SFE- 名称、sfe-* 文件或指向本机资源服务端口的引用' }
          : unreadableMessage !== null
            ? { code: 'NAME_COLLISION', message: `初始化失败：${unreadableMessage}` }
            : !checkOk
              ? { code: 'SURGE_CHECK_FAILED', message: checkMessage }
              : null;
  const response: InitPreviewResponse = {
    preview_digest: digest,
    sourceProfileName: profile.name,
    sourceProfilePath: sourcePath,
    workingProfilePath: targetPath,
    backupDirectory: join(engine.deps.paths.backupsDir, 'init'),
    // 本机资源服务地址的路径（读取令牌）在差异中遮盖
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
  return { response, sourceText, candidateText, files: createFiles, targetPath, directory, blocking };
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
  const { op, duplicate } = commitOperation(engine, requestId, digest, () =>
    insertOperation(engine, { kind: 'maintenance.init', requestId, digest, actor, payload: { previewCheck: previewCheckOf(engine, req.preview_digest) }, step: '已受理初始化固定工作配置' }),
  );
  if (duplicate) return acceptedOf(op, true);
  deps.kick();
  engine.emit({ operations: [op.id] });
  return acceptedOf(op, false);
}

/**
 * 本应用生成的文件（入口规则集与旧的本地节点文件）：内容全部由数据库重新生成，不是需要恢复的用户内容，备份不复制。旧的
 * sfe-nodes.list 含明文代理凭据——复制进备份会让被替换、已从 secret_values 删除的旧代理凭据一直留在数据目录中（备份按次数保留，
 * 与秘密的清扫无关；INSTALL §6、ARCHITECTURE §0/§2）。
 */
const GENERATED_FILES: ReadonlySet<string> = new Set([NODE_RESOURCE_FILE, ...Object.values(ENTRY_RULESET_FILES)]);

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
    if (dirname(src) === directory && GENERATED_FILES.has(basename(src))) continue;
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
    requirePreviewCheck(engine, op, plan.response.preview_digest, '初始化', '初始化失败：配置或引用文件已变化，请重新预览');
    if (plan.blocking) throw new SfeError(plan.blocking.code, plan.blocking.message);
    assertNoCandidate(engine, '初始化');
    engine.updateOp(op.id, { phase: 'DEPLOYING' }, '备份当前配置与引用文件');
    const sourcePath = plan.response.sourceProfilePath;
    const dir = await backup(engine, 'init', sourcePath, plan.sourceText, plan.directory);
    engine.step(op.id, `已备份到 ${dir}`);
    // 只写新文件（目标必须不存在）；节点资源不是文件
    await createExclusivePrivateFile(plan.targetPath, plan.candidateText);
    for (const [name, content] of plan.files) await createExclusivePrivateFile(join(plan.directory, name), content);
    engine.repos.tx(() => {
      engine.repos.settings.set('workingProfilePath', plan.targetPath);
      engine.repos.settings.set('workingProfileName', WORKING_PROFILE_NAME);
      // 已提交第 0 代（只含占位行），没有候选版本。新的地址从未被 Surge 载入过：没有需要刷新的内容（已有发布记录时保守地要求刷新）
      writeServedPointer(engine.kv, { committed: { generation: 0 }, candidate: null });
      if (engine.repos.deployments.list(1).length === 0) writeNeedsRefresh(engine.kv, null);
      else if (readNeedsRefresh(engine.kv) === null) writeNeedsRefresh(engine.kv, { generation: 0, reason: 'init' });
    });
    await serveCommittedGeneration(engine);
    const files = engine.profileFiles()!;
    await registerInitialObjects(engine.repos, { profileText: plan.candidateText, digestContent: files.digestContent, fileDigest: (n) => files.digest(n), operationId: op.id });
    await readGroupLine(engine);
    engine.updateOp(
      op.id,
      { phase: 'COMPLETED', status: 'succeeded' },
      `已创建工作配置「${WORKING_PROFILE_NAME}」：SFE-ROUTE 指向本机资源服务（目前只提供占位节点）。请在 Surge 中手动切换到该配置一次（本应用从不切换配置）`,
      { settings: true, surge: true },
    );
  } catch (err) {
    const body = engine.errorBody(err, '初始化失败：内部错误');
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
  }
}

// ---------- 重新合并 ----------

/** 需要重新提供已提交版本、要求刷新并排入一次节点资源发布的原因。 */
export type RemergeResourceReason =
  | 'convert'
  | 'rotate'
  | 'group_line'
  | 'needs_refresh'
  | 'not_served'
  | 'resource_missing'
  | 'resource_ambiguous'
  | 'resource_foreign'
  | 'resource_error'
  | 'members_mismatch'
  | 'surge_unreadable';

const RESOURCE_REASON_TEXT: Record<RemergeResourceReason, string> = {
  convert: '改用本机资源服务',
  rotate: '更换本机资源地址',
  group_line: '节点组定义需要恢复',
  needs_refresh: '有尚未完成的刷新要求',
  not_served: '本机资源服务没有在提供已提交版本',
  resource_missing: 'Surge 中找不到本应用的节点资源',
  resource_ambiguous: 'Surge 中有多个指向本机资源服务地址的资源',
  resource_foreign: '指向本机资源服务地址的资源不是工作配置中的远端节点组资源',
  resource_error: 'Surge 报告本应用的节点资源有错误或尚未下载',
  members_mismatch: 'SFE-ROUTE 的成员与已提交版本不同',
  surge_unreadable: '无法读取 Surge 中的节点资源',
};

/** 重新合并对节点资源的处理（预览与执行由同一状态得出）。 */
type RemergeResourcePlan =
  /** 仍引用旧的本地节点文件、resourceServe 门槛未满足：保持原有引用，不触及节点资源。 */
  | { mode: 'legacy_kept' }
  | {
      mode: 'loopback';
      /** 当前是旧的本地节点文件定义（resourceServe 门槛已满足）：改用本机资源服务。 */
      convert: boolean;
      rotate: boolean;
      /** 需要重新提供已提交版本、要求刷新并排入一次节点资源发布的原因；空数组表示不需要。 */
      reasons: RemergeResourceReason[];
      /** D7 留下的本地节点文件记录仍在：读回确认之后删除文件并清除记录。 */
      legacyCleanup: boolean;
    };

interface RemergePlan {
  response: RemergePreviewResponse;
  currentText: string;
  candidateText: string;
  profileFile: string;
  directory: string;
  restoreEntry: Map<string, string>;
  resource: RemergeResourcePlan;
  blocking: { code: 'CAPABILITY_UNVERIFIED' | 'ENVIRONMENT_ACTIVE' | 'BASELINE_CHANGED' | 'SURGE_CHECK_FAILED' | 'RESOURCE_SERVER_UNAVAILABLE'; message: string } | null;
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

/** D7 留下的本地节点文件记录（managed_objects resource_file，尚未清除）；没有时为 null。 */
function legacyResourceRecord(engine: Engine) {
  const rec = engine.repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE);
  return rec && rec.state !== 'removed' ? rec : null;
}

/** 重新合并的选项“更换本机资源地址”：省略为 false；不是布尔值时拒绝。 */
function rotationOption(v: unknown): boolean {
  if (v === undefined || v === false) return false;
  if (v === true) return true;
  throw new SfeError('BAD_REQUEST', '重新合并失败：rotateResourceUrl 必须是布尔值');
}

/**
 * Surge 中本应用节点资源与已提交版本的差异（只读）：Surge 不可达或当前配置不是工作配置时读不到，按 surge_unreadable 处理
 * （失败即关闭：仍重新提供并要求刷新）。members 为读到的 SFE-ROUTE 成员（读不到为 null）。
 */
async function surgeResourceIssues(engine: Engine, url: string): Promise<{ reasons: RemergeResourceReason[]; members: string[] | null }> {
  if (!engine.facts.reachable || engine.facts.onWorkingProfile !== true) return { reasons: ['surge_unreadable'], members: null };
  let list: SurgeExternalResource[];
  try {
    list = await engine.surge.listExternalResources();
  } catch {
    return { reasons: ['surge_unreadable'], members: null };
  }
  const reasons: RemergeResourceReason[] = [];
  const found = findOurResource(list, url);
  if (found.problem !== null) reasons.push(found.problem);
  else if (resourceErrorOf(found.resource!) !== null) reasons.push('resource_error');
  let members: string[] | null = null;
  try {
    members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
    if (!membersMatchCommitted(members, committedNodeNames(engine))) reasons.push('members_mismatch');
  } catch {
    reasons.push('surge_unreadable');
  }
  return { reasons, members };
}

/** 已提交版本的 SFE-ROUTE 成员（REJECT 在首位；没有节点时是占位节点）；发布记录不在时为 null。 */
function committedMembers(engine: Engine): string[] | null {
  const names = committedNodeNames(engine);
  return names === null ? null : ['REJECT', ...(names.length > 0 ? names : [EMPTY_PLACEHOLDER_NODE])];
}

async function buildRemergePlan(engine: Engine, opts: { rotate: boolean }): Promise<RemergePlan> {
  const keys = await engine.keys();
  const wp = engine.workingProfile();
  if (!wp) throw new SfeError('RESOURCE_MISSING', '重新合并失败：尚未初始化固定工作配置');
  const { host, url, port } = requireResourceHost(engine, '重新合并');
  await engine.readBasicFacts();
  let currentText: string;
  try {
    currentText = await readFile(wp.path, 'utf8');
  } catch {
    throw new SfeError('EXTERNAL_PROFILE', '重新合并失败：无法读取工作配置');
  }
  const { kv } = engine;
  let candidate = currentText;
  let blockError: string | null = null;

  // 节点组段（D10）：恢复为指向本服务当前地址的定义；仍是旧的本地节点文件定义（或段被改过而 D7 的本地文件记录仍在）时，
  // 只有 resourceServe 门槛满足才改用本机资源服务，否则保持旧定义（从不在门槛之外让本地已部署的节点消失）
  const groupLine = classifyGroupLine(currentText, url);
  const legacyRecord = legacyResourceRecord(engine);
  const legacy = groupLine === 'legacy' || (groupLine === 'none' && legacyRecord !== null);
  const serveMissing = engine.missing(CAPABILITY_GATES.resourceServe);
  const keepLegacy = legacy && serveMissing.length > 0;
  const pointer = readServedPointer(kv);
  let resourceBlock: RemergePlan['blocking'] = null;
  if (pointer?.candidate) {
    resourceBlock = { code: 'RESOURCE_SERVER_UNAVAILABLE', message: '重新合并失败：本机资源服务有尚未提交的候选版本（节点资源发布尚未结束），请稍后再试' };
  } else if (keepLegacy && opts.rotate) {
    resourceBlock = { code: 'CAPABILITY_UNVERIFIED', message: '重新合并失败：工作配置仍引用本地节点文件，本机资源服务补测通过之前不能更换本机资源地址' };
  } else if (!keepLegacy && pointer === null) {
    resourceBlock = { code: 'RESOURCE_SERVER_UNAVAILABLE', message: '重新合并失败：本机资源服务的已提交版本尚未初始化，请稍后再试' };
  } else if (legacy && !keepLegacy && !opts.rotate && !listeningOn(host, port)) {
    resourceBlock = { code: 'RESOURCE_SERVER_UNAVAILABLE', message: '重新合并失败：改用本机资源服务需要它在已设置的端口监听（端口可能被占用；可以同时更换本机资源地址）' };
  }

  const desired: Array<{ name: SegmentName; lines: string[] | null }> = [
    { name: 'group', lines: keepLegacy ? [LEGACY_NODE_GROUP_LINE] : loopbackGroupBlockLines(url) },
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

  // 节点资源：需要时重新提供已提交版本、要求刷新并排入一次节点资源发布（Surge 读回在预览中只读）
  let resource: RemergeResourcePlan;
  let filesDiff = '';
  if (keepLegacy) {
    resource = { mode: 'legacy_kept' };
  } else {
    const reasons: RemergeResourceReason[] = [];
    if (legacy) reasons.push('convert');
    if (opts.rotate) reasons.push('rotate');
    if (!legacy && groupLine !== 'ours') reasons.push('group_line');
    if (readNeedsRefresh(kv) !== null) reasons.push('needs_refresh');
    const served = host.served();
    if (pointer !== null && (served === null || served.state !== 'committed' || served.generation !== pointer.committed.generation)) reasons.push('not_served');
    if (groupLine === 'ours') {
      const surge = await surgeResourceIssues(engine, url);
      for (const r of surge.reasons) if (!reasons.includes(r)) reasons.push(r);
      const expected = committedMembers(engine);
      if (surge.reasons.includes('members_mismatch') && surge.members !== null && expected !== null) {
        filesDiff += unifiedDiff(`${surge.members.join('\n')}\n`, `${expected.join('\n')}\n`, 1, ['SFE-ROUTE 成员（Surge 当前）', 'SFE-ROUTE 成员（已提交版本）']);
      }
    }
    resource = { mode: 'loopback', convert: legacy, rotate: opts.rotate, reasons, legacyCleanup: legacyRecord !== null };
  }

  // 入口规则集恢复为普通模式内容
  const files = engine.profileFiles()!;
  const restoreEntry = new Map<string, string>();
  for (const [name, content] of entryFiles(engine) ?? new Map<string, string>()) {
    const cur = await files.read(name);
    if (cur !== content) restoreEntry.set(name, content);
  }
  for (const [name, content] of restoreEntry) filesDiff += unifiedDiff((await files.read(name)) ?? '', content, 1, [`${name}（当前）`, `${name}（恢复）`]);

  const views = engine.capabilityViews();
  const gateMissing = engine.missing(CAPABILITY_GATES.maintenanceWrite);
  const unmeasured = unmeasuredFrom(views, CAPABILITY_MEASURED_GATES.maintenanceWrite);
  const route = engine.repos.routeState.get();
  const requiresReload = candidate !== currentText || opts.rotate;
  let checkOk = false;
  let checkMessage = '未执行';
  if (blockError === null) {
    try {
      // --check 从不接触本机资源服务：SFE-ROUTE 的 policy-path 换成相对的候选列表（只含占位行；节点内容由发布单独校验）。
      // 保持旧定义时它引用配置目录中真实的本地节点文件
      const overrides = new Map<string, string>(restoreEntry);
      let checkText = candidate;
      if (!keepLegacy) {
        const rewrite = rewriteLoopbackForCheck(candidate, resourceBody(0, []), url);
        checkText = rewrite.text;
        for (const [k, v] of rewrite.overrides) overrides.set(k, v);
      }
      const r = await checkCandidate(engine, { profileText: checkText, profileFileName: basename(wp.path), sourceDirectory: wp.directory, overrides });
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
    { name: 'node_resource', ok: resourceBlock === null, message: resourceBlock?.message ?? resourceCheckMessage(resource) },
  ];
  if (opts.rotate) {
    checks.push({
      name: 'rotate',
      ok: resourceBlock === null,
      message: '将更换本机资源地址：提交时生成新的读取令牌、选定新的本机端口，改写节点组定义并重载同一配置；旧地址随即失效（预览不生成令牌或端口）',
    });
  } else if (readTokenSuspect(kv) !== null) {
    checks.push({ name: 'resource_token', ok: true, message: '读取令牌可能已泄露：只有选择“更换本机资源地址”的重新合并才能清除它（在此之前新版本保持待部署）' });
  }
  checks.push({ name: 'check', ok: checkOk, message: checkMessage });
  const api = parseHttpApiLine(currentText);
  const digest = keyedRequestDigest(keys.preview, {
    kind: 'maintenance.remerge',
    current: fileDigest(engine, currentText),
    candidate: fileDigest(engine, candidate),
    restoreEntry: [...restoreEntry.keys()].sort(),
    rotate: opts.rotate,
    resource: resource.mode === 'legacy_kept' ? 'legacy_kept' : { convert: resource.convert, restore: resource.reasons.length > 0, legacyCleanup: resource.legacyCleanup },
  });
  const blocking: RemergePlan['blocking'] =
    gateMissing.length > 0 || unmeasured.length > 0
      ? { code: 'CAPABILITY_UNVERIFIED', message: '重新合并失败：维护写入门槛未满足' }
      : route.entryMode !== 'NORMAL'
        ? { code: 'ENVIRONMENT_ACTIVE', message: '重新合并失败：入口不是普通模式，请先进入普通模式' }
        : resourceBlock !== null
          ? resourceBlock
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
      // 本机资源服务地址的路径（读取令牌）在差异中遮盖；更换地址时新地址只显示占位
      managedDiff: unifiedDiff(redactProfileText(currentText), displayCandidate(candidate, opts.rotate && !keepLegacy), 1, ['当前工作配置', '合并后']),
      referencedFiles: await Promise.all(listRelativeReferences(currentText).map(async (r) => ({ relativePath: r.value, present: await exists(resolve(wp.directory, r.value)) }))),
      profileDirectoryRisk: classifyDirectoryRisk(wp.directory, engine.deps.paths.homedir),
      autoReloadEnabled: engine.facts.autoReload,
      takeover: { ...engine.facts.takeover },
      httpApi: api ? { configured: true, loopbackOnly: api.loopbackOnly } : { configured: false, loopbackOnly: null },
      remoteSources: listRemoteSourceHosts(currentText, url),
      remoteUpdatesNotice: listRemoteSourceHosts(currentText, url).length > 0 ? REMOTE_NOTICE : null,
      checks,
      nameCollisions: findForeignSfeObjects(candidate, {
        names: [ROUTE_GROUP_NAME],
        files: [...(keepLegacy ? [NODE_RESOURCE_FILE] : []), ...Object.values(ENTRY_RULESET_FILES)],
        resourceUrl: url,
      }).map((o) => `${o.name}（第 ${o.line} 行）`),
      managedFilesDiff: filesDiff,
      requiresReload,
      measuredReloadImpact: impact && impact.effectiveStatus !== 'unverified' ? impact.note : null,
    },
    currentText,
    candidateText: candidate,
    profileFile: basename(wp.path),
    directory: wp.directory,
    restoreEntry,
    resource,
    blocking,
  };
}

/** 预览检查 node_resource 的说明。 */
function resourceCheckMessage(resource: RemergeResourcePlan): string {
  if (resource.mode === 'legacy_kept') return LEGACY_LINE_KEPT_TEXT;
  const parts: string[] = [];
  if (resource.convert) parts.push('将改用本机资源服务：SFE-ROUTE 改为指向本机资源服务并重载同一配置，由它提供已提交的节点');
  if (resource.reasons.length > 0) {
    parts.push(
      `节点资源需要与已提交版本重新核对（${resource.reasons.map((r) => RESOURCE_REASON_TEXT[r]).join('、')}）：提交后重新提供已提交版本，并排入一次节点资源发布（只对本应用的资源单 key 更新并读回；发布门槛不满足时保持待部署）`,
    );
  }
  if (resource.legacyCleanup) parts.push('旧的本地节点文件 sfe-nodes.list 在读回确认之后删除');
  return parts.length > 0 ? parts.join('；') : '节点资源由本机资源服务提供已提交版本，与 Surge 读回一致';
}

/** 差异中的“合并后”：脱敏后的候选；更换地址时节点组定义显示为新地址的占位（新端口与令牌提交时才生成）。 */
function displayCandidate(candidate: string, rotate: boolean): string {
  const redacted = redactProfileText(candidate);
  if (!rotate) return redacted;
  const block = findManagedBlock(parseProfile(candidate), 'group');
  if (typeof block !== 'object') return redacted;
  const lines = parseProfile(redacted).lines.map((l, i) => (i > block.start && i < block.end ? { ...l, text: ROTATED_LINE_DISPLAY } : l));
  return serializeProfile(lines);
}

/** 重载后的引擎运行时长读回：是否发生了完整引擎重启（运行时长回落或启动时间向后移动）。 */
export function reloadRestartReport(before: { startedAt: string | null; uptimeSeconds: number | null } | null, after: { startedAt: string | null; uptimeSeconds: number | null } | null): string {
  if (before === null || after === null) return '无法读取 Surge 引擎运行时长：不能确认重载是否升级为完整引擎重启';
  return surgeRestartedBetween(before, after)
    ? '重载后引擎运行时长回落：Surge 执行了完整引擎重启，全部连接已关闭、临时规则已清空'
    : '重载后引擎运行时长连续：未发生完整引擎重启';
}

export async function remergePreview(deps: AcceptDeps, actor: Actor, req?: RemergePreviewRequest): Promise<RemergePreviewResponse> {
  requireWebOrAdmin(actor, '重新合并');
  const rotate = rotationOption(req?.rotateResourceUrl);
  return (await buildRemergePlan(deps.engine, { rotate })).response;
}

export async function remergeCommit(deps: AcceptDeps, req: RemergeCommitRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  requireWebOrAdmin(actor, '重新合并');
  const requestId = requireRequestId(req?.request_id);
  const rotate = rotationOption(req?.rotateResourceUrl);
  const digest = await requestDigest(engine, 'remergeCommit', null, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const plan = await buildRemergePlan(engine, { rotate });
  if (plan.blocking?.code === 'CAPABILITY_UNVERIFIED') throw new SfeError('CAPABILITY_UNVERIFIED', plan.blocking.message);
  if (plan.blocking?.code === 'ENVIRONMENT_ACTIVE') throw new SfeError('ENVIRONMENT_ACTIVE', plan.blocking.message);
  if (plan.response.preview_digest !== req.preview_digest) throw new SfeError('PREVIEW_STALE', '重新合并失败：工作配置或本应用文件已变化，请重新预览');
  if (plan.blocking) throw new SfeError(plan.blocking.code, plan.blocking.message);
  const { op, duplicate } = commitOperation(engine, requestId, digest, () =>
    insertOperation(engine, {
      kind: 'maintenance.remerge',
      requestId,
      digest,
      actor,
      payload: { previewCheck: previewCheckOf(engine, req.preview_digest), ...(rotate ? { rotateResourceUrl: true } : {}) },
      step: rotate ? '已受理重新合并并更换本机资源地址' : '已受理重新合并',
    }),
  );
  if (duplicate) return acceptedOf(op, true);
  deps.kick();
  engine.emit({ operations: [op.id] });
  return acceptedOf(op, false);
}

// ---------- 更换本机资源地址 ----------

/** 已准备好的新地址：新令牌（本机资料中的新引用）与在新端口监听、提供已提交版本的资源服务；工作配置尚未改写。 */
interface PreparedRotation {
  oldHost: ResourceHost;
  oldRef: string;
  host: ResourceHost;
  ref: string;
  port: number;
  /** 节点组定义指向新地址的候选全文。 */
  candidateText: string;
}

/**
 * 准备更换地址（写入工作配置之前）：在下一个引用生成新令牌；旧的资源服务先拒绝令牌（不再答复 200，两者共用审计序号）；新令牌
 * 的资源服务提供已提交版本（门槛与摘要规则同启动），按首次选定端口的规则在新端口监听（避开 [General] 中的端口、配置与 Surge
 * 外部资源中出现的回环端口与当前端口）。任何一步失败都撤销（关闭新的资源服务、删除新令牌、旧的恢复原状）。
 */
async function prepareRotation(engine: Engine, candidateText: string): Promise<PreparedRotation> {
  const { repos } = engine;
  const oldHost = engine.resource!;
  const oldRef = repos.meta.resourceTokenRef();
  if (oldRef === null) throw new SfeError('SECRET_STORE_FAILED', '重新合并失败：本机资源服务的读取令牌引用读不到，未更换本机资源地址', { details: { reason: 'not_found' } });
  const excluded = new Set<number>([...generalPorts(candidateText), ...loopbackPortsIn(candidateText)]);
  const oldPort = repos.settings.get('resourcePort');
  if (oldPort !== null) excluded.add(oldPort);
  try {
    for (const r of await engine.surge.listExternalResources()) {
      const p = loopbackPortOfLocation(r.location);
      if (p !== null) excluded.add(p);
    }
  } catch {
    throw new SfeError('SURGE_UNREACHABLE', '重新合并失败：读取外部资源失败，未更换本机资源地址');
  }
  const { ref, token } = await rotateResourceToken(engine.store, repos.meta);
  oldHost.setRefuseToken(true);
  let host: ResourceHost | null = null;
  try {
    host = createEngineResourceHost(engine, token);
    if (!(await serveCommittedOn(engine, host)) && readServedPointer(engine.kv) === null) {
      throw new SfeError('RESOURCE_SERVER_UNAVAILABLE', '重新合并失败：本机资源服务的已提交版本尚未初始化，未更换本机资源地址');
    }
    const port = await listenOnNewPort(engine, host, excluded);
    if (port === null) {
      throw new SfeError('RESOURCE_SERVER_UNAVAILABLE', '重新合并失败：找不到可用的本机端口，未更换本机资源地址', { details: { reason: 'port_unavailable' } });
    }
    const url = nodeResourceUrl(port, token);
    const text = replaceManagedBlock(candidateText, 'group', loopbackGroupBlockLines(url));
    // 新地址只出现在受管理 group 段中恰好一条 SFE-ROUTE 定义里（--check 的改写同样要求）；段外没有指向新端口的引用
    rewriteLoopbackForCheck(text, resourceBody(0, []), url);
    const foreign = findForeignSfeObjects(text, { names: [ROUTE_GROUP_NAME], files: Object.values(ENTRY_RULESET_FILES), resourceUrl: url }).filter(
      (o) => o.kind === 'resource_reference' && o.name.endsWith(`:${port}`),
    );
    if (foreign.length > 0) throw new SfeError('NAME_COLLISION', '重新合并失败：工作配置中已有指向新端口的引用，未更换本机资源地址');
    return { oldHost, oldRef, host, ref, port, candidateText: text };
  } catch (err) {
    await discardRotation(engine, { oldHost, host, ref });
    throw err;
  }
}

/** 撤销尚未提交的更换：关闭新的资源服务、删除新令牌；旧的资源服务按令牌可疑记录恢复是否拒绝令牌。 */
async function discardRotation(engine: Engine, r: { oldHost: ResourceHost; host: ResourceHost | null; ref: string }): Promise<void> {
  await r.host?.close().catch(() => undefined);
  r.oldHost.setRefuseToken(readTokenSuspect(engine.kv) !== null);
  try {
    await engine.store.delete(r.ref);
  } catch {
    // 启动时清除（node-resource.ts sweepStaleResourceTokens）
    engine.log('warn', 'resource.rotation_token_delete_failed');
  }
  engine.log('warn', 'resource.rotation_discarded');
}

/**
 * 提交更换（工作配置已写入并已重载）：一个事务记下新令牌引用与端口、清除令牌可疑、要求刷新，并删除旧资源的审计状态（新地址在
 * Surge 中是新的资源，第一次审计按它初始化），删除令牌可疑期间停泊的系统刷新的记录；之后换上新的资源服务（旧的关闭，旧地址的
 * 请求再也得不到 200）、删除旧令牌的值。
 */
async function commitRotation(engine: Engine, op: OperationRecord, r: PreparedRotation): Promise<void> {
  const { repos, kv } = engine;
  try {
    repos.tx(() => {
      repos.meta.setResourceTokenRef(r.ref);
      repos.settings.setResourcePort(r.port);
      writeTokenSuspect(kv, null);
      writeAuditState(kv, null);
      if (readNeedsRefresh(kv) === null) writeNeedsRefresh(kv, { generation: readServedPointer(kv)?.committed.generation ?? 0, reason: 'rotate' });
      // 令牌可疑期间排入的系统刷新停泊在 token_suspect：删除它的记录，之后需要时可以重新自动排入（新地址由排入的强制刷新发布核对）
      kv.delete(SYSTEM_REFRESH_KEY);
    });
  } catch (err) {
    await discardRotation(engine, r);
    throw err;
  }
  await adoptResourceHost(engine, r.host);
  r.host.setRefuseToken(false);
  engine.resourceRuntime.listenEpoch++;
  engine.resourceRuntime.listenError = null;
  try {
    await engine.store.delete(r.oldRef);
  } catch {
    engine.log('warn', 'resource.old_token_delete_failed');
  }
  engine.log('info', 'resource.rotated');
  engine.step(op.id, '已更换本机资源地址：新的读取令牌与端口已生效；旧端口不再监听，旧读取令牌在新地址一律得到 404');
}

// ---------- 旧的本地节点文件 ----------

/**
 * 删除 D7 留下的本地节点文件之前的读回（只读 Surge）：回环地址上恰好一个节点组资源且就是本服务当前地址的远端资源、没有
 * 资源错误且已下载、SFE-ROUTE 成员等于已提交版本，并且 Surge 不再载入任何 sfe-nodes.list 文件。返回不满足的原因；满足为 null。
 * 同一配置重载之后新地址的资源不会立即登记、下载也需要时间（2026-10-25 回环矩阵）：在 resourceUpdateWait 的时限内等它登记、
 * 不在更新中且已下载，再下结论。
 */
async function legacyCleanupReadback(engine: Engine): Promise<string | null> {
  const url = engine.resourceUrl();
  if (url === null) return '本机资源服务地址未知';
  if (!engine.facts.reachable || engine.facts.onWorkingProfile !== true) return 'Surge 不可达或当前配置不是工作配置';
  const { timeoutMs, pollMs } = engine.resourceUpdateWait();
  const started = engine.now().getTime();
  let list: SurgeExternalResource[];
  let found: ReturnType<typeof findOurResource>;
  for (;;) {
    try {
      list = await engine.surge.listExternalResources();
    } catch {
      return '读取外部资源失败';
    }
    found = findOurResource(list, url);
    const settled = found.resource !== null && found.resource.updating !== true && resourceErrorOf(found.resource) === null;
    const elapsed = engine.now().getTime() - started;
    if (settled || found.problem === 'resource_ambiguous' || found.problem === 'resource_foreign' || elapsed >= timeoutMs) break;
    await new Promise<void>((done) => {
      engine.clock.setTimeout(done, Math.max(1, Math.min(pollMs, timeoutMs - elapsed)));
    });
  }
  // 回环地址上的节点组资源恰好一个且就是本服务的（回环地址上的规则集不能为 SFE-ROUTE 提供节点，不计）
  const loopback = list.filter((r) => r.type === 'policy-group' && loopbackPortOfLocation(r.location) !== null);
  if (found.resource === null || loopback.length !== 1) return 'Surge 中指向本机资源服务的节点组资源不是恰好一个';
  if (resourceErrorOf(found.resource) !== null) return 'Surge 报告本应用的节点资源有错误或尚未下载';
  if (list.some((r) => r !== found.resource && /(^|[/\\])sfe-nodes\.list$/i.test(r.location))) return 'Surge 仍载入着本地节点文件';
  let members: string[];
  try {
    members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
  } catch {
    return '读取 SFE-ROUTE 成员失败';
  }
  if (!membersMatchCommitted(members, committedNodeNames(engine))) return 'SFE-ROUTE 的成员与已提交版本不同';
  return null;
}

/**
 * 改用本机资源服务之后清除 D7 留下的本地节点文件（其中有明文买家代理凭据）：文件已不在时立即清除记录；否则只在读回确认
 * （legacyCleanupReadback）之后、且文件是普通文件、带密钥摘要等于 managed_objects 的记录时删除，再把记录标为 removed、摘要
 * 'scrubbed'。从不写 sfe-nodes.list。
 */
async function cleanupLegacyResourceFile(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  const rec = legacyResourceRecord(engine);
  if (rec === null) return;
  const files = engine.profileFiles()!;
  const scrub = () => repos.managedObjects.setState('resource_file', NODE_RESOURCE_FILE, 'removed', { contentDigest: 'scrubbed' });
  let digest: string | null;
  try {
    digest = await files.digest(NODE_RESOURCE_FILE);
  } catch {
    engine.step(op.id, '旧的本地节点文件 sfe-nodes.list 无法读取：暂不删除，下一次重新合并时再处理');
    return;
  }
  if (digest === null) {
    scrub();
    engine.step(op.id, '旧的本地节点文件 sfe-nodes.list 已不存在：已清除它的记录');
    return;
  }
  const verdict = await legacyCleanupReadback(engine);
  if (verdict !== null) {
    engine.step(op.id, `旧的本地节点文件 sfe-nodes.list 暂不删除：${verdict}；节点资源经确认之后由下一次重新合并删除`);
    return;
  }
  const path = join(files.directory, NODE_RESOURCE_FILE);
  let regular = false;
  try {
    const st = await lstat(path);
    regular = st.isFile() && !st.isSymbolicLink();
  } catch {
    regular = false;
  }
  if (!regular || digest !== rec.contentDigest || (await files.digest(NODE_RESOURCE_FILE).catch(() => null)) !== rec.contentDigest) {
    engine.step(op.id, '旧的本地节点文件 sfe-nodes.list 与本应用的记录不一致（可能被修改或替换），未删除；其中可能有买家代理凭据，请检查后自行删除');
    return;
  }
  try {
    await unlink(path);
  } catch {
    engine.step(op.id, '删除旧的本地节点文件 sfe-nodes.list 失败：下一次重新合并时再处理');
    return;
  }
  scrub();
  engine.step(op.id, '已删除旧的本地节点文件 sfe-nodes.list；Surge 自己缓存的节点资源中仍有已部署代理的凭据（缓存位置待 P0 loopback_resource_auth 记录）');
}

// ---------- 执行 ----------

/**
 * 执行重新合并。enqueuePublish 排入一次强制刷新的节点资源发布（没有目标环境：只重新提供并核对已部署的节点），已有排队或执行中的
 * 发布时不另排（needsRefresh 让它单 key 更新并读回），返回是否排入。
 */
export async function runRemerge(engine: Engine, op: OperationRecord, enqueuePublish: () => boolean): Promise<void> {
  const { repos, kv } = engine;
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始重新合并：重新核对预览');
  try {
    const rotate = payloadOf(op).rotateResourceUrl === true;
    const plan = await buildRemergePlan(engine, { rotate });
    requirePreviewCheck(engine, op, plan.response.preview_digest, '重新合并', '重新合并失败：工作配置或本应用文件已变化，请重新预览');
    if (plan.blocking) throw new SfeError(plan.blocking.code, plan.blocking.message);
    // 重载之前：节点资源指针没有候选版本
    assertNoCandidate(engine, '重新合并');
    const files = engine.profileFiles()!;
    const wp = engine.workingProfile()!;
    const before = { ...engine.facts.takeover };
    engine.updateOp(op.id, { phase: 'DEPLOYING' }, '备份当前工作配置');
    await backup(engine, 'remerge', wp.path, plan.currentText, plan.directory);
    const res = plan.resource;
    const restore = res.mode === 'loopback' && res.reasons.length > 0;
    if (restore) {
      // 重载之前：本机资源服务重新提供已提交版本（resourceServe 门槛与摘要规则同启动），Surge 重载之后下载到的是它；并先记下刷新
      // 要求（之后任何中断都会让下一次发布单 key 更新并读回）
      await serveCommittedGeneration(engine);
      if (readNeedsRefresh(kv) === null) writeNeedsRefresh(kv, { generation: readServedPointer(kv)?.committed.generation ?? 0, reason: 'remerge' });
    } else if (res.mode === 'legacy_kept') {
      engine.step(op.id, LEGACY_LINE_KEPT_TEXT);
    }
    let candidateText = plan.candidateText;
    const rotation = res.mode === 'loopback' && res.rotate ? await prepareRotation(engine, plan.candidateText) : null;
    if (rotation) {
      candidateText = rotation.candidateText;
      engine.step(op.id, '已生成新的读取令牌并在新的本机端口提供已提交版本');
    }
    if (candidateText !== plan.currentText) {
      try {
        await files.writeAtomic(plan.profileFile, candidateText, files.digestContent(plan.currentText));
      } catch (err) {
        if (rotation) await discardRotation(engine, rotation);
        throw err;
      }
      engine.step(op.id, '已写入受管理段');
      const runtimeBefore = await readRuntimeSample(engine.surge);
      if (engine.facts.autoReload !== true) {
        // 经用户确认的同一配置重载（只有维护处理器能调用）
        engine.step(op.id, `重载同一工作配置：${RELOAD_FULL_RESTART_NOTICE}`);
        try {
          await engine.maintenanceSurge.reloadProfile();
        } catch (err) {
          // 更换地址：重载失败时 Surge 仍是旧地址，工作配置改回原文，新地址作废（旧地址与令牌可疑记录保持）
          if (rotation) {
            await files.writeAtomic(plan.profileFile, plan.currentText, files.digestContent(candidateText)).catch(() => engine.log('error', 'remerge.rotation_restore_failed'));
            await discardRotation(engine, rotation);
          }
          throw err;
        }
        engine.step(op.id, '已重载同一工作配置');
      } else {
        engine.step(op.id, '自动重载已开启：由 Surge 自动加载同一配置');
      }
      // Surge 已载入新地址：先提交更换（之后的读回不一致只让操作失败，不再撤回新地址）
      if (rotation) await commitRotation(engine, op, rotation);
      await engine.readBasicFacts();
      const runtimeAfter = await readRuntimeSample(engine.surge);
      engine.step(op.id, reloadRestartReport(runtimeBefore, runtimeAfter));
      const after = engine.facts.takeover;
      if (after.enhancedMode !== before.enhancedMode || after.systemProxy !== before.systemProxy || after.outboundMode !== before.outboundMode) {
        throw new SfeError('READBACK_MISMATCH', '重新合并读回不一致：接管、系统代理或出站模式在重载后发生变化，请检查 Surge');
      }
      if (engine.facts.onWorkingProfile !== true) throw new SfeError('EXTERNAL_PROFILE', '重新合并读回不一致：Surge 当前配置不是固定工作配置');
    }
    const parsed = parseProfile(candidateText);
    repos.tx(() => {
      for (const name of ['group', 'entry'] as const) {
        const block = findManagedBlock(parsed, name);
        if (typeof block !== 'object') continue;
        const d = segmentDigest(files.digestContent, name, block.version, block.lines);
        repos.managedObjects.upsertIntent({ kind: SEGMENT_KIND[name], identity: name, contentDigest: d, state: 'pending_add', createdByOperation: op.id });
        repos.managedObjects.setState(SEGMENT_KIND[name], name, 'present', { contentDigest: d });
      }
    });
    await readGroupLine(engine);
    // 入口规则集（入口为 NORMAL）：恢复为占位内容
    for (const [name, content] of plan.restoreEntry) {
      const cur = await files.digest(name);
      if (cur === null) await createExclusivePrivateFile(join(plan.directory, name), content);
      else await files.writeAtomic(name, content, cur);
      const d = await files.digest(name);
      repos.managedObjects.upsertIntent({ kind: 'entry_ruleset_file', identity: name, contentDigest: d, state: 'pending_add', createdByOperation: op.id });
      repos.managedObjects.setState('entry_ruleset_file', name, 'present', { contentDigest: d });
    }
    if (res.mode === 'loopback') {
      // 节点资源（D10）：从不写本地节点文件。需要时重新提供已提交版本并排入一次节点资源发布（单 key 更新并读回）
      if (restore) {
        await serveCommittedGeneration(engine);
        if (readNeedsRefresh(kv) === null) writeNeedsRefresh(kv, { generation: readServedPointer(kv)?.committed.generation ?? 0, reason: 'remerge' });
        engine.step(
          op.id,
          enqueuePublish()
            ? '已重新提供节点资源的已提交版本，并排入一次节点资源发布（只对本应用的资源单 key 更新并读回；发布门槛不满足时保持待部署）'
            : '已重新提供节点资源的已提交版本；已排队的节点资源发布会对本应用的资源单 key 更新并读回',
        );
      }
      if (res.legacyCleanup) await cleanupLegacyResourceFile(engine, op);
    }
    // 受管理段恢复后，清除“被修改”警告需要用户重新激活；这里只记录结果
    engine.updateOp(op.id, { phase: 'COMPLETED', status: 'succeeded' }, '重新合并完成', { surge: true });
  } catch (err) {
    const body = engine.errorBody(err, '重新合并失败：内部错误');
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
  }
}
