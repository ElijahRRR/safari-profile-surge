// 数据库测试夹具：只用合成数据（文档用 IP、example.test）。
import { createRepositories, openDatabase, type Db, type EnvironmentRecord, type ProxyRevisionRecord, type Repositories } from '../../src/db/index.js';
import { FakeClock } from '../../src/util/clock.js';
import { createIdGenerator } from '../../src/util/ids.js';
import type { Scrubber } from '../../src/ports.js';

export const T0 = '2026-10-21T00:00:00.000Z';

export interface TestDb {
  db: Db;
  repos: Repositories;
  clock: FakeClock;
}

export function makeRepos(opts: { path?: string; scrubber?: Scrubber; clock?: FakeClock } = {}): TestDb {
  const clock = opts.clock ?? new FakeClock(T0);
  const db = openDatabase(opts.path ?? ':memory:');
  db.migrate();
  const repos = createRepositories(db, { clock, ids: createIdGenerator({ now: () => clock.now().getTime() }), ...(opts.scrubber ? { scrubber: opts.scrubber } : {}) });
  return { db, repos, clock };
}

export function seedFront(repos: Repositories, id = 'front_01', surgeName = 'HK-01', isDefault = false) {
  return repos.frontProxies.insert({ id, surgeName, state: 'ok', isDefault });
}

let envCounter = 0;
export function seedEnvironment(repos: Repositories, overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  const seq = overrides.seq ?? repos.meta.nextEnvironmentSeq();
  envCounter++;
  return repos.environments.insert({
    id: `env_${String(seq).padStart(4, '0')}_${envCounter}`,
    seq,
    code: `E${String(seq).padStart(4, '0')}`,
    nodeTag: `US${String(seq).padStart(2, '0')}`,
    displayName: `US-买家${String(seq).padStart(2, '0')}`,
    site: 'US',
    autoOpenOrders: true,
    autoFillLogin: false,
    revision: 1,
    desiredProxyRevision: null,
    deployedProxyRevision: null,
    lastVerifiedProxyRevision: null,
    expectedExitIp: null,
    bindingStage: null,
    ...overrides,
  });
}

export function seedRevision(repos: Repositories, env: EnvironmentRecord, revision: number, overrides: Partial<ProxyRevisionRecord> = {}): ProxyRevisionRecord {
  return repos.proxyRevisions.insert({
    environmentId: env.id,
    revision,
    protocol: 'socks5',
    host: '203.0.113.10',
    port: 1080,
    usernameRef: null,
    usernameFp: null,
    passwordRef: null,
    passwordFp: null,
    frontProxyId: 'front_01',
    nodeName: `SFE-N-${env.code}-${env.nodeTag}-v${String(revision).padStart(3, '0')}`,
    state: 'desired',
    ...overrides,
  });
}

let opCounter = 0;
export function seedOperation(repos: Repositories, overrides: Partial<Parameters<Repositories['operations']['insert']>[0]> = {}) {
  const n = ++opCounter;
  return repos.operations.insert({
    id: `op_${n}`,
    requestId: `req_${n}`,
    requestDigest: 'd'.repeat(64),
    kind: 'environment.update',
    initiatorKind: 'web',
    phase: 'SAVED',
    status: 'queued',
    ...overrides,
  });
}
