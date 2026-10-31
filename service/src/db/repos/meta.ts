// 元数据计数器：环境编号、站内序号、配置代数、事件序号、pepper 是否已创建，以及本机资源服务当前读取令牌的引用。
// 计数器单调递增、从不回收（删除环境后编号也不复用），每次递增是一条原子语句。

import type { RepoContext } from './common.js';

export interface MetaRepo {
  /** 下一个环境稳定编号（从 1 开始；首次使用时从现有最大编号之后开始）。 */
  nextEnvironmentSeq(): number;
  /** 指定站点的下一个站内序号（US01、US02…）。 */
  nextSiteSeq(site: string): number;
  configurationGeneration(): number;
  /** 递增并返回新的配置代数。 */
  bumpConfigurationGeneration(): number;
  eventSequence(): number;
  setEventSequence(n: number): void;
  /** 本机秘密资料中的 pepper 是否曾经创建过：为 true 而读不到时必须 fail closed，不能重新生成。 */
  pepperCreated(): boolean;
  markPepperCreated(): void;
  /**
   * 本机资源服务（D10）当前读取令牌在秘密存储中的引用（sfe.resource-token.<n>）；从未创建为 null。为非 null 而读不到值时
   * 必须 fail closed，不能重新生成（resource/token.ts）。轮换创建新引用，由调用方在工作配置改写提交之后改写这里。
   */
  resourceTokenRef(): string | null;
  setResourceTokenRef(ref: string): void;
  schemaVersion(): number;
}

const RESOURCE_TOKEN_REF_KEY = 'resource_token_ref';
const RESOURCE_TOKEN_REF_RE = /^sfe\.resource-token\.[1-9][0-9]{0,8}$/;

export function createMetaRepo(ctx: RepoContext): MetaRepo {
  const { db } = ctx;
  const getInt = (key: string): number => {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    const n = row ? Number(row.value) : 0;
    return Number.isSafeInteger(n) ? n : 0;
  };
  const setInt = (key: string, n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`invalid meta value for ${key}`);
    db.run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(n)]);
  };
  const increment = (key: string, initialSql: string, params: string[]): number => {
    const row = db.get<{ value: string }>(
      `INSERT INTO meta(key, value) VALUES(?, CAST((${initialSql}) AS TEXT))
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
       RETURNING value`,
      [key, ...params],
    );
    return Number(row!.value);
  };
  return {
    nextEnvironmentSeq: () => increment('environment_seq', 'SELECT COALESCE(MAX(seq), 0) + 1 FROM environments', []),
    nextSiteSeq: (site) =>
      increment(
        `site_seq:${site}`,
        'SELECT COALESCE(MAX(CAST(substr(node_tag, length(?) + 1) AS INTEGER)), 0) + 1 FROM environments WHERE site = ?',
        [site, site],
      ),
    configurationGeneration: () => getInt('configuration_generation'),
    bumpConfigurationGeneration: () => increment('configuration_generation', 'SELECT 1', []),
    eventSequence: () => getInt('event_sequence'),
    setEventSequence: (n) => setInt('event_sequence', n),
    pepperCreated: () => getInt('pepper_created') === 1,
    markPepperCreated: () => setInt('pepper_created', 1),
    resourceTokenRef: () => db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [RESOURCE_TOKEN_REF_KEY])?.value ?? null,
    setResourceTokenRef: (ref) => {
      if (typeof ref !== 'string' || !RESOURCE_TOKEN_REF_RE.test(ref)) throw new RangeError('invalid resource token ref');
      db.run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [RESOURCE_TOKEN_REF_KEY, ref]);
    },
    schemaVersion: () => db.schemaVersion(),
  };
}
