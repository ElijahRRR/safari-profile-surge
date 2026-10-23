// 候选配置校验（docs/ARCHITECTURE.md §5.6、§6.2 第 2 步）：在 <数据目录>/tmp（0700）下新建本次专用目录，
// 写入工作配置副本（O_EXCL 0600），按相对引用逐个解析：本应用文件（节点资源、入口规则集）指向候选副本，
// 其余用符号链接指向真实文件；任何引用无法解析即失败。然后 --check，无论成败都删除整个目录；进程在此期间被终止（断电、
// 强制重启、kill -9、崩溃）时 finally 不会执行，启动时由 sweepCandidateDirs 删除遗留的目录。
// 步骤中只记录路径，不记录内容。

import { lstat, mkdtemp, readdir, rm, symlink, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { SfeError } from '@sfe/contract';
import { listRelativeReferences } from '../surge/profile.js';
import { createExclusivePrivateFile, ensurePrivateDir } from '../util/secure-files.js';
import type { Engine } from './context.js';

export interface CandidateInput {
  /** 候选工作配置全文。 */
  profileText: string;
  /** 工作配置文件名（在候选目录中使用同名）。 */
  profileFileName: string;
  /** 真实配置目录（相对引用以它为基准解析）。 */
  sourceDirectory: string;
  /** 本应用文件的候选内容：相对路径 → 内容。 */
  overrides: ReadonlyMap<string, string>;
}

export interface CandidateResult {
  ok: boolean;
  /** 已脱敏的校验输出摘要。 */
  message: string;
  /** 每个引用的解析结果（只含路径）。 */
  resolved: Array<{ reference: string; target: string; kind: 'candidate' | 'linked' }>;
}

function insideBase(base: string, rel: string): string | null {
  const target = resolve(base, rel);
  const r = relative(base, target);
  if (r === '' || r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..')) return null;
  return r;
}

/** 候选目录名前缀（mkdtemp 在其后追加随机字符）。 */
const CANDIDATE_PREFIX = 'candidate-';
const CANDIDATE_DIR_RE = /^candidate-[A-Za-z0-9_-]+$/;

/**
 * 启动时（执行器开始之前，没有 --check 在进行）删除 <数据目录>/tmp 中遗留的候选目录：其中的节点资源副本含明文代理凭据
 * （发布时为全部已发布的买家代理用户名与密码），工作配置副本含用户自己节点的凭据。进程在 --check 期间被终止时
 * checkCandidate 的 finally 不会执行，目录会一直留在数据目录里（及其之后的每一份备份或副本中），之后更换或删除的凭据仍可从
 * 这里读出。只删除名称符合、lstat 为真实目录（不是符号链接）且属于当前用户的条目；tmp 是本服务私有目录，只有一个服务实例。
 * 返回删除的目录名。
 */
export async function sweepCandidateDirs(tmpRoot: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(tmpRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const uid = process.getuid?.();
  const removed: string[] = [];
  for (const name of names) {
    if (!CANDIDATE_DIR_RE.test(name)) continue;
    const full = join(tmpRoot, name);
    let st;
    try {
      st = await lstat(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (uid !== undefined && st.uid !== uid) continue;
    // recursive 删除不跟随目录内的符号链接（只删除链接本身），不会删到真实配置目录中的文件
    await rm(full, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export async function checkCandidate(engine: Engine, input: CandidateInput): Promise<CandidateResult> {
  const tmpRoot = engine.deps.paths.tmpDir;
  await ensurePrivateDir(tmpRoot);
  const dir = await mkdtemp(join(tmpRoot, CANDIDATE_PREFIX));
  const resolved: CandidateResult['resolved'] = [];
  try {
    const profilePath = join(dir, input.profileFileName);
    await createExclusivePrivateFile(profilePath, input.profileText);
    const seen = new Set<string>();
    for (const ref of listRelativeReferences(input.profileText)) {
      if (ref.kind === 'include') continue;
      const rel = insideBase(input.sourceDirectory, ref.value);
      if (rel === null) {
        throw new SfeError('SURGE_CHECK_FAILED', '校验候选配置失败：引用的文件不在配置目录内，无法解析', { details: { reference: ref.value, line: ref.line } });
      }
      const norm = normalize(rel);
      if (seen.has(norm)) continue;
      seen.add(norm);
      const dest = join(dir, norm);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      const override = input.overrides.get(norm);
      if (override !== undefined) {
        await createExclusivePrivateFile(dest, override);
        resolved.push({ reference: ref.value, target: dest, kind: 'candidate' });
        continue;
      }
      const real = resolve(input.sourceDirectory, norm);
      try {
        await stat(real);
      } catch {
        throw new SfeError('SURGE_CHECK_FAILED', '校验候选配置失败：引用的文件不存在', { details: { reference: ref.value, line: ref.line } });
      }
      await symlink(real, dest);
      resolved.push({ reference: ref.value, target: real, kind: 'linked' });
    }
    const result = await engine.surge.checkProfile(profilePath);
    return { ok: result.ok, message: engine.scrubber.scrub(result.message), resolved };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
