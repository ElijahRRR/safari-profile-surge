// 引擎上下文中本机资源服务（D10）的部分：资源地址只由设置中的端口与读取令牌得出（资源服务未创建或端口未选定时为 null），
// 发布用的自动重载条件来自 loopback_resource_update 记录，单 key 更新的等待与审计容差有缺省值。只用合成数据。

import { afterEach, describe, expect, test } from 'vitest';
import { nodeResourceUrl, parseNodeResourceUrl } from '@sfe/contract';
import { DEFAULT_RESOURCE_UPDATE_WAIT, Engine } from '../../src/engine/context.js';
import { createResourceHost, virtualBinder } from '../../src/resource/index.js';
import { recordingLogger } from '../resource/helpers.js';
import { anyContext, createHarness, type Harness } from './harness.js';

const TOKEN = 'a'.repeat(64);
const PORT = 24_123;

let h: Harness;

afterEach(async () => {
  await h?.close();
});

describe('Engine resource helpers', () => {
  test('resourceUrl is null without a host or a port, and otherwise derives from the configured port and token', async () => {
    h = await createHarness();
    const engine = h.app.engine;
    // 令牌读不到时资源服务为 null（D10 §4）
    const started = engine.resource;
    engine.resource = null;
    expect(engine.resourceUrl()).toBeNull();
    h.repos.settings.setResourcePort(PORT);
    expect(engine.resourceUrl()).toBeNull();
    engine.resource = createResourceHost({ token: TOKEN, clock: h.clock, logger: recordingLogger(), binder: virtualBinder() });
    const url = engine.resourceUrl();
    expect(url).toBe(nodeResourceUrl(PORT, TOKEN));
    expect(parseNodeResourceUrl(url!)).toEqual({ port: PORT, token: TOKEN });
    // 与是否已绑定无关
    expect(engine.resource.listening()).toBe(false);
    h.repos.settings.setResourcePort(null);
    expect(engine.resourceUrl()).toBeNull();
    // 设置视图从不带出端口或令牌
    h.repos.settings.setResourcePort(PORT);
    const view = JSON.stringify(h.repos.settings.view(null));
    expect(view).not.toContain(String(PORT));
    expect(view).not.toContain(TOKEN);
    engine.resource = started;
  });

  test('resourceAutoReloadCondition reads only a supported loopback_resource_update record', async () => {
    h = await createHarness();
    const engine = h.app.engine;
    const put = (status: 'supported' | 'unsupported' | 'unverified', autoReload: 'on' | 'off' | 'any') =>
      h.repos.capabilities.upsert({ key: 'loopback_resource_update', status, context: { ...anyContext(), autoReload }, verifiedAt: h.clock.now().toISOString(), note: '测试记录' });
    h.revoke(['loopback_resource_update']);
    expect(engine.resourceAutoReloadCondition()).toBeNull();
    put('supported', 'off');
    expect(engine.resourceAutoReloadCondition()).toBe('off');
    put('supported', 'any');
    expect(engine.resourceAutoReloadCondition()).toBe('any');
    put('unsupported', 'off');
    expect(engine.resourceAutoReloadCondition()).toBeNull();
    put('unverified', 'off');
    expect(engine.resourceAutoReloadCondition()).toBeNull();
    // 与入口规则集的自动重载条件（auto_reload_atomic_replace）互不影响
    h.revoke(['auto_reload_atomic_replace']);
    put('supported', 'on');
    expect(engine.autoReloadCondition()).toBeNull();
    expect(engine.resourceAutoReloadCondition()).toBe('on');
  });

  test('update wait and audit tolerance defaults, and their overrides', async () => {
    h = await createHarness();
    // 夹具给出零稳定延迟的等待（FakeClock 不自动推进）；缺省值看不给这一项依赖的引擎
    expect(h.app.engine.resourceUpdateWait()).toEqual({ timeoutMs: 0, pollMs: 0, settleMs: 0 });
    const { resourceUpdateWait: _wait, ...deps } = h.app.engine.deps;
    const engine = new Engine(deps);
    expect(engine.resourceUpdateWait()).toEqual({ timeoutMs: 30_000, pollMs: 500, settleMs: 800 });
    expect(DEFAULT_RESOURCE_UPDATE_WAIT).toEqual({ timeoutMs: 30_000, pollMs: 500, settleMs: 800 });
    expect(engine.resourceAuditToleranceMs()).toBe(5000);
    const other = new Engine({ ...engine.deps, resourceUpdateWait: { timeoutMs: 1000, pollMs: 10, settleMs: 0 }, resourceAuditToleranceMs: 1500 });
    expect(other.resourceUpdateWait()).toEqual({ timeoutMs: 1000, pollMs: 10, settleMs: 0 });
    expect(other.resourceAuditToleranceMs()).toBe(1500);
    expect(other.resource).toBeNull();
  });
});
