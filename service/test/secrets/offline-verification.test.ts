// 秘密以明文保存在服务数据库中，pepper 也在同一个数据库里（docs/ARCHITECTURE.md §0「秘密的存放」）：持久保存的任何值都不能
// 由秘密按 pepper 派生的密钥计算，否则拿到数据目录副本的人能离线核对猜测的旧密码（已替换、已清扫的账号密码与代理密码）。
// 只用合成数据。

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { openDatabase } from '../../src/db/index.js';
import { MIGRATIONS } from '../../src/db/schema.js';
import { PEPPER_REF, pepperKey } from '../../src/secrets/pepper.js';
import { entryRuleSetBlockLines, loopbackGroupBlockLines, nodeLine, resourceBody, resourceFile } from '../../src/surge/generate.js';
import { findManagedBlock, parseProfile, replaceManagedBlock } from '../../src/surge/profile.js';
import { deriveKey, hmacHex, keyedRequestDigest, requestDigestParts } from '../../src/util/keyed-digest.js';
import { AGENT, WEB, createEnv, createHarness, envInput, rid, type Harness } from '../engine/harness.js';
import { dropNodesOnNextUpdate } from '../engine/publish-helpers.js';

let h: Harness | undefined;
const cleanup: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 时间机器、迁移或手动复制得到的数据目录副本：sfe.sqlite 及 -wal/-shm。 */
function snapshotCopy(dbPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfe-copy-'));
  cleanup.push(dir);
  const dst = join(dir, 'sfe.sqlite');
  copyFileSync(dbPath, dst);
  for (const s of ['-wal', '-shm']) if (existsSync(dbPath + s)) copyFileSync(dbPath + s, dst + s);
  return dst;
}

const DICT = ['123456', 'P1-Original!', 'Summer2025', 'P2-Summer2025!', 'P3-Current!', 'password', 'synthProxyX1', 'synthProxyX2'];

