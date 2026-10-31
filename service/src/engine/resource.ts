// 节点资源的生成（docs/ARCHITECTURE.md §5.4）：按清单读取本机秘密资料中的代理凭据（读到即登记到脱敏器），
// 经受控序列化生成每一行。生成错误按条目返回，调用方决定排除该条目还是整体失败。

import { SfeError, type ApiErrorBody } from '@sfe/contract';
import type { DeploymentRecord, FrontProxyRecord, NodeManifestEntry, ProxyRevisionRecord } from '../db/index.js';
import { nodeLine, resourceBody, resourceFile } from '../surge/generate.js';
import { parseProxyLine } from '../surge/proxy-line.js';
import { isCommentLine } from '../surge/rules.js';
import type { Engine } from './context.js';

export interface ResourceEntry {
  environmentId: string;
  proxyRevision: number;
  revision: ProxyRevisionRecord;
}

export interface GeneratedResource {
  content: string;
  lines: string[];
  manifest: NodeManifestEntry[];
  /** 生成失败的条目（键为 environmentId:revision）。 */
  errors: Map<string, ApiErrorBody>;
}

export const entryKey = (environmentId: string, revision: number): string => `${environmentId}:${revision}`;

async function readSecret(engine: Engine, ref: string | null): Promise<string | null> {
  if (ref === null) return null;
  const value = await engine.store.get(ref);
  if (value === null) {
    throw new SfeError('SECRET_STORE_FAILED', '读取代理凭据失败：本机后台资料中找不到该项', { details: { reason: 'not_found' } });
  }
  engine.scrubber.register(value);
  return value;
}

/** 按条目顺序生成资源文件；条目失败不影响其他条目（结果中不含失败条目）。 */
export async function generateResource(
  engine: Engine,
  generation: number,
  entries: readonly ResourceEntry[],
  fronts: ReadonlyMap<string, FrontProxyRecord>,
): Promise<GeneratedResource> {
  const lines: string[] = [];
  const manifest: NodeManifestEntry[] = [];
  const errors = new Map<string, ApiErrorBody>();
  for (const e of entries) {
    const key = entryKey(e.environmentId, e.proxyRevision);
    try {
      const front = fronts.get(e.revision.frontProxyId);
      if (!front || front.retired) throw new SfeError('FRONT_PROXY_MISSING', '生成节点失败：前置代理未登记或已停用');
      const username = await readSecret(engine, e.revision.usernameRef);
      const password = await readSecret(engine, e.revision.passwordRef);
      lines.push(nodeLine({ name: e.revision.nodeName, host: e.revision.host, port: e.revision.port, username, password, front: front.surgeName }));
      manifest.push({ nodeName: e.revision.nodeName, environmentId: e.environmentId, proxyRevision: e.proxyRevision });
    } catch (err) {
      errors.set(key, engine.errorBody(err, '生成节点失败：内部错误'));
    }
  }
  return { content: resourceFile(generation, lines), lines, manifest, errors };
}

/** 资源文件中的节点名（逐行解析，注释与无法解析的行忽略）。 */
export function resourceNodeNames(content: string | null): string[] {
  if (!content) return [];
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (isCommentLine(line)) continue;
    const p = parseProxyLine(line);
    if (p) out.push(p.name);
  }
  return out;
}

/** 逐节点核对：生成的内容解析回来的节点名与清单完全一致（数量、顺序、无重复）。 */
export function manifestMatches(content: string, manifest: readonly NodeManifestEntry[]): boolean {
  const names = resourceNodeNames(content);
  if (names.length !== manifest.length) return false;
  if (new Set(names).size !== names.length) return false;
  return names.every((n, i) => n === manifest[i]!.nodeName);
}

/**
 * 按某次发布的清单重建本机资源服务提供的内容（D10，resourceBody：没有节点时只含占位行），并与发布记录的摘要核对
 * （工作配置目录文件密钥下的 HMAC，profileFiles().digestContent；D10 的发布按 resourceBody 的内容记录）。没有节点的 D7 发布
 * 记下的是不含占位行的 resourceFile 内容：同样接受，提供的仍是带占位行的 resourceBody（不含任何凭据）。版本或凭据已回收、
 * 前置不可用、摘要不一致（含已清除的 'scrubbed'）、工作配置未初始化或 pepper 未加载时为 null——调用方不提供这一代
 * （503）并要求刷新，从不提供与记录不一致的内容。读到的凭据登记到脱敏器（generateResource）。
 */
export async function regenerateResourceBody(engine: Engine, d: DeploymentRecord): Promise<string | null> {
  const files = engine.profileFiles();
  if (!files) return null;
  const fronts = new Map<string, FrontProxyRecord>(engine.repos.frontProxies.list().map((f) => [f.id, f]));
  const entries: ResourceEntry[] = [];
  for (const m of d.nodeManifest) {
    const rev = engine.repos.proxyRevisions.get(m.environmentId, m.proxyRevision);
    if (!rev) return null;
    entries.push({ environmentId: m.environmentId, proxyRevision: m.proxyRevision, revision: rev });
  }
  const g = await generateResource(engine, d.generation, entries, fronts);
  if (g.errors.size > 0 || !manifestMatches(resourceFile(d.generation, g.lines), d.nodeManifest)) return null;
  const body = resourceBody(d.generation, g.lines);
  if (files.digestContent(body) === d.resourceDigest) return body;
  if (g.lines.length === 0 && files.digestContent(resourceFile(d.generation, [])) === d.resourceDigest) return body;
  return null;
}
