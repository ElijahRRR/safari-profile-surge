// 演示模式（docs/ARCHITECTURE.md §11）：独立临时数据目录、FakeSurge、内存秘密存储与合成数据。演示中的
// “已生效”不代表任何网络事实。能力记录在这里直接写为 supported（说明“DEMO：FakeSurge 演示，不代表真实网络”）——
// 这个绕过只存在于本目录，且只在 --demo 时被调用；确认能力的接口在演示模式下仍然拒绝。

import { join } from 'node:path';
import {
  CAPABILITY_CONTEXT_FIELDS,
  CAPABILITY_KEYS,
  NATIVE_PROTOCOL_VERSION,
  VERIFY_ENDPOINTS,
  WORKING_PROFILE_NAME,
  type CapabilityContext,
  type NativeRequest,
  type NativeResponse,
} from '@sfe/contract';
import type { Actor } from '../app.js';
import type { Repositories } from '../db/index.js';
import type { DemoHooks } from '../engine/context.js';
import type { EngineAppService } from '../engine/app-service.js';
import { registerInitialObjects } from '../engine/ownership.js';
import { MemorySecretStore } from '../secrets/memory-store.js';
import { FAKE_SAFARI_PATH, FakeSurge, createFakeSurgeEnvironment } from '../surge/fake.js';
import { createProfileFiles } from '../surge/files.js';
import { pepperKey } from '../secrets/pepper.js';
import { readFileSync } from 'node:fs';

export const DEMO_CAPABILITY_NOTE = 'DEMO：FakeSurge 演示，不代表真实网络';

/** 演示场景（/dev/native 使用的场景编号）。 */
export const DEMO_PROFILES = {
  active: 'demo-profile-0001',
  ready: 'demo-profile-0002',
  unbound: 'demo-profile-0003',
} as const;

export interface DemoSurge {
  fake: FakeSurge;
  store: MemorySecretStore;
  surgeDirectory: string;
  profilePath: string;
  hooks: DemoHooks;
}

/** 演示用的 Surge：合成工作配置（用户节点为文档地址占位）、受管理段与占位资源。 */
export function createDemoSurge(dataDir: string): DemoSurge {
  const surgeDirectory = join(dataDir, 'surge');
  const verifyHost = VERIFY_ENDPOINTS[0]!.host;
  const env = createFakeSurgeEnvironment(surgeDirectory, { entryStrategy: 'ruleset_resource', processPaths: [FAKE_SAFARI_PATH], verifyHost });
  const fake = new FakeSurge({ directory: surgeDirectory });
  const hooks: DemoHooks = {
    // 演示扩展不访问外部检测服务：在 FakeSurge 中模拟 Safari 访问检测服务的连接，供核对使用
    beforeVerificationCheck: ({ verifyHost: host, processPaths }) => {
      fake.simulateRequest({ processPath: processPaths[0] ?? FAKE_SAFARI_PATH, host, protocol: 'tcp' });
    },
  };
  return { fake, store: new MemorySecretStore(), surgeDirectory, profilePath: env.profilePath, hooks };
}

/** 只在演示模式调用：写入工作配置设置、能力记录（supported + DEMO 说明）、本应用对象清单与默认前置。 */
export async function prepareDemoState(repos: Repositories, demo: DemoSurge, pepper: Buffer): Promise<void> {
  const anyContext = Object.fromEntries(CAPABILITY_CONTEXT_FIELDS.map((f) => [f, 'any'])) as unknown as CapabilityContext;
  repos.tx(() => {
    repos.settings.set('workingProfilePath', demo.profilePath);
    repos.settings.set('workingProfileName', WORKING_PROFILE_NAME);
    repos.settings.set('entryStrategy', 'ruleset_resource');
    repos.settings.set('safariProcessPaths', [FAKE_SAFARI_PATH]);
    for (const key of CAPABILITY_KEYS) {
      repos.capabilities.upsert({ key, status: 'supported', context: anyContext, verifiedAt: new Date().toISOString(), note: DEMO_CAPABILITY_NOTE });
    }
    if (!repos.frontProxies.byName('Front-A')) {
      repos.frontProxies.insert({ id: 'front_demo0001', surgeName: 'Front-A', state: 'ok', isDefault: true, lastCheckedAt: new Date().toISOString() });
    }
  });
  const files = createProfileFiles({ directory: demo.surgeDirectory, hmacKey: pepperKey(pepper, 'file') });
  await registerInitialObjects(repos, {
    profileText: readFileSync(demo.profilePath, 'utf8'),
    digestContent: files.digestContent,
    fileDigest: (n) => files.digest(n),
    operationId: null,
  });
}

