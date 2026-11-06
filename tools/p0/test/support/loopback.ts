// 离线测试用的回环测试资源接线：resource-server 用“双绑定方”——产品的 tcpBinder（真实的 127.0.0.1 端口：拒绝规则探测、
// 同一用户的绑定测试）加上进程内的 virtualBinder（同一个处理程序）；FakeSurge 的 remoteSource 经 virtualBinder 同步下载，所以
// 每一次 Surge 下载都经过产品的 host.handle() 与 P0 的场景包装。响应头声明的长度与写出的内容不符时按截断处理（Connection:
// keep-alive 的只写响应头为不答复），与真实连接上 Surge 看到的一致。不代表真实 Surge 的任何行为。

import {
  tcpBinder,
  virtualBinder,
  loopbackResourceRequest,
  type FakeRemoteSource,
  type Logger,
  type ResourceBinder,
} from '../../src/deps.js';

export function testLogger(): Logger {
  const l: Logger = { log: () => undefined, child: () => l };
  return l;
}

/** 同一处理程序同时绑定真实的 127.0.0.1 端口与进程内注册表（共享 registry 的 virtualBinder）。 */
export function dualBinder(registry: Map<number, unknown>): (logger: Logger) => ResourceBinder {
  return (logger) => {
    const tcp = tcpBinder({ logger });
    const virtual = virtualBinder(registry);
    return {
      async bind(port, handler) {
        const t = await tcp.bind(port, handler);
        try {
          const v = await virtual.bind(port, handler);
          return {
            port,
            async close() {
              await v.close();
              await t.close();
            },
          };
        } catch (e) {
          await t.close();
          throw e;
        }
      },
    };
  };
}

/** 只在进程内注册（不开端口）。 */
export function virtualOnly(registry: Map<number, unknown>): (logger: Logger) => ResourceBinder {
  return () => virtualBinder(registry);
}

/** FakeSurge 的下载来源：经进程内注册表发给当前占用端口的处理程序。 */
export function loopbackSource(registry: Map<number, unknown>): FakeRemoteSource & { requests: number } {
  const v = virtualBinder(registry);
  const source = ((url: string) => {
    source.requests++;
    const target = loopbackResourceRequest(url);
    if (target === null) return { kind: 'refused' as const };
    try {
      const r = v.request(target.port, target.request);
      const declared = Number(r.headers['Content-Length']);
      if (Number.isFinite(declared) && declared !== r.body.length) return r.headers.Connection === 'keep-alive' ? { kind: 'no_response' as const } : { kind: 'truncated' as const };
      return { kind: 'http' as const, status: r.status, body: r.body };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code === 'ECONNREFUSED') return { kind: 'refused' as const };
      if (code === 'ECONNRESET') return { kind: 'reset' as const };
      throw e;
    }
  }) as FakeRemoteSource & { requests: number };
  source.requests = 0;
  return source;
}