describe('replaced and swept passwords cannot be verified offline from a copy of the data directory', () => {
  test('request digests, retired revision fingerprints and old deployment digests do not depend on secrets keyed by the pepper', async () => {
    h = await createHarness({ dbFile: true });
    const created = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { login: 'buyer01@example.test', accountPassword: 'P1-Original!', password: 'synthProxyX1' });
    const envId = created.environment_id!;
    const upd = async (changes: unknown): Promise<string> => {
      const env = h!.repos.environments.get(envId)!;
      const id = rid('upd');
      await h!.app.updateEnvironment(envId, { request_id: id, expected_revision: env.revision, changes } as never, WEB);
      await h!.idle();
      return id;
    };
    const p2 = await upd({ account: { password: { action: 'replace', value: 'P2-Summer2025!' } } });
    await upd({ account: { password: { action: 'replace', value: 'P3-Current!' } } });
    await upd({ proxy: { password: { action: 'replace', value: 'synthProxyX2' } } });
    // 之后的一次发布把旧节点移出资源：v001 退役
    await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(h.repos.proxyRevisions.get(envId, 1)!.state).toBe('retired');
    await h.app.engine.secrets.sweep();
    // 生产中 pepper 是同一个 sfe.sqlite 里 secret_values 的一行（本夹具的秘密在内存存储中）
    const pepper = Buffer.from((await h.store.get(PEPPER_REF))!, 'base64url');

    const db = new DatabaseSync(snapshotCopy(join(h.dir, 'sfe.sqlite')), { readOnly: true });
    try {
      const requestKey = pepperKey(pepper, 'request');
      const ops = db.prepare("SELECT request_id, request_digest, kind, environment_id, expected_revision FROM operations WHERE kind IN ('environment.create', 'environment.update')").all() as Array<{
        request_id: string;
        request_digest: string;
        kind: string;
        environment_id: string;
        expected_revision: number;
      }>;
      expect(ops.length).toBeGreaterThanOrEqual(4);
      for (const op of ops) {
        expect(op.request_digest.startsWith('v2:')).toBe(true);
        const [, shape] = op.request_digest.split(':');
        for (const g of DICT) {
          // 按旧格式（秘密值的 pepper 派生 HMAC）重算：从不相等
          const body =
            op.kind === 'environment.update'
              ? { request_id: op.request_id, expected_revision: op.expected_revision, changes: { account: { password: { action: 'replace', value: g } } } }
              : { request_id: op.request_id, environment: envInput('US-Buyer-01', '203.0.113.10', { login: 'buyer01@example.test', accountPassword: g, password: 'synthProxyX1' }) };
          const method = op.kind === 'environment.update' ? 'updateEnvironment' : 'createEnvironment';
          const target = op.kind === 'environment.update' ? op.environment_id : null;
          expect(op.request_digest.includes(keyedRequestDigest(requestKey, { method, target, body }))).toBe(false);
          // 持久保存的 shape 部分与秘密无关：任何猜测算出的都一样，不能用来区分
          const guessShape = requestDigestParts(requestKey, Buffer.alloc(32, 7), { method, target, body }).shape;
          if (op.request_id === p2) expect(guessShape).toBe(shape);
        }
      }
      // 退役版本的指纹已清除；仍在用的版本的指纹对应的是数据库里本来就有明文的当前值
      const fpKey = deriveKey(pepper, 'fp');
      const revs = db.prepare('SELECT revision, state, username_fp, password_fp FROM proxy_revisions WHERE environment_id = ? ORDER BY revision').all(envId) as Array<{
        revision: number;
        state: string;
        username_fp: string | null;
        password_fp: string | null;
      }>;
      const retired = revs.find((r) => r.revision === 1)!;
      expect(retired).toMatchObject({ state: 'retired', username_fp: null, password_fp: null });
      for (const r of revs) expect(r.password_fp === hmacHex(fpKey, 'synthProxyX1')).toBe(false);
      // 含退役版本的旧发布记录：资源摘要已清除
      const deployments = db.prepare('SELECT generation, resource_digest, working_profile_digest, node_manifest FROM deployments').all() as Array<{
        generation: number;
        resource_digest: string;
        working_profile_digest: string | null;
        node_manifest: string;
      }>;
      const withRetired = deployments.filter((d) => (JSON.parse(d.node_manifest) as Array<{ environmentId: string; proxyRevision: number }>).some((m) => m.environmentId === envId && m.proxyRevision === 1));
      expect(withRetired.length).toBeGreaterThan(0);
      for (const d of withRetired) expect(d).toMatchObject({ resource_digest: 'scrubbed', working_profile_digest: null });
    } finally {
      db.close();
    }
  });

  test('a remerge keeps no pepper-keyed digest of the node resource: replaced and swept proxy credentials cannot be checked against the remerge operation or its backup', async () => {
    const OLD_USER = 'synthUserOld01';
    const OLD_PW = 'synthPwOld7788';
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-01', '203.0.113.10', { username: OLD_USER, password: OLD_PW })).environment_id!;
    // 用户在 Surge 中改动了受管理段，之后在网页中重新合并（预览、确认）
    const tampered = readFileSync(h.profilePath, 'utf8').replace(/SFE-ROUTE = select, REJECT, /, 'SFE-ROUTE = select, REJECT, DIRECT, ');
    writeFileSync(h.profilePath, tampered);
    const preview = await h.app.remergePreview(WEB);
    const acc = await h.app.remergeCommit({ request_id: rid('remerge'), preview_digest: preview.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    // 换掉代理用户名与密码、发布（v001 退役）、清扫
    const env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(
      envId,
      { request_id: rid('upd'), expected_revision: env.revision, changes: { proxy: { username: { action: 'replace', value: 'synthUserNew02' }, password: { action: 'replace', value: 'synthPwNew9911' } } } } as never,
      WEB,
    );
    await h.idle();
    await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(h.repos.proxyRevisions.get(envId, 1)!.state).toBe('retired');
    await h.app.engine.secrets.sweep();
    const pepper = Buffer.from((await h.store.get(PEPPER_REF))!, 'base64url');

    // 拿到数据目录副本的人：sfe.sqlite（含 pepper）与 backups/ 中的工作配置副本
    const db = new DatabaseSync(snapshotCopy(join(h.dir, 'sfe.sqlite')), { readOnly: true });
    try {
      const r1 = db.prepare('SELECT node_name, host, port, front_proxy_id FROM proxy_revisions WHERE environment_id = ? AND revision = 1').get(envId) as {
        node_name: string;
        host: string;
        port: number;
        front_proxy_id: string;
      };
      const front = db.prepare('SELECT surge_name FROM front_proxies WHERE id = ?').get(r1.front_proxy_id) as { surge_name: string };
      const generations = (db.prepare('SELECT generation FROM deployments').all() as Array<{ generation: number }>).map((d) => d.generation);
      const backupDir = join(h.dir, 'backups', readdirSync(join(h.dir, 'backups')).find((n) => n.startsWith('remerge-'))!);
      const currentText = readFileSync(join(backupDir, readdirSync(backupDir)[0]!), 'utf8');
      expect(currentText).toBe(tampered);
      const settings = Object.fromEntries((db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>).map((r) => [r.key, JSON.parse(r.value) as unknown]));
      // 重新合并恢复的是指向本机资源服务当前地址的定义（D10）
      let candidate = replaceManagedBlock(currentText, 'group', loopbackGroupBlockLines(h.profileResourceUrl!));
      if (settings.entryStrategy === 'ruleset_resource' && typeof findManagedBlock(parseProfile(candidate), 'entry') === 'object') {
        candidate = replaceManagedBlock(candidate, 'entry', entryRuleSetBlockLines());
      }
      // 持久保存的全部字符串：操作的 payload 与结果、备份记录
      const persisted = new Set<string>();
      const collect = (v: unknown): void => {
        if (typeof v === 'string') persisted.add(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v !== null && typeof v === 'object') Object.values(v).forEach(collect);
      };
      for (const row of db.prepare('SELECT payload, result FROM operations').all() as Array<{ payload: string; result: string | null }>) {
        collect(JSON.parse(row.payload));
        if (row.result) collect(JSON.parse(row.result));
      }
      for (const row of db.prepare('SELECT files FROM backups').all() as Array<{ files: string }>) collect(JSON.parse(row.files));
      const fd = (t: string) => hmacHex(pepperKey(pepper, 'file'), `sfe-file\0${t}`);
      const previewKey = pepperKey(pepper, 'preview');
      let tries = 0;
      const hits: string[] = [];
      for (const u of ['admin', OLD_USER, 'synthUserNew02']) {
        for (const pw of DICT.concat([OLD_PW, 'synthPwNew9911'])) {
          for (const g of generations) {
            let line: string;
            try {
              line = nodeLine({ name: r1.node_name, host: r1.host, port: r1.port, username: u, password: pw, front: front.surge_name });
            } catch {
              continue; // 节点行不接受的字符：不可能是发布过的凭据
            }
            for (const resource of [resourceFile(g, [line]), resourceBody(g, [line])]) {
              tries++;
              const digest = keyedRequestDigest(previewKey, { kind: 'maintenance.remerge', current: fd(currentText), candidate: fd(candidate), resource: fd(resource), restoreResource: null, restoreEntry: [] });
              if (persisted.has(digest) || persisted.has(fd(resource))) hits.push(`${u}/${pw}@${g}`);
            }
          }
        }
      }
      expect(tries).toBeGreaterThan(0);
      expect(hits).toEqual([]);
      const remergeOp = db.prepare("SELECT payload FROM operations WHERE kind = 'maintenance.remerge'").get() as { payload: string };
      expect(JSON.parse(remergeOp.payload)).not.toHaveProperty('previewDigest');
    } finally {
      db.close();
    }
  });

  test('publishes keep no pepper-keyed digest of the working profile: the user\'s own node password, changed in Surge between publishes, cannot be checked against any persisted value and a profile copy from backups/', async () => {
    const yr = 2000 + 25;
    const first = `Summer${yr}`;
    const second = `Autumn${yr}`;
    h = await createHarness({ dbFile: true });
    await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    // backups/ 中的工作配置副本（初始化、重新合并）：之后用户在 Surge 中只改了自己节点的密码，发布不改写工作配置
    const copy = readFileSync(h.profilePath, 'utf8');
    expect(copy).toContain('password=example-pass');
    const withPassword = (pw: string) => copy.replace('password=example-pass', `password=${pw}`);
    writeFileSync(h.profilePath, withPassword(first));
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11');
    // 同一进程内照常提示受管理段之外的修改
    expect(h.repos.operations.listSteps(b.operation_id).some((s) => s.message.includes('作为新基线'))).toBe(true);
    writeFileSync(h.profilePath, withPassword(second));
    const c = await createEnv(h, 'US-Buyer-03', '203.0.113.12');
    expect(h.repos.operations.get(c.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.deployments.list(-1).filter((d) => d.state === 'verified').length).toBeGreaterThanOrEqual(3);
    const pepper = Buffer.from((await h.store.get(PEPPER_REF))!, 'base64url');

    const db = new DatabaseSync(snapshotCopy(join(h.dir, 'sfe.sqlite')), { readOnly: true });
    try {
      // 数据库中持久保存的全部字符串（各表各列，JSON 展开）
      const persisted = new Set<string>();
      const collect = (v: unknown): void => {
        if (typeof v === 'string') {
          persisted.add(v);
          for (const part of v.split(':')) persisted.add(part);
          try {
            const parsed = JSON.parse(v) as unknown;
            if (parsed !== null && typeof parsed === 'object') collect(parsed);
          } catch {
            // 不是 JSON
          }
        } else if (Array.isArray(v)) v.forEach(collect);
        else if (v !== null && typeof v === 'object') Object.values(v).forEach(collect);
      };
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
      for (const t of tables) for (const row of db.prepare(`SELECT * FROM "${t}"`).all()) collect(row);
      expect(persisted.size).toBeGreaterThan(0);
      const fd = (t: string) => hmacHex(pepperKey(pepper, 'file'), `sfe-file\0${t}`);
      const hits = DICT.concat(['example-pass', first, second]).filter((g) => persisted.has(fd(withPassword(g))));
      expect(hits).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('a JSON records import (GPT or script) keyed by template headers or camelCase: the persisted request digest carries no password, even after it is replaced and swept', async () => {
    for (const pwKey of ['代理密码', 'proxyPassword']) {
      h = await createHarness({ dbFile: true });
      const record = { 环境名称: 'US-Json-1', 代理地址: '203.0.113.40', 代理端口: 1080, 代理用户名: 'synthUserJ', [pwKey]: 'Summer2025', 站点: 'US' };
      const req = { format: 'json' as const, records: [record] };
      const preview = await h.app.importPreview(req, AGENT);
      expect(preview.rows.map((r) => r.status)).toEqual(['create']);
      const requestId = rid('imp');
      const commit = { ...req, request_id: requestId, preview_digest: preview.preview_digest, decisions: [{ row: 1, action: 'create' as const }] };
      const result = await h.app.importCommit(commit, AGENT);
      await h.idle();
      const envId = result.items[0]!.environment_id!;
      // 之后用户替换代理密码，下一次发布让 v001 退役，清扫删除旧值
      const env = h.repos.environments.get(envId)!;
      await h.app.updateEnvironment(envId, { request_id: rid('upd'), expected_revision: env.revision, changes: { proxy: { password: { action: 'replace', value: 'synthProxyX2' } } } }, WEB);
      await h.idle();
      await h.app.publishPending({ request_id: rid('pub') }, WEB);
      await h.idle();
      expect(h.repos.proxyRevisions.get(envId, 1)!.state).toBe('retired');
      await h.app.engine.secrets.sweep();
      const pepper = Buffer.from((await h.store.get(PEPPER_REF))!, 'base64url');
      const db = new DatabaseSync(snapshotCopy(join(h.dir, 'sfe.sqlite')), { readOnly: true });
      try {
        const row = db.prepare('SELECT kind, request_digest FROM operations WHERE request_id = ?').get(requestId) as { kind: string; request_digest: string };
        expect(row.kind).toBe('import.batch');
        // 带秘密值：重启之后同一 request_id 的重试按内容不同返回 409（与 content_base64 相同）
        expect(row.request_digest.endsWith(':s')).toBe(true);
        const [, shape] = row.request_digest.split(':');
        const requestKey = pepperKey(pepper, 'request');
        for (const g of DICT) {
          const body = { ...commit, preview_digest: 'unknown', records: [{ ...record, [pwKey]: g }] };
          expect(requestDigestParts(requestKey, Buffer.alloc(32, 7), { method: 'importCommit', target: null, body }).shape).toBe(shape);
        }
      } finally {
        db.close();
      }
      await h.close();
      h = undefined;
    }
  });

  describe('the node resource keeps no pepper-keyed digest outside the deployment records, and those are scrubbed when their revisions retire (D10)', () => {
    /** 删除环境、清扫，返回数据目录副本中 meta（含引擎键值）的全部行与发布记录的资源摘要。 */
    async function deleteSweepAndReadCopy(envId: string): Promise<{ meta: Array<{ key: string; value: string }>; digests: string[] }> {
      const env = h!.repos.environments.get(envId)!;
      const del = await h!.app.deleteEnvironment(envId, { request_id: rid('del'), expected_revision: env.revision }, WEB);
      await h!.idle();
      expect(h!.repos.operations.get(del.operation_id)!.status).toBe('succeeded');
      expect(h!.repos.proxyRevisions.get(envId, 1)!.state).toBe('retired');
      await h!.app.engine.secrets.sweep();
      const rev = h!.repos.proxyRevisions.get(envId, 1)!;
      expect(await h!.store.get(rev.passwordRef!)).toBeNull();
      const db = new DatabaseSync(snapshotCopy(join(h!.dir, 'sfe.sqlite')), { readOnly: true });
      try {
        return {
          meta: db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>,
          digests: (db.prepare('SELECT resource_digest FROM deployments').all() as Array<{ resource_digest: string }>).map((r) => r.resource_digest),
        };
      } finally {
        db.close();
      }
    }

    /** 候选发布的内容（按发布记录与真实凭据重建）在工作配置目录文件密钥下的摘要；与记录的摘要一致，说明重建的就是提供的那一份。 */
    async function candidateDigest(generation: number): Promise<string> {
      const d = h!.repos.deployments.get(generation)!;
      const pepper = Buffer.from((await h!.store.get(PEPPER_REF))!, 'base64url');
      const lines: string[] = [];
      for (const m of d.nodeManifest) {
        const r = h!.repos.proxyRevisions.get(m.environmentId, m.proxyRevision)!;
        const front = h!.repos.frontProxies.get(r.frontProxyId!)!.surgeName;
        lines.push(nodeLine({ name: r.nodeName, host: r.host, port: r.port, username: await h!.store.get(r.usernameRef!), password: await h!.store.get(r.passwordRef!), front }));
      }
      const digest = hmacHex(pepperKey(pepper, 'file'), `sfe-file\0${resourceBody(generation, lines)}`);
      expect(d.resourceDigest).toBe(digest);
      return digest;
    }

    test('a publish rolled back because Surge dropped the node from the candidate: once the deleted environment\'s revision retires, the copy keeps no digest of the candidate and the engine state keeps only generations and sequence numbers', async () => {
      h = await createHarness({ dbFile: true });
      const a = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-01', '203.0.113.10', { username: 'synthUserA1', password: 'Summer2025' }) }, WEB);
      const op = h.repos.operations.get(a.operation_id)!;
      // 下载候选时 Surge 跳过了新节点的行：读回不一致 → 回滚（Surge 重新载入已提交的第 0 代）
      dropNodesOnNextUpdate(h, [h.repos.proxyRevisions.get(a.environment_id!, 1)!.nodeName]);
      await h.idle();
      expect(h.repos.operations.get(op.id)!.phase).toBe('FAILED');
      const candidate = h.repos.deployments.latest()!;
      expect(candidate.state).toBe('rolled_back');
      const written = await candidateDigest(candidate.generation);
      const copy = await deleteSweepAndReadCopy(a.environment_id!);
      expect(copy.digests).not.toContain(written);
      expect(copy.meta.filter((r) => r.value.includes(written)).map((r) => r.key)).toEqual([]);
      // 本机资源服务的持久状态（engine:resource:*）只有代数、序号、时间与原因代码：没有任何 64 位十六进制摘要
      const resourceRows = copy.meta.filter((r) => r.key.startsWith('engine:resource:'));
      expect(resourceRows.length).toBeGreaterThan(0);
      for (const r of resourceRows) expect(r.value).not.toMatch(/[0-9a-f]{64}/);
      expect(copy.meta.some((r) => r.key === 'engine:resource:writeBaseline' || r.key.startsWith('engine:mo_prev:resource_file:'))).toBe(false);
    });

    test('a publish refused before anything is served (--check fails) persists nothing derived from the new credentials', async () => {
      h = await createHarness({ dbFile: true });
      h.fake.checkProfile = async () => ({ ok: false, message: 'line 1: 合成错误' });
      const deploymentsBefore = h.repos.deployments.list().length;
      const a = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-01', '203.0.113.10', { username: 'synthUserA1', password: 'Summer2025' }) }, WEB);
      await h.idle();
      expect(h.repos.operations.get(a.operation_id)!).toMatchObject({ status: 'failed', error: { code: 'SURGE_CHECK_FAILED' } });
      // 没有候选发布记录，资源服务从未提供它，Surge 中没有它
      expect(h.repos.deployments.list().length).toBe(deploymentsBefore);
      expect(h.app.engine.resource!.served()).toMatchObject({ generation: 0, state: 'committed' });
      expect(h.fake.loadedContent(h.resourceKey()!)).not.toContain('Summer2025');
    });
  });

  test('idempotency: the same request_id returns the original operation within a process, and after a restart only for requests without secret values; different content is 409', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-01', '203.0.113.10', { accountPassword: 'P1-Original!' })).environment_id!;
    const env = h.repos.environments.get(envId)!;
    const id = rid('upd');
    const req = (pw: string, name = env.displayName) =>
      ({ request_id: id, expected_revision: env.revision, changes: { displayName: name, account: { password: { action: 'replace', value: pw } } } }) as never;
    const first = await h.app.updateEnvironment(envId, req('P2-Summer2025!'), WEB);
    expect(first.duplicate).toBe(false);
    expect((await h.app.updateEnvironment(envId, req('P2-Summer2025!'), WEB)).duplicate).toBe(true);
    // 同一进程内只有秘密不同：照常 409
    await expect(h.app.updateEnvironment(envId, req('other-password'), WEB)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST_MISMATCH' });
    // 不带秘密值的请求
    const plainId = rid('upd');
    const plain = { request_id: plainId, expected_revision: env.revision + 1, changes: { displayName: 'US-Renamed' } } as never;
    const plainFirst = await h.app.updateEnvironment(envId, plain, WEB);
    await h.idle();
    await h.crash();
    // 重新启动之后：不带秘密值的同一请求返回原操作；秘密以外的内容不同仍是 409
    expect(await h.app.updateEnvironment(envId, plain, WEB)).toMatchObject({ duplicate: true, operation_id: plainFirst.operation_id });
    await expect(h.app.updateEnvironment(envId, req('P2-Summer2025!', 'US-Other'), WEB)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST_MISMATCH' });
    // 带秘密值的：之前进程的秘密部分无从比较，不能判断是不是同一个密码——一律 409，从不按重复返回原操作而悄悄丢掉改正的密码
    await expect(h.app.updateEnvironment(envId, req('P2-Summer2025!'), WEB)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST_MISMATCH' });
    await expect(h.app.updateEnvironment(envId, req('other-password'), WEB)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST_MISMATCH' });
  });

  test('a corrected password resubmitted under the same request_id after a restart (the first response was lost) is refused, never reported as saved', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-01', '203.0.113.10', { accountPassword: 'P1-Original!', password: 'synthProxyX1' })).environment_id!;
    const env = h.repos.environments.get(envId)!;
    const id = rid('upd');
    const req = (pw: string) =>
      ({ request_id: id, expected_revision: env.revision, changes: { account: { password: { action: 'replace', value: pw } }, proxy: { password: { action: 'replace', value: pw } } } }) as never;
    const first = await h.app.updateEnvironment(envId, req('P1-typo'), WEB);
    await h.idle();
    const fpAfterFirst = h.repos.environments.get(envId)!;
    // 服务在提交之后、响应之前退出；网页对话框保持打开、用同一编号提交改正的密码
    await h.crash();
    await expect(h.app.updateEnvironment(envId, req('P2-correct'), WEB)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST_MISMATCH' });
    expect(h.repos.operations.byRequestId(id)!.id).toBe(first.operation_id);
    expect(h.repos.environments.get(envId)!.revision).toBe(fpAfterFirst.revision);
  });
});

describe('a publish whose rollback cannot be confirmed keeps no pepper-keyed digest of the candidate once its revision retires (§0, INSTALL §6)', () => {
  type Mode = 'rollback_update_fails' | 'rollback_members_throw';

  /**
   * 环境 A 已发布、已核对；创建环境 B（代理密码 pwB）的发布 N 提供含 B 节点行（明文凭据）的候选，Surge 载入后逐节点读回不一致
   * （端口）→ 回滚；回滚的单 key 更新失败（或之后读不到组成员）→ 需要处理，Surge 可能仍载入着候选。用户随后删除 B：Surge 可能
   * 仍有它，先不退役；之后一次发布收敛（Surge 回到不含 B 的版本）时退役、凭据被清扫。
   */
  async function scenario(mode: Mode) {
    h = await createHarness({ dbFile: true });
    const a = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-01', '203.0.113.10', { username: ['synth', 'UserA'].join(''), password: ['synth', 'PwdA', '1'].join('') }) }, WEB);
    await h.idle();
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    const fake = h.fake as unknown as { getPolicyDetail: (n: string) => Promise<Record<string, unknown>>; getGroupMembers: (g: string) => Promise<string[]>; updateExternalResource: (k: string) => Promise<unknown> };
    const origDetail = fake.getPolicyDetail.bind(h.fake);
    const origMembers = fake.getGroupMembers.bind(h.fake);
    const origUpdate = fake.updateExternalResource.bind(h.fake);
    let inRollback = false;
    fake.getPolicyDetail = async (name: string) => {
      const d = await origDetail(name);
      if (!name.includes('E0002')) return d;
      inRollback = true;
      return { ...d, port: 1 };
    };
    fake.getGroupMembers = async (g: string) => {
      if (inRollback && mode === 'rollback_members_throw' && h!.app.engine.resource!.served()?.state === 'committed' && (h!.fake.calls.updateExternalResource ?? 0) >= 3) throw new Error('模拟：Surge 不可达');
      return origMembers(g);
    };
    fake.updateExternalResource = async (k: string) => {
      if (inRollback && mode === 'rollback_update_fails') throw new Error('模拟：更新失败');
      return origUpdate(k);
    };
    const pwB = ['Sum', 'mer', '2025'].join('');
    const b = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-02', '203.0.113.20', { username: ['synth', 'UserB'].join(''), password: pwB }) }, WEB);
    await h.idle();
    fake.getGroupMembers = origMembers;
    fake.getPolicyDetail = origDetail;
    fake.updateExternalResource = origUpdate;
    const depN = h.repos.deployments.latest()!;
    expect(h.repos.operations.get(b.operation_id)!).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(depN.state).toBe('failed');
    // 候选的内容：按发布记录与真实凭据重建，与记录的摘要一致
    const pepper = Buffer.from((await h.store.get(PEPPER_REF))!, 'base64url');
    const lines: string[] = [];
    for (const m of depN.nodeManifest) {
      const r = h.repos.proxyRevisions.get(m.environmentId, m.proxyRevision)!;
      const front = h.repos.frontProxies.get(r.frontProxyId!)!.surgeName;
      lines.push(nodeLine({ name: r.nodeName, host: r.host, port: r.port, username: await h.store.get(r.usernameRef!), password: await h.store.get(r.passwordRef!), front }));
    }
    const writtenN = hmacHex(pepperKey(pepper, 'file'), `sfe-file\0${resourceBody(depN.generation, lines)}`);
    expect(depN.resourceDigest).toBe(writtenN);
    const envB = h.repos.environments.get(b.environment_id!)!;
    const revB = h.repos.proxyRevisions.get(envB.id, 1)!;
    const del = await h.app.deleteEnvironment(envB.id, { request_id: rid('del'), expected_revision: envB.revision }, WEB);
    await h.idle();
    expect(h.repos.operations.get(del.operation_id)!.status).toBe('succeeded');
    // Surge 仍可能载入着含 B 的候选：先不退役
    if (mode === 'rollback_update_fails') expect(h.repos.proxyRevisions.get(envB.id, 1)!.state).not.toBe('retired');
    // 一次发布收敛：Surge 回到不含 B 的版本，B 退役、凭据被清扫
    const pub = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.status).toBe('succeeded');
    expect(h.repos.proxyRevisions.get(envB.id, 1)!.state).toBe('retired');
    await h.app.engine.secrets.sweep();
    expect(await h.store.get(revB.passwordRef!)).toBeNull();
    return { writtenN };
  }

  for (const mode of ['rollback_update_fails', 'rollback_members_throw'] as const) {
    test(`${mode}: after deleting the environment, converging and sweeping its credentials, no row of a data-directory copy equals the digest of the candidate`, async () => {
      const { writtenN } = await scenario(mode);
      const db = new DatabaseSync(snapshotCopy(join(h!.dir, 'sfe.sqlite')), { readOnly: true });
      try {
        const meta = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
        expect(meta.filter((r) => r.value.includes(writtenN)).map((r) => r.key)).toEqual([]);
        const mos = db.prepare('SELECT content_digest FROM managed_objects').all() as Array<{ content_digest: string | null }>;
        expect(mos.filter((r) => r.content_digest === writtenN)).toEqual([]);
        const deps = db.prepare('SELECT resource_digest FROM deployments').all() as Array<{ resource_digest: string }>;
        expect(deps.filter((r) => r.resource_digest === writtenN)).toEqual([]);
      } finally {
        db.close();
      }
    });
  }
});

describe('migration 3 scrubs digests written before this version', () => {
  test('legacy request digests (operations and the request ledger), retired fingerprints and deployments with retired revisions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-mig3-'));
    cleanup.push(dir);
    const db = openDatabase(join(dir, 'sfe.sqlite'));
    db.exec(MIGRATIONS[0]!);
    db.exec(MIGRATIONS[1]!);
    db.run("INSERT INTO meta(key, value) VALUES('schema_version', '2')");
    const at = '2026-10-21T00:00:00.000Z';
    const legacy = 'a'.repeat(64);
    db.run("INSERT INTO front_proxies(id, surge_name, kind, state, is_default, retired, created_at) VALUES('front_1', 'Front-A', 'node', 'ok', 1, 0, ?)", [at]);
    db.run(
      "INSERT INTO environments(id, seq, code, node_tag, display_name, site, auto_open_orders, auto_fill_login, revision, created_at, updated_at) VALUES('env_1', 1, 'E0001', 'US01', 'US-1', 'US', 1, 0, 1, ?, ?)",
      [at, at],
    );
    for (const [rev, state] of [
      [1, 'retired'],
      [2, 'deployed'],
    ] as const) {
      db.run(
        `INSERT INTO proxy_revisions(environment_id, revision, protocol, host, port, username_fp, password_fp, front_proxy_id, node_name, state, created_at)
         VALUES('env_1', ?, 'socks5', '203.0.113.10', 1080, ?, ?, 'front_1', ?, ?, ?)`,
        [rev, `ufp${rev}`, `pfp${rev}`, `SFE-N-E0001-US01-v00${rev}`, state, at],
      );
    }
    for (const [g, revs] of [
      [1, [1]],
      [2, [1, 2]],
      [3, [2]],
    ] as const) {
      db.run("INSERT INTO deployments(generation, working_profile_digest, resource_digest, node_manifest, state, created_at, updated_at) VALUES(?, ?, ?, ?, 'verified', ?, ?)", [
        g,
        `wp${g}`,
        `rd${g}`,
        JSON.stringify(revs.map((r) => ({ nodeName: `SFE-N-E0001-US01-v00${r}`, environmentId: 'env_1', proxyRevision: r }))),
        at,
        at,
      ]);
    }
    db.run(
      "INSERT INTO operations(id, request_id, request_digest, kind, initiator_kind, phase, status, payload, created_at, updated_at) VALUES('op_1', 'req_1', ?, 'environment.update', 'web', 'COMPLETED', 'succeeded', '{}', ?, ?)",
      [legacy, at, at],
    );
    db.run("INSERT INTO meta(key, value) VALUES('engine:req:req_2', ?)", [JSON.stringify({ digest: legacy, ref: { operationId: 'op_1' } })]);
    expect(db.migrate()).toEqual({ from: 2, to: MIGRATIONS.length });
    expect(db.get<{ request_digest: string }>("SELECT request_digest FROM operations WHERE id = 'op_1'")?.request_digest).toBe('scrubbed-v1');
    expect(JSON.parse(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'engine:req:req_2'")!.value)).toEqual({ digest: 'scrubbed-v1', ref: { operationId: 'op_1' } });
    expect(db.all('SELECT revision, username_fp, password_fp FROM proxy_revisions ORDER BY revision')).toEqual([
      { revision: 1, username_fp: null, password_fp: null },
      { revision: 2, username_fp: 'ufp2', password_fp: 'pfp2' },
    ]);
    // 第 3 代不含退役版本，迁移 3 保留它的资源摘要；工作配置摘要随后由迁移 6 一律清除
    expect(db.all('SELECT generation, resource_digest, working_profile_digest FROM deployments ORDER BY generation')).toEqual([
      { generation: 1, resource_digest: 'scrubbed', working_profile_digest: null },
      { generation: 2, resource_digest: 'scrubbed', working_profile_digest: null },
      { generation: 3, resource_digest: 'rd3', working_profile_digest: null },
    ]);
    db.close();
  });
});

describe('migration 6 removes the pepper-keyed working profile digests kept by every publish', () => {
  test('every deployment loses its working profile digest; resource digests and the rest of the row are kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-mig6-'));
    cleanup.push(dir);
    const db = openDatabase(join(dir, 'sfe.sqlite'));
    for (const m of MIGRATIONS.slice(0, 5)) db.exec(m);
    db.run("INSERT INTO meta(key, value) VALUES('schema_version', '5')");
    const at = '2026-10-21T00:00:00.000Z';
    for (const [g, state, wp] of [
      [1, 'verified', 'a'.repeat(64)],
      [2, 'published', 'b'.repeat(64)],
      [3, 'rolled_back', null],
    ] as const) {
      db.run("INSERT INTO deployments(generation, working_profile_digest, resource_digest, node_manifest, state, created_at, updated_at) VALUES(?, ?, ?, '[]', ?, ?, ?)", [g, wp, `rd${g}`, state, at, at]);
    }
    expect(db.migrate()).toEqual({ from: 5, to: MIGRATIONS.length });
    expect(db.all('SELECT generation, resource_digest, working_profile_digest, state FROM deployments ORDER BY generation')).toEqual([
      { generation: 1, resource_digest: 'rd1', working_profile_digest: null, state: 'verified' },
      { generation: 2, resource_digest: 'rd2', working_profile_digest: null, state: 'published' },
      { generation: 3, resource_digest: 'rd3', working_profile_digest: null, state: 'rolled_back' },
    ]);
    db.close();
  });
});

describe('migration 4 removes the remaining digests of secret-bearing content', () => {
  test('preview digests kept by maintenance operations and backup entries of generated files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-mig4-'));
    cleanup.push(dir);
    const db = openDatabase(join(dir, 'sfe.sqlite'));
    for (const m of MIGRATIONS.slice(0, 3)) db.exec(m);
    db.run("INSERT INTO meta(key, value) VALUES('schema_version', '3')");
    const at = '2026-10-21T00:00:00.000Z';
    const ops: Array<[string, string, string]> = [
      ['op_r', 'maintenance.remerge', JSON.stringify({ previewDigest: 'd'.repeat(64) })],
      ['op_i', 'maintenance.init', JSON.stringify({ previewDigest: 'e'.repeat(64), keep: 1 })],
      ['op_o', 'environment.update', JSON.stringify({ previewDigest: 'not-a-maintenance-op' })],
    ];
    for (const [id, kind, payload] of ops) {
      db.run("INSERT INTO operations(id, request_id, request_digest, kind, initiator_kind, phase, status, payload, created_at, updated_at) VALUES(?, ?, 'v2:x:y', ?, 'web', 'COMPLETED', 'succeeded', ?, ?, ?)", [
        id,
        `req_${id}`,
        kind,
        payload,
        at,
        at,
      ]);
    }
    const files = [
      { relativePath: '日常-Safari环境.conf', digest: 'p1' },
      { relativePath: 'sfe-nodes.list', digest: 'n1' },
      { relativePath: './sfe-entry-active.list', digest: 'a1' },
      { relativePath: 'sfe-entry-udp.list', digest: 'u1' },
      { relativePath: 'rules/sfe-nodes.list', digest: 'user-file-in-subdir' },
      { relativePath: 'user-rules.list', digest: 'r1' },
    ];
    const ins = "INSERT INTO backups(id, reason, source_path, backup_directory, files, runtime_switches, created_at) VALUES(?, 'remerge', '/x/p.conf', '/x/b', ?, '{}', ?)";
    db.run(ins, ['bak_1', JSON.stringify(files), at]);
    db.run(ins, ['bak_2', JSON.stringify([files[0]]), at]);
    expect(db.migrate()).toEqual({ from: 3, to: MIGRATIONS.length });
    const payloads = Object.fromEntries(db.all<{ id: string; payload: string }>('SELECT id, payload FROM operations').map((r) => [r.id, JSON.parse(r.payload) as unknown]));
    expect(payloads).toEqual({ op_r: {}, op_i: { keep: 1 }, op_o: { previewDigest: 'not-a-maintenance-op' } });
    const backups = Object.fromEntries(db.all<{ id: string; files: string }>('SELECT id, files FROM backups').map((r) => [r.id, JSON.parse(r.files) as unknown]));
    expect(backups).toEqual({
      bak_1: [files[0], files[4], files[5]],
      bak_2: [files[0]],
    });
    db.close();
  });
});

