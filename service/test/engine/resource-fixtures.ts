// 本机资源服务（D10）测试用的小工具：只用合成数据。commitNodes 模拟一次经确认的回环发布（提供候选版本 → Surge 单 key 更新
// → 读回匹配审计记录 → 提交指针并确认），供路由与对账测试在 loopback 夹具中得到已部署、可激活的节点；它不是产品的发布流程。
// legacyDeployNodes 模拟 D10 之前（D7）部署的节点：写入本地 sfe-nodes.list、Surge 重新加载，只用于 legacy 夹具。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_RESOURCE_FILE } from '@sfe/contract';
import type { ResourceResponse } from '../../src/resource/index.js';
import { matchAuditRecord, writeServedPointer } from '../../src/resource/index.js';
import { confirmNodeResource } from '../../src/engine/node-resource.js';
import { generateResource, type ResourceEntry } from '../../src/engine/resource.js';
import { loopbackResourceRequest } from '../../src/surge/fake.js';
import { resourceBody, resourceFile } from '../../src/surge/generate.js';
import type { Harness } from './harness.js';

/** 本服务地址的一次下载（与 FakeSurge 发出的请求相同：唯一的 Host、回环地址）；地址为 null 时抛错。 */
export function fetchResource(h: Harness): ResourceResponse {
  const url = h.resourceUrl();
  if (url === null) throw new Error('no resource url');
  const target = loopbackResourceRequest(url)!;
  return h.binder.request(target.port, target.request);
}

/** FakeSurge 中本服务资源的当前状态。 */
export async function ourResource(h: Harness) {
  const key = h.resourceKey();
  const list = await h.fake.listExternalResources();
  return list.find((r) => r.key === key) ?? null;
}

/**
 * 让资源服务提供 body（作为候选版本 generation），并让 Surge 单 key 更新一次（直接调用 FakeSurge，不经引擎）。返回 auditMark。
 * 之后由调用方决定提交（commitNodes）还是撤回（host.revertToCommitted）。
 */
export async function serveAndFetch(h: Harness, generation: number, body: string): Promise<number> {
  const host = h.app.engine.resource!;
  const mark = host.auditMark();
  host.stageCandidate({ generation, content: body });
  await h.fake.updateExternalResource(h.resourceKey()!);
  return mark;
}

/**
 * 模拟一次经确认的发布：按各环境的期望版本生成节点资源（新的配置代数，verified 发布记录，摘要按 resourceBody 的内容）、提供并
 * 让 Surge 下载、读回匹配审计记录之后在一个事务中提交指针并 confirmNodeResource、资源服务提交候选版本，最后把环境记为已部署。
 */
export async function commitNodes(h: Harness, envIds: readonly string[]): Promise<number> {
  const engine = h.app.engine;
  const { repos } = h;
  const entries: ResourceEntry[] = envIds.map((id) => {
    const env = repos.environments.get(id)!;
    const revision = repos.proxyRevisions.get(id, env.desiredProxyRevision!)!;
    return { environmentId: id, proxyRevision: revision.revision, revision };
  });
  const fronts = new Map(repos.frontProxies.list().map((f) => [f.id, f]));
  const generation = repos.meta.bumpConfigurationGeneration();
  const g = await generateResource(engine, generation, entries, fronts);
  if (g.errors.size > 0) throw new Error('commitNodes: generation failed');
  const body = resourceBody(generation, g.lines);
  repos.deployments.insert({
    generation,
    workingProfileDigest: null,
    resourceDigest: h.files.digestContent(body),
    nodeManifest: g.manifest,
    selectionBefore: null,
    state: 'verified',
    operationId: null,
  });
  const mark = await serveAndFetch(h, generation, body);
  const r = await ourResource(h);
  if (!r || r.lastUpdatedAt === null || r.error !== null) throw new Error('commitNodes: Surge did not load the candidate');
  const matched = matchAuditRecord(engine.resource!.audit(), r.lastUpdatedAt, engine.resourceAuditToleranceMs(), mark, generation);
  if (!matched) throw new Error('commitNodes: no matching audit record');
  repos.tx(() => {
    writeServedPointer(engine.kv, { committed: { generation }, candidate: null });
    confirmNodeResource(engine, { generation, matchedSeq: matched.seq, snapshot: { updatedAt: r.lastUpdatedAt, error: r.error }, clearNeedsRefresh: true });
  });
  engine.resource!.commitCandidate();
  for (const e of entries) repos.environments.update(e.environmentId, { deployedProxyRevision: e.proxyRevision });
  return generation;
}

/**
 * legacy 夹具（工作配置仍是 D7 的本地 sfe-nodes.list 组行）：如同升级之前已部署——按各环境的期望版本写入本地节点文件、Surge
 * 重新加载配置（读到文件中的节点），记一条 verified 发布并把环境记为已部署。D10 的发布在这种工作配置上停泊（需要重新合并）。
 */
export async function legacyDeployNodes(h: Harness, envIds: readonly string[]): Promise<number> {
  const engine = h.app.engine;
  const { repos } = h;
  const entries: ResourceEntry[] = envIds.map((id) => {
    const env = repos.environments.get(id)!;
    const revision = repos.proxyRevisions.get(id, env.desiredProxyRevision!)!;
    return { environmentId: id, proxyRevision: revision.revision, revision };
  });
  const fronts = new Map(repos.frontProxies.list().map((f) => [f.id, f]));
  const generation = repos.meta.bumpConfigurationGeneration();
  const g = await generateResource(engine, generation, entries, fronts);
  if (g.errors.size > 0) throw new Error('legacyDeployNodes: generation failed');
  const content = resourceFile(generation, g.lines);
  writeFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), content, { mode: 0o600 });
  await h.fake.reloadProfile();
  repos.deployments.insert({ generation, workingProfileDigest: null, resourceDigest: h.files.digestContent(content), nodeManifest: g.manifest, selectionBefore: null, state: 'verified', operationId: null });
  for (const e of entries) {
    repos.proxyRevisions.updateState(e.environmentId, e.proxyRevision, 'deployed');
    repos.environments.update(e.environmentId, { deployedProxyRevision: e.proxyRevision });
  }
  return generation;
}
