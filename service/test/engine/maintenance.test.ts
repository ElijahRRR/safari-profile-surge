import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { NODE_RESOURCE_FILE, SfeError, WORKING_PROFILE_NAME } from '@sfe/contract';
import { RELOAD_FULL_RESTART_NOTICE } from '../../src/engine/maintenance.js';
import { ADMIN, AGENT, PROFILE_A, WEB, activeEnv, createEnv, createHarness, envInput, rid, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function expectError(p: Promise<unknown>, code: string): Promise<SfeError> {
  try {
    await p;
  } catch (err) {
    expect((err as SfeError).code).toBe(code);
    return err as SfeError;
  }
  throw new Error(`expected ${code}`);
}

// 合成源配置：托管配置头、用户节点（占位凭据）、用户策略组与 FINAL
const SOURCE = [
  '#!MANAGED-CONFIG https://sub.example.test/daily.conf interval=86400',
  '[General]',
  'loglevel = notify',
  '',
  '[Proxy]',
  'Front-A = socks5, 192.0.2.10, 1080, username=example-user, password=example-pass',
  '',
  '[Proxy Group]',
  'Daily = select, Front-A, DIRECT',
  '',
  '[Rule]',
  'DOMAIN-SUFFIX,daily.example.test,Daily',
  'FINAL,DIRECT',
  '',
].join('\n');

const workingPath = () => join(h.surgeDir, `${WORKING_PROFILE_NAME}.conf`);

describe('init (one-time fixed working profile)', () => {
  test('preview → commit creates the working profile next to the source; never reloads or switches', async () => {
    h = await createHarness({ sourceProfile: SOURCE });
    const preview = await h.app.initPreview({}, WEB);
    expect(preview.sourceProfilePath).toBe(join(h.surgeDir, 'Daily.conf'));
    expect(preview.workingProfilePath).toBe(workingPath());
    expect(preview.managedConfigDetected).toBe(true);
    expect(preview.remoteUpdatesNotice).not.toBeNull();
    expect(preview.nameCollisions).toEqual([]);
    expect(preview.profileDirectoryRisk).toBe('none');
    expect(preview.checks.find((c) => c.name === 'check')!.ok).toBe(true);
    expect(preview.managedDiff).toContain('# SFE-BEGIN group v1');
    expect(preview.managedDiff).not.toContain('example-pass');

    const req = { request_id: rid('init'), preview_digest: preview.preview_digest };
    const acc = await h.app.initCommit(req, WEB);
    await h.idle();
    const op = h.repos.operations.get(acc.operation_id)!;
    expect(op.kind).toBe('maintenance.init');
    expect(op.phase).toBe('COMPLETED');
    // 源配置不变，工作配置为新文件，去掉托管头并带受管理段
    expect(readFileSync(join(h.surgeDir, 'Daily.conf'), 'utf8')).toBe(SOURCE);
    const working = readFileSync(workingPath(), 'utf8');
    expect(working).not.toContain('#!MANAGED-CONFIG');
    expect(working).toContain('# SFE-BEGIN group v1');
    expect(working).toContain('# SFE-BEGIN entry v1');
    expect(existsSync(join(h.surgeDir, NODE_RESOURCE_FILE))).toBe(true);
    expect(h.repos.settings.get('workingProfilePath')).toBe(workingPath());
    const backups = h.repos.backups.list({ reason: 'init' });
    expect(backups).toHaveLength(1);
    expect(readdirSync(backups[0]!.backupDirectory)).toContain('Daily.conf');
    expect(h.repos.managedObjects.get('group_segment', 'group')!.state).toBe('present');
    expect(h.repos.managedObjects.get('entry_segment', 'entry')!.state).toBe('present');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    // 本应用从不切换配置：由用户在 Surge 中手动切换一次
    expect(h.repos.operations.listSteps(acc.operation_id).some((s) => s.message.includes('手动切换'))).toBe(true);

    // 同一请求重放 → 同一操作；之后不能再次初始化
    const again = await h.app.initCommit(req, WEB);
    expect(again.operation_id).toBe(acc.operation_id);
    expect(again.duplicate).toBe(true);
    await expectError(h.app.initPreview({}, WEB), 'NAME_COLLISION');
  });

  test('source changed after preview → PREVIEW_STALE, nothing written', async () => {
    h = await createHarness({ sourceProfile: SOURCE });
    const preview = await h.app.initPreview({}, WEB);
    writeFileSync(join(h.surgeDir, 'Daily.conf'), SOURCE.replace('FINAL,DIRECT', 'DOMAIN,extra.example.test,DIRECT\nFINAL,DIRECT'));
    await expectError(h.app.initCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB), 'PREVIEW_STALE');
    expect(existsSync(workingPath())).toBe(false);
    expect(h.repos.operations.listRecent(50).filter((o) => o.kind === 'maintenance.init')).toHaveLength(0);
  });

  test('foreign SFE- names or sfe-* files → NAME_COLLISION', async () => {
    h = await createHarness({ sourceProfile: SOURCE.replace('Daily = select, Front-A, DIRECT', 'Daily = select, Front-A, DIRECT\nSFE-Old = select, DIRECT') });
    writeFileSync(join(h.surgeDir, 'sfe-legacy.list'), '# 旧文件\n');
    const preview = await h.app.initPreview({}, WEB);
    expect(preview.nameCollisions.some((n) => n.startsWith('SFE-Old'))).toBe(true);
    expect(preview.nameCollisions).toContain('sfe-legacy.list');
    expect(preview.checks.find((c) => c.name === 'collisions')!.ok).toBe(false);
    await expectError(h.app.initCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB), 'NAME_COLLISION');
    expect(existsSync(workingPath())).toBe(false);
  });

  test.each([
    ['policy list', 'listPolicies', '策略列表'],
    ['external resource list', 'listExternalResources', '外部资源列表'],
  ] as const)('Surge %s unreadable → collision check fails closed (NAME_COLLISION), nothing written', async (_name, primitive, label) => {
    h = await createHarness({ sourceProfile: SOURCE });
    const fake = h.fake as unknown as Record<string, () => Promise<unknown>>;
    const original = fake[primitive]!;
    fake[primitive] = async () => {
      throw new SfeError('SURGE_COMMAND_FAILED', '读取失败：Surge 输出格式无法识别');
    };
    const preview = await h.app.initPreview({}, WEB);
    const check = preview.checks.find((c) => c.name === 'surge_names')!;
    expect(check.ok).toBe(false);
    expect(check.message).toContain(label);
    const err = await expectError(h.app.initCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB), 'NAME_COLLISION');
    expect(err.message).toContain(label);
    expect(existsSync(workingPath())).toBe(false);
    fake[primitive] = original;
    expect((await h.app.initPreview({}, WEB)).checks.find((c) => c.name === 'surge_names')!.ok).toBe(true);
  });

  test('Surge liveness read itself unreadable (service order: external resource list) → init fails closed (SURGE_UNREACHABLE), nothing written', async () => {
    h = await createHarness({ sourceProfile: SOURCE, livenessPrimitive: 'auto' });
    expect(h.app.engine.livenessPrimitive).toBe('listExternalResources');
    const fake = h.fake as unknown as Record<string, () => Promise<unknown>>;
    const original = fake.listExternalResources!;
    fake.listExternalResources = async () => {
      throw new SfeError('SURGE_COMMAND_FAILED', '读取失败：Surge 输出格式无法识别');
    };
    // 运行实例（版本来源）仍可读：它从不决定可达性
    const err = await expectError(h.app.initPreview({}, WEB), 'SURGE_UNREACHABLE');
    expect(err.message).toBe('初始化失败：无法连接 Surge');
    expect(await h.app.refreshSurge(WEB)).toMatchObject({ reachable: false, message: '无法确认 Surge 连接：只读检测失败或输出无法识别' });
    expect(existsSync(workingPath())).toBe(false);
    fake.listExternalResources = original;
    expect((await h.app.initPreview({}, WEB)).checks.find((c) => c.name === 'surge_names')!.ok).toBe(true);
  });

  test('synced profile directory → UNSAFE_LOCATION', async () => {
    h = await createHarness({ sourceProfile: SOURCE, surgeSubdir: 'home/Library/Mobile Documents/iCloud~com~nssurge~inc/Documents' });
    const preview = await h.app.initPreview({}, WEB);
    expect(preview.profileDirectoryRisk).toBe('synced');
    await expectError(h.app.initCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB), 'UNSAFE_LOCATION');
  });

  test('real location of the profile directory or home cannot be confirmed (e.g. a link loop) → blocked with UNSAFE_LOCATION and a clear reason, not an internal error; no path in the error', async () => {
    h = await createHarness({ sourceProfile: SOURCE });
    const home = join(h.dir, 'home');
    symlinkSync(home, home); // realpath → ELOOP（不是“尚不存在”）
    const err = await expectError(h.app.initPreview({}, WEB), 'UNSAFE_LOCATION');
    expect(err.message).toContain('无法确认目录的真实位置');
    expect(JSON.stringify(err.toBody())).not.toContain(h.dir);
    expect(existsSync(workingPath())).toBe(false);
    // 读取事实本身不因此失败
    expect((await h.app.refreshSurge(WEB)).reachable).toBe(true);
  });

  test('target directory must be the source directory; agent cannot init', async () => {
    h = await createHarness({ sourceProfile: SOURCE });
    await expectError(h.app.initPreview({ targetDirectory: join(h.dir, 'elsewhere') }, WEB), 'VALIDATION_FAILED');
    await expectError(h.app.initPreview({}, AGENT), 'BAD_REQUEST');
    const p = await h.app.initPreview({}, ADMIN);
    expect(p.preview_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('already initialized → NAME_COLLISION', async () => {
    h = await createHarness();
    await expectError(h.app.initPreview({}, WEB), 'NAME_COLLISION');
  });
});

describe('remerge (user-confirmed maintenance)', () => {
  const tamperGroup = () => {
    const text = readFileSync(h.profilePath, 'utf8').replace('SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list', 'SFE-ROUTE = select, REJECT, DIRECT, policy-path=sfe-nodes.list');
    writeFileSync(h.profilePath, text);
    return text;
  };

  test('refused while an environment is active (entry not NORMAL)', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    tamperGroup();
    const p = await h.app.remergePreview(WEB);
    expect(p.checks.find((c) => c.name === 'entry')!.ok).toBe(false);
    await expectError(h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB), 'ENVIRONMENT_ACTIVE');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('real location of the working-profile directory cannot be confirmed → preview blocked with UNSAFE_LOCATION (clear reason, no path), nothing written', async () => {
    h = await createHarness();
    tamperGroup();
    const home = join(h.dir, 'home');
    symlinkSync(home, home);
    const profileBefore = readFileSync(h.profilePath, 'utf8');
    const err = await expectError(h.app.remergePreview(WEB), 'UNSAFE_LOCATION');
    expect(err.message).toContain('无法确认目录的真实位置');
    expect(JSON.stringify(err.toBody())).not.toContain(h.dir);
    expect(readFileSync(h.profilePath, 'utf8')).toBe(profileBefore);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test.each([['auto_reload_atomic_replace'], ['same_profile_reload_impact']] as const)('gate: %s unverified → CAPABILITY_UNVERIFIED', async (key) => {
    h = await createHarness();
    tamperGroup();
    h.revoke([key]);
    const p = await h.app.remergePreview(WEB);
    expect(p.checks.find((c) => c.name === 'gate')!.ok).toBe(false);
    await expectError(h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB), 'CAPABILITY_UNVERIFIED');
  });

  test('restores an edited managed segment, backs up, reloads the same profile once', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const tampered = tamperGroup();
    expect((await h.app.refreshSurge(WEB)).managedSectionsIntact).toBe(false);
    const p = await h.app.remergePreview(WEB);
    expect(p.requiresReload).toBe(true);
    expect(p.managedDiff).toContain('SFE-ROUTE');
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    const text = readFileSync(h.profilePath, 'utf8');
    expect(text).not.toBe(tampered);
    expect(text).toContain('SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list');
    expect(h.fake.calls.reloadProfile).toBe(1);
    expect(h.repos.backups.list({ reason: 'remerge' })).toHaveLength(1);
    expect((await h.app.refreshSurge(WEB)).managedSectionsIntact).toBe(true);
    // 重载前说明 6.9+ 可能自动完整重启引擎；重载后按引擎运行时长报告是否发生
    const steps = h.repos.operations.listSteps(acc.operation_id).map((s) => s.message);
    expect(steps).toContain(`重载同一工作配置：${RELOAD_FULL_RESTART_NOTICE}`);
    expect(steps).toContain('重载后引擎运行时长连续：未发生完整引擎重启');
  });

  test('a reload that escalates to a full engine restart is reported from the engine uptime', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    tamperGroup();
    h.clock.advance(10_000);
    const orig = h.fake.reloadProfile.bind(h.fake);
    h.fake.reloadProfile = async () => {
      await orig();
      // 6.9+：“Automatically performs a full engine restart if a change requires one.”
      h.fake.restart();
    };
    const p = await h.app.remergePreview(WEB);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    const steps = h.repos.operations.listSteps(acc.operation_id).map((s) => s.message);
    expect(steps).toContain('重载后引擎运行时长回落：Surge 执行了完整引擎重启，全部连接已关闭、临时规则已清空');
  });

  test('the full-restart notice quotes the documentation', () => {
    expect(RELOAD_FULL_RESTART_NOTICE).toContain('Automatically performs a full engine restart if a change requires one.');
    expect(RELOAD_FULL_RESTART_NOTICE).toContain('关闭全部连接并清空临时规则');
  });

  test('nothing to merge → no profile write and no reload', async () => {
    h = await createHarness();
    const before = readFileSync(h.profilePath, 'utf8');
    const p = await h.app.remergePreview(WEB);
    expect(p.requiresReload).toBe(false);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    expect(readFileSync(h.profilePath, 'utf8')).toBe(before);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('stale preview → PREVIEW_STALE', async () => {
    h = await createHarness();
    const p = await h.app.remergePreview(WEB);
    tamperGroup();
    await expectError(h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB), 'PREVIEW_STALE');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('tampered node resource is restored to the last publish and read back by a publish (Surge re-reads the file; no external-resource update)', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const resourcePath = join(h.surgeDir, NODE_RESOURCE_FILE);
    const published = readFileSync(resourcePath, 'utf8');
    writeFileSync(resourcePath, published.replace('203.0.113.10', '198.51.100.77'));
    const p = await h.app.remergePreview(WEB);
    expect(p.managedFilesDiff).toContain(NODE_RESOURCE_FILE);
    const deploymentsBefore = h.repos.deployments.list().length;
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    expect(readFileSync(resourcePath, 'utf8')).not.toContain('198.51.100.77');
    expect(h.repos.deployments.list().length).toBeGreaterThanOrEqual(deploymentsBefore);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test('remerge backups never copy the app\'s generated files: a buyer proxy password replaced and swept later is not left in the data directory', async () => {
    const OLD_PW = 'synthOldBuyerPw7788';
    h = await createHarness({ dbFile: true });
    const a = await createEnv(h, 'US-Buyer-A', '203.0.113.10', { username: 'synthBuyerUser01', password: OLD_PW });
    const envId = a.environment_id!;
    const oldRef = h.repos.proxyRevisions.get(envId, 1)!.passwordRef!;
    expect(readFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), 'utf8')).toContain(OLD_PW);
    const p = await h.app.remergePreview(WEB);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    const [bak] = h.repos.backups.list({ reason: 'remerge' });
    // 只备份工作配置（及用户自己的引用文件）：节点资源与入口规则集由数据库重新生成
    expect(bak!.files.map((f) => f.relativePath)).toEqual([`${WORKING_PROFILE_NAME}.conf`]);
    expect(readdirSync(bak!.backupDirectory)).toEqual([`${WORKING_PROFILE_NAME}.conf`]);
    // 轮换代理密码，旧版本 retired 后清扫删除旧值：数据目录（Surge 配置目录之外）中不再有它
    const env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { password: { action: 'replace', value: 'synthNewBuyerPw9911' } } } }, WEB);
    await h.idle();
    await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.proxyRevisions.get(envId, 1)!.state).toBe('retired');
    await h.app.engine.secrets.sweep();
    expect(h.store.has(oldRef)).toBe(false);
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, name.name);
        if (full === h.surgeDir) continue;
        if (name.isDirectory()) walk(full);
        else if (readFileSync(full).includes(Buffer.from(OLD_PW))) hits.push(full);
      }
    };
    walk(h.dir);
    expect(hits).toEqual([]);
  });

  test('the operation keeps no preview digest (only a check under a per-process key): a remerge accepted before a restart and run after it is refused as a stale preview; re-previewing works', async () => {
    h = await createHarness({ dbFile: true });
    // 执行器忙于一次发布（挂在等待 Surge 重新读取节点资源上），重新合并排在其后；随后服务重新启动
    const fake = h.fake as unknown as Record<string, (...args: string[]) => Promise<unknown>>;
    const members = fake.getGroupMembers!.bind(h.fake);
    let entered = false;
    fake.getGroupMembers = (...args: string[]) => {
      const cur = h.app.executor.currentOperationId;
      if (cur !== null && h.repos.operations.get(cur)?.kind !== 'maintenance.remerge') {
        entered = true;
        return new Promise(() => undefined);
      }
      return members(...args);
    };
    await h.app.createEnvironment({ request_id: rid('create'), environment: envInput('US-Buyer-A', '203.0.113.10') }, WEB);
    const end = Date.now() + 5000;
    while (!entered && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
    expect(entered).toBe(true);
    tamperGroup();
    const p = await h.app.remergePreview(WEB);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    const queued = h.repos.operations.get(acc.operation_id)!;
    expect(queued.status).toBe('queued');
    expect(JSON.stringify(queued.payload)).not.toContain(p.preview_digest);
    expect(queued.payload).not.toHaveProperty('previewDigest');
    fake.getGroupMembers = members;
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(acc.operation_id)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error).toMatchObject({ code: 'PREVIEW_STALE', message: '重新合并失败：服务在受理之后重新启动，无法再核对预览，请重新预览后再提交' });
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    const again = await h.app.remergePreview(WEB);
    const acc2 = await h.app.remergeCommit({ request_id: rid(), preview_digest: again.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc2.operation_id)!.phase).toBe('COMPLETED');
  });

  test('keeps at most 5 remerge backups', async () => {
    h = await createHarness();
    for (let i = 0; i < 7; i++) {
      h.clock.advance(1000);
      const p = await h.app.remergePreview(WEB);
      await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
      await h.idle();
    }
    expect(h.repos.backups.list({ reason: 'remerge' })).toHaveLength(5);
  });
});