const ADMIN: Actor = { kind: 'admin' };

async function native(app: EngineAppService, profileId: string, message: NativeRequest): Promise<NativeResponse> {
  return app.handleNative({ v: NATIVE_PROTOCOL_VERSION, auth: 'demo', bridge: { profileId, bridgeVersion: 'demo' }, message });
}

function must<T>(r: NativeResponse): T {
  if (!r.ok) throw new Error(`demo seed failed: ${r.error.code}`);
  return r.data as T;
}

/**
 * 合成环境（只用文档地址与 example.test 账号）：
 *  E0001 使用中（经完整的受控激活与模拟实测）；E0002 已部署、已关联；E0003 已部署、未关联；
 *  E0004 预检失败（代理不可用）。场景 demo-profile-0003 未关联，可在扩展演示页中关联。
 */
export async function seedDemoData(app: EngineAppService, demo: DemoSurge): Promise<void> {
  const mk = async (name: string, host: string, extra: { username?: string; password?: string; login?: string; label?: string } = {}) => {
    const accepted = await app.createEnvironment(
      {
        request_id: `demo-create-${name}`,
        environment: {
          displayName: name,
          site: 'US',
          autoOpenOrders: true,
          autoFillLogin: false,
          proxy: {
            protocol: 'socks5',
            host,
            port: 1080,
            frontProxyId: null,
            ...(extra.username ? { username: { action: 'replace' as const, value: extra.username } } : {}),
            ...(extra.password ? { password: { action: 'replace' as const, value: extra.password } } : {}),
          },
          account: { label: extra.label ?? null, loginIdentifier: extra.login ?? null },
        },
      },
      ADMIN,
    );
    await app.idle();
    return accepted.environment_id!;
  };
  const e1 = await mk('US-演示买家01', '203.0.113.11', { username: 'demo-user-01', password: 'demo-pass-01', login: 'buyer01@example.test', label: '演示买家 01' });
  const e2 = await mk('US-演示买家02', '203.0.113.12', { login: 'buyer02@example.test', label: '演示买家 02' });
  await mk('US-演示买家03', '203.0.113.13');
  // E0004：预检失败
  const e4View = await app.createEnvironment(
    { request_id: 'demo-create-04', environment: { displayName: 'US-演示买家04', site: 'US', proxy: { protocol: 'socks5', host: '198.51.100.14', port: 1080, frontProxyId: null } } },
    ADMIN,
  );
  const e4 = await app.getEnvironment(e4View.environment_id!, ADMIN);
  demo.fake.setPolicyTestResult(e4.proxy.desired!.nodeName, { ok: false, latencyMs: null, error: '演示：前置不可达' });
  await app.idle();

  const bind = async (profileId: string, envId: string) => {
    const env = await app.getEnvironment(envId, ADMIN);
    must(await native(app, profileId, { type: 'bindCurrentProfile', request_id: `demo-bind-${profileId}`, environment_id: envId, expected_revision: env.revision }));
  };
  await bind(DEMO_PROFILES.active, e1);
  await bind(DEMO_PROFILES.ready, e2);

  // E0001：完整的受控激活（BLOCKED → 选择 → VERIFY_ONLY → 模拟实测 → ACTIVE）
  const accepted = must<{ operation_id: string }>(
    await native(app, DEMO_PROFILES.active, { type: 'activateCurrentEnvironment', request_id: 'demo-activate-01', environment_id: e1, amazon_tabs_open: false }),
  );
  await app.idle();
  const begin = must<{ status: string; test_id?: string; route_epoch?: number }>(
    await native(app, DEMO_PROFILES.active, { type: 'beginSafariVerification', operation_id: accepted.operation_id, amazon_tabs_open: false }),
  );
  if (begin.status === 'ready' && begin.test_id && begin.route_epoch !== undefined) {
    const now = new Date().toISOString();
    must(
      await native(app, DEMO_PROFILES.active, {
        type: 'submitSafariVerification',
        operation_id: accepted.operation_id,
        test_id: begin.test_id,
        route_epoch: begin.route_epoch,
        observed_ip: '192.0.2.10',
        http_status: 200,
        error: null,
        started_at: now,
        finished_at: now,
      }),
    );
    await app.idle();
  }
  // 场景状态上报（提示性质）
  await native(app, DEMO_PROFILES.active, { type: 'reportProfileState', windows_open: 1, amazon_tabs_open: false, site_permission_granted: true });
}
