// 候选配置校验（docs/ARCHITECTURE.md §5.6、§6.2 第 2 步）：在 <数据目录>/tmp（0700）下新建本次专用目录，
// 写入工作配置副本（O_EXCL 0600），按相对引用逐个解析：本应用文件（节点资源、入口规则集）指向候选副本，
// 其余用符号链接指向真实文件；任何引用无法解析即失败。然后 --check，无论成败都删除整个目录。
// 步骤中只记录路径，不记录内容。

import { mkdtemp, rm, symlink, mkdir, stat } from 'node:fs/promises';
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

export async function checkCandidate(engine: Engine, input: CandidateInput): Promise<CandidateResult> {
  const tmpRoot = engine.deps.paths.tmpDir;
  await ensurePrivateDir(tmpRoot);
  const dir = await mkdtemp(join(tmpRoot, 'candidate-'));
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
