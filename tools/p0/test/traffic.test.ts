// “其他应用”流量发生器的重连行为：代理接受 CONNECT 后立刻断开隧道（测试服务重启、出口失败、Surge 重载期间）
// 时，每次失败只安排一次重连并按退避递增；握手没有成功的连接不记为 WebSocket 重置。

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { assessReload } from '../src/analysis/continuity.js';
import { startOtherAppTraffic, trafficImpact, trafficUnaffected, type TrafficHandle } from '../src/traffic.js';

let server: Server | null = null;
let traffic: TrafficHandle | null = null;

afterEach(async () => {
  await traffic?.stop();
  traffic = null;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** 迷你代理：CONNECT 回 200 后立即断开；普通请求回 502。记录 CONNECT 次数。 */
async function droppingProxy(): Promise<{ port: number; connects: () => number }> {
  let connects = 0;
  server = createServer((_req, res) => {
    res.writeHead(502);
    res.end();
  });
  server.on('connect', (_req, socket) => {
    connects++;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.destroy();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return { port: (server!.address() as AddressInfo).port, connects: () => connects };
}

describe('other-app traffic WebSocket reconnects', () => {
  it('schedules exactly one reconnect per failed handshake, with backoff', async () => {
    const proxy = await droppingProxy();
    traffic = startOtherAppTraffic({ proxy: { host: '127.0.0.1', port: proxy.port }, echoPort: 9, intervalMs: 60_000, label: 'storm', wsRetryBaseMs: 20, wsRetryMaxMs: 80 });
    await new Promise((r) => setTimeout(r, 700));
    const attempts = proxy.connects();
    const opens = traffic.samples.filter((s) => s.kind === 'ws_open');
    // 20、40、80、80…毫秒：700 ms 内最多十来次；加倍的重连风暴会是成百上千次。
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(attempts).toBeLessThanOrEqual(14);
    expect(opens.length).toBe(attempts);
    expect(opens.every((s) => !s.ok)).toBe(true);
    // 从未打开的连接不是“WebSocket 重置”，但重连失败仍计为影响（不能把连不上当作不受影响）。
    expect(traffic.samples.some((s) => s.kind === 'ws_close')).toBe(false);
    const imp = trafficImpact(traffic.samples, 0, Date.now() + 1);
    expect(imp.wsResets).toBe(0);
    expect(imp.wsOpenFailures).toBe(attempts);
    expect(trafficUnaffected(imp)).toBe(false);
  });

  it('stops reconnecting after stop()', async () => {
    const proxy = await droppingProxy();
    traffic = startOtherAppTraffic({ proxy: { host: '127.0.0.1', port: proxy.port }, echoPort: 9, intervalMs: 60_000, label: 'stop', wsRetryBaseMs: 20, wsRetryMaxMs: 20 });
    await new Promise((r) => setTimeout(r, 100));
    await traffic.stop();
    const after = proxy.connects();
    await new Promise((r) => setTimeout(r, 150));
    expect(proxy.connects()).toBe(after);
  });
});

describe('reload impact uses the whole observation window', () => {
  // 每秒一次短请求；流每秒一行；WebSocket 一直打开。
  const steady = (from: number, to: number, failAt: (t: number) => boolean = () => false) => {
    const out: Parameters<typeof assessReload>[0][number][] = [{ t: from, kind: 'ws_open', ok: true }];
    for (let t = from; t < to; t += 1000) {
      out.push({ t, kind: 'short', ok: !failAt(t), ms: 10, via: 'p0-plain' });
      out.push({ t: t + 500, kind: 'stream', ok: true, via: 'p0-plain' });
    }
    return out;
  };
  const opts = { leadMs: 15_000, baselineMinMs: 30_000, isReload: (l: string) => l.startsWith('reload') };

  it('counts resets that happened before the operator typed the mark', () => {
    // 50 秒时点击重载：流与 WebSocket 重置，短请求失败 2 秒；55 秒才输入 reload。
    const samples = [
      ...steady(0, 100_000, (t) => t >= 50_000 && t < 52_000),
      { t: 50_100, kind: 'stream_end' as const, ok: false, reason: 'reset' },
      { t: 50_200, kind: 'ws_close' as const, ok: false, reason: 'reset' },
      { t: 52_300, kind: 'ws_open' as const, ok: true },
    ];
    const r = assessReload(samples, [{ t: 55_000, label: 'reload', source: 'operator' }], { start: 0, end: 100_000 }, { ...opts, signals: null });
    expect(r.window.streamResets).toBe(1);
    expect(r.window.wsResets).toBe(1);
    expect(r.window.failedShorts).toBe(2);
    expect(r.evidence).toBe(true);
    expect(r.baselineOk).toBe(true);
    expect(r.unaffected).toBe(false);
    // 从第一次失败（50 秒）到最后恢复的通道（WebSocket 52.3 秒重新打开）。
    expect(r.recoveryMs).toBe(2300);
  });

  it('never reports no impact without positive evidence that the reload happened', () => {
    const marks = [{ t: 50_000, label: 'reload', source: 'operator' as const }];
    const quiet = assessReload(steady(0, 100_000), marks, { start: 0, end: 100_000 }, { ...opts, signals: null });
    expect(quiet.evidence).toBeNull();
    expect(quiet.unaffected).toBeNull();
    const unchanged = assessReload(steady(0, 100_000), marks, { start: 0, end: 100_000 }, { ...opts, signals: { reloaded: false, restarted: false, reasons: [] } });
    expect(unchanged.unaffected).toBeNull();
    const canary = assessReload(steady(0, 100_000), marks, { start: 0, end: 100_000 }, { ...opts, signals: { reloaded: true, restarted: false, reasons: ['未刷新的 canary 规则集已被重新读取'] } });
    expect(canary.evidence).toBe(true);
    expect(canary.unaffected).toBe(true);
    const restart = assessReload(steady(0, 100_000), marks, { start: 0, end: 100_000 }, { ...opts, signals: { reloaded: true, restarted: true, reasons: [] } });
    expect(restart.evidence).toBeNull();
  });

  it('a dirty baseline or other changes make the measurement incomplete', () => {
    const marks = [{ t: 60_000, label: 'reload', source: 'operator' as const }];
    const sig = { reloaded: true, restarted: false, reasons: ['x'] };
    const dirty = assessReload([...steady(0, 100_000), { t: 10_000, kind: 'stream_end', ok: false, reason: 'reset' }], marks, { start: 0, end: 100_000 }, { ...opts, signals: sig });
    expect(dirty.baselineOk).toBeNull();
    expect(dirty.unaffected).toBeNull();
    const mixed = assessReload(steady(0, 100_000), [...marks, { t: 70_000, label: 'refresh:resource_refresh', source: 'action' }], { start: 0, end: 100_000 }, { ...opts, signals: sig });
    expect(mixed.onlyReload).toBeNull();
    expect(mixed.unaffected).toBeNull();
    const short = assessReload(steady(0, 100_000), [{ t: 20_000, label: 'reload', source: 'operator' }], { start: 0, end: 100_000 }, { ...opts, signals: sig });
    expect(short.baselineOk).toBeNull();
  });
});
