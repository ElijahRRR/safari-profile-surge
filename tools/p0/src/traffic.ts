// “其他应用”流量发生器：工具经 Surge HTTP 代理端口保持一条长连接流、一条 WebSocket，并周期发短请求，
// 全部访问测试回显主机（按测试规则经 P0-Plain，不经 Safari 入口）。记录时间线样本供连续性分析。

import type { Sample } from './analysis/continuity.js';
import { proxyConnect, proxyGet, proxyStream, websocketOverSocket, type ProxyAddress, type StreamHandle, type WsHandle } from './http-client.js';
import { ECHO_HOST } from './test-profile.js';

/** WebSocket 重连退避：首次 2 秒，连续失败逐次加倍，最长 30 秒。 */
export const WS_RETRY_BASE_MS = 2000;
export const WS_RETRY_MAX_MS = 30_000;

export interface TrafficOptions {
  proxy: ProxyAddress;
  echoPort: number;
  intervalMs: number;
  label: string;
  /** 可选：经代理 CONNECT 到公网测试主机 443 的新连接建立时间（只测连接，不发数据）。 */
  publicHost?: string | null;
  now?: () => number;
  onSample?: (s: Sample) => void;
  /** WebSocket 重连退避（测试用；缺省 WS_RETRY_BASE_MS / WS_RETRY_MAX_MS）。 */
  wsRetryBaseMs?: number;
  wsRetryMaxMs?: number;
}

export interface TrafficHandle {
  samples: Sample[];
  stop(): Promise<void>;
}

export function startOtherAppTraffic(opts: TrafficOptions): TrafficHandle {
  const now = opts.now ?? (() => Date.now());
  const samples: Sample[] = [];
  const push = (s: Sample): void => {
    samples.push(s);
    opts.onSample?.(s);
  };
  let stopped = false;
  let stream: StreamHandle | null = null;
  let ws: WsHandle | null = null;
  let seq = 0;
  const base = `http://${ECHO_HOST}:${opts.echoPort}`;

  const openStream = (): void => {
    if (stopped) return;
    stream = proxyStream(
      opts.proxy,
      `${base}/stream?n=86400&t=${opts.label}-stream`,
      (line) => {
        let via: string | null = null;
        try {
          via = (JSON.parse(line) as { via?: string | null }).via ?? null;
        } catch {
          /* 半行 */
        }
        push({ t: now(), kind: 'stream', ok: true, via });
      },
      (reason) => {
        push({ t: now(), kind: 'stream_end', ok: false, expected: stopped, reason });
        if (!stopped) setTimeout(openStream, 2000);
      },
    );
  };

  // WebSocket 重连：每次失败只安排一次重连；连续失败（握手或隧道失败）按指数退避，成功打开后复位。
  // 只有真正打开过的连接结束才记 ws_close（重置）；打开失败记 ws_open ok=false（由分析计为重连失败）。
  let wsFailures = 0;
  let wsTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleWs = (): void => {
    if (stopped || wsTimer !== null) return;
    const delay = Math.min(opts.wsRetryMaxMs ?? WS_RETRY_MAX_MS, (opts.wsRetryBaseMs ?? WS_RETRY_BASE_MS) * 2 ** Math.min(wsFailures, 8));
    wsTimer = setTimeout(() => {
      wsTimer = null;
      void openWs();
    }, delay);
  };
  const openWs = async (): Promise<void> => {
    if (stopped) return;
    try {
      const socket = await proxyConnect(opts.proxy, ECHO_HOST, opts.echoPort);
      const handle = await websocketOverSocket(
        socket,
        `${ECHO_HOST}:${opts.echoPort}`,
        `/ws?app=${opts.label}`,
        (text) => {
          let via: string | null = null;
          try {
            via = (JSON.parse(text) as { via?: string | null }).via ?? null;
          } catch {
            /* 非 JSON */
          }
          push({ t: now(), kind: 'ws_msg', ok: true, via });
        },
        (reason) => {
          push({ t: now(), kind: 'ws_close', ok: false, expected: stopped, reason });
          ws = null;
          scheduleWs();
        },
      );
      if (stopped) {
        handle.close();
        return;
      }
      ws = handle;
      wsFailures = 0;
      push({ t: now(), kind: 'ws_open', ok: true });
    } catch (e) {
      if (stopped) return;
      wsFailures++;
      push({ t: now(), kind: 'ws_open', ok: false, reason: e instanceof Error ? e.message : 'error' });
      scheduleWs();
    }
  };

  const shortTimer = setInterval(() => {
    const t = now();
    void proxyGet(opts.proxy, `${base}/ip?t=${opts.label}-${++seq}&app=${opts.label}`, Math.max(2000, opts.intervalMs * 3)).then((r) => {
      push({ t, kind: 'short', ok: r.ok, ms: r.ms, via: (r.json as { via?: string | null } | null)?.via ?? null });
    });
    if (opts.publicHost && seq % 10 === 0) {
      const t2 = now();
      proxyConnect(opts.proxy, opts.publicHost, 443)
        .then((s) => {
          push({ t: t2, kind: 'public', ok: true, ms: now() - t2 });
          s.destroy();
        })
        .catch(() => push({ t: t2, kind: 'public', ok: false, ms: now() - t2 }));
    }
  }, opts.intervalMs);

  openStream();
  void openWs();

  return {
    samples,
    async stop() {
      stopped = true;
      clearInterval(shortTimer);
      if (wsTimer !== null) clearTimeout(wsTimer);
      stream?.close();
      ws?.close();
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

export interface TrafficImpact {
  streamResets: number;
  wsResets: number;
  /** WebSocket 打开失败（隧道或握手失败）。重置后一直连不回来也是影响，不能只数重置。 */
  wsOpenFailures: number;
  shortFailures: number;
  shortTotal: number;
  vias: string[];
}

/** 一段时间内的“其他应用”影响摘要（用于 refresh / entry 中的附带检查）。 */
export function trafficImpact(samples: readonly Sample[], from: number, to: number): TrafficImpact {
  const inRange = samples.filter((s) => s.t >= from && s.t <= to);
  const shorts = inRange.filter((s) => s.kind === 'short');
  return {
    streamResets: inRange.filter((s) => s.kind === 'stream_end' && !s.expected).length,
    wsResets: inRange.filter((s) => s.kind === 'ws_close' && !s.expected).length,
    wsOpenFailures: inRange.filter((s) => s.kind === 'ws_open' && !s.ok).length,
    shortFailures: shorts.filter((s) => !s.ok).length,
    shortTotal: shorts.length,
    vias: [...new Set(inRange.map((s) => s.via).filter((v): v is string => typeof v === 'string' && v.startsWith('p0-')))].sort(),
  };
}

export function trafficUnaffected(i: TrafficImpact): boolean {
  return i.streamResets === 0 && i.wsResets === 0 && i.wsOpenFailures === 0 && i.shortFailures === 0;
}

export function describeImpact(i: TrafficImpact): string {
  return `流重置 ${i.streamResets}，WebSocket 重置 ${i.wsResets}，WebSocket 重连失败 ${i.wsOpenFailures}，短请求失败 ${i.shortFailures}/${i.shortTotal}`;
}