describe('migration 5 scrubs import digests that covered alias-keyed JSON records', () => {
  test('import.batch digests without the secret marker become uncheckable; marked digests and other kinds are kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-mig5-'));
    cleanup.push(dir);
    const db = openDatabase(join(dir, 'sfe.sqlite'));
    for (const m of MIGRATIONS.slice(0, 4)) db.exec(m);
    db.run("INSERT INTO meta(key, value) VALUES('schema_version', '4')");
    const at = '2026-10-21T00:00:00.000Z';
    const v2 = (secret: boolean) => `v2:${'a'.repeat(64)}:${'b'.repeat(16)}:${'c'.repeat(64)}${secret ? ':s' : ''}`;
    const ops: Array<[string, string, string]> = [
      ['op_leak', 'import.batch', v2(false)],
      ['op_marked', 'import.batch', v2(true)],
      ['op_other', 'environment.update', v2(false)],
      ['op_scrubbed', 'import.batch', 'scrubbed-v1'],
    ];
    for (const [id, kind, digest] of ops) {
      db.run("INSERT INTO operations(id, request_id, request_digest, kind, initiator_kind, phase, status, payload, created_at, updated_at) VALUES(?, ?, ?, ?, 'agent', 'COMPLETED', 'succeeded', '{}', ?, ?)", [
        id,
        `req_${id}`,
        digest,
        kind,
        at,
        at,
      ]);
    }
    expect(db.migrate()).toEqual({ from: 4, to: MIGRATIONS.length });
    expect(db.all('SELECT id, request_digest FROM operations ORDER BY id')).toEqual([
      { id: 'op_leak', request_digest: 'scrubbed-v1' },
      { id: 'op_marked', request_digest: v2(true) },
      { id: 'op_other', request_digest: v2(false) },
      { id: 'op_scrubbed', request_digest: 'scrubbed-v1' },
    ]);
    db.close();
  });
});
