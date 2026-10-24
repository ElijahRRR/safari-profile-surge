// sfe import --commit 的逐行决定：create 行 → 新建；update 行 → 按预览中的当前版本更新；同名冲突行必须由
// --resolve 明确选择（从不按名称自动更新）；unchanged 与 invalid 行不提交。--resolve 可以覆盖任何可提交行。

import type { ImportPreview, ImportRowDecision, ImportRowPreview } from '@sfe/contract';
import { UsageError } from './args.js';
import { clean } from './format.js';

export type ResolveSpec = { row: number; action: 'create' } | { row: number; action: 'skip' } | { row: number; action: 'update'; environmentId: string };

const ENV_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** `<row>:create` | `<row>:skip` | `<row>:update:<envId>` */
export function parseResolve(spec: string): ResolveSpec {
  const m = /^(\d{1,7}):(create|skip|update)(?::(.+))?$/.exec(spec);
  if (!m) throw new UsageError(`--resolve 格式不正确：应为 <行号>:create、<行号>:skip 或 <行号>:update:<环境编号>`);
  const row = Number(m[1]);
  const action = m[2] as 'create' | 'skip' | 'update';
  if (action === 'update') {
    const environmentId = m[3];
    if (!environmentId || !ENV_ID_RE.test(environmentId)) throw new UsageError(`--resolve ${row}:update 缺少环境编号或格式不正确`);
    return { row, action, environmentId };
  }
  if (m[3] !== undefined) throw new UsageError(`--resolve ${row}:${action} 不接受环境编号`);
  return { row, action };
}

export function parseResolves(specs: readonly string[]): Map<number, ResolveSpec> {
  const map = new Map<number, ResolveSpec>();
  for (const s of specs) {
    const r = parseResolve(s);
    if (map.has(r.row)) throw new UsageError(`第 ${r.row} 行的 --resolve 重复`);
    map.set(r.row, r);
  }
  return map;
}

export interface ImportDecisionPlan {
  decisions: ImportRowDecision[];
  /** 需要 --resolve 的同名冲突行。 */
  unresolved: ImportRowPreview[];
}

function updateRevision(row: ImportRowPreview, environmentId: string): number {
  if (row.environment_id === environmentId && row.current_revision !== null && row.status !== 'conflict') return row.current_revision;
  const candidate = row.conflictCandidates?.find((c) => c.environment_id === environmentId);
  if (candidate) return candidate.revision;
  throw new UsageError(`第 ${row.row} 行：环境 ${environmentId} 不是这一行可以更新的环境`);
}

export function buildImportDecisions(preview: ImportPreview, resolves: Map<number, ResolveSpec>): ImportDecisionPlan {
  const byRow = new Map(preview.rows.map((r) => [r.row, r]));
  for (const row of resolves.keys()) {
    if (!byRow.has(row)) throw new UsageError(`--resolve 指定的第 ${row} 行不在预览中`);
  }
  const decisions: ImportRowDecision[] = [];
  const unresolved: ImportRowPreview[] = [];
  for (const row of preview.rows) {
    const r = resolves.get(row.row);
    if (r) {
      if (r.action === 'skip') {
        if (row.status !== 'invalid' && row.status !== 'unchanged') decisions.push({ row: row.row, action: 'skip' });
        continue;
      }
      if (row.status === 'invalid' || row.status === 'unchanged') {
        throw new UsageError(`第 ${row.row} 行${row.status === 'invalid' ? '无效' : '没有变化'}，不能 ${r.action}`);
      }
      if (r.action === 'create') decisions.push({ row: row.row, action: 'create' });
      else decisions.push({ row: row.row, action: 'update', environment_id: r.environmentId, expected_revision: updateRevision(row, r.environmentId) });
      continue;
    }
    switch (row.status) {
      case 'create':
        decisions.push({ row: row.row, action: 'create' });
        break;
      case 'update':
        if (row.environment_id === null || row.current_revision === null) throw new UsageError(`第 ${row.row} 行缺少环境编号或当前版本，请重新预览`);
        decisions.push({ row: row.row, action: 'update', environment_id: row.environment_id, expected_revision: row.current_revision });
        break;
      case 'conflict':
        unresolved.push(row);
        break;
      default:
        break;
    }
  }
  return { decisions, unresolved };
}

/** 冲突行的提示：列出可选的 --resolve 写法。 */
export function describeUnresolved(rows: readonly ImportRowPreview[]): string {
  const lines = ['以下行与已有环境或同批其他行同名，需要逐行选择后再提交：'];
  for (const r of rows) {
    const name = r.displayName ? clean(r.displayName) : '（无名称）';
    lines.push(`  第 ${r.row} 行「${name}」：`);
    lines.push(`    --resolve ${r.row}:skip      跳过`);
    lines.push(`    --resolve ${r.row}:create    作为新环境创建`);
    for (const c of r.conflictCandidates ?? []) lines.push(`    --resolve ${r.row}:update:${clean(c.environment_id)}    更新「${clean(c.label)}」（版本 ${c.revision}）`);
  }
  return lines.join('\n') + '\n';
}
