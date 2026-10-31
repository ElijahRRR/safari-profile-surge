// 本机资源服务测试的公共部分：合成令牌（'a'.repeat(64)）、范围内的固定端口、记录日志器与请求构造。
import { NODE_RESOURCE_FILE } from '@sfe/contract';
import type { LogLevel, Logger } from '../../src/ports.js';
import type { ResourceRequest, ResourceResponse } from '../../src/resource/index.js';

export const TOKEN = 'a'.repeat(64);
export const OTHER_TOKEN = 'b'.repeat(64);
export const PORT = 23456;
export const PATH = `/${TOKEN}/${NODE_RESOURCE_FILE}`;

export interface LogEntry {
  level: LogLevel;
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export type RecordingLogger = Logger & { entries: LogEntry[]; text(): string };

export function recordingLogger(scope = 'test'): RecordingLogger {
  const entries: LogEntry[] = [];
  const make = (s: string): Logger => ({
    log(level, msg, fields) {
      entries.push(fields === undefined ? { level, scope: s, msg } : { level, scope: s, msg, fields });
    },
    child(child) {
      return make(`${s}.${child}`);
    },
  });
  return Object.assign(make(scope), { entries, text: () => JSON.stringify(entries) });
}

/** 合格的进程内请求（Host 与地址都是回环），可逐项覆盖。 */
export function goodRequest(over: Partial<Omit<ResourceRequest, 'localPort'>> = {}, port = PORT): Omit<ResourceRequest, 'localPort'> {
  return {
    method: 'GET',
    rawPath: PATH,
    rawHeaders: ['Host', `127.0.0.1:${port}`, 'User-Agent', 'Surge Mac/2970', 'Accept', '*/*'],
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
    ...over,
  };
}

/** 响应的逐字节表示：状态、按顺序的响应头与响应体（用于证明不同原因的 404 完全相同）。 */
export function wire(r: ResourceResponse): string {
  return JSON.stringify([r.status, Object.entries(r.headers), r.body.toString('hex')]);
}

/** 只含给定节点行的资源内容（合成节点，RFC 5737 地址）。 */
export function sampleContent(generation: number, names: readonly string[] = ['SFE-N-E0001-US01-v001']): string {
  const lines = names.map((n, i) => `${n} = socks5, 192.0.2.${10 + i}, 1080, underlying-proxy=HK-01`);
  return [`# SFE managed resource · generation ${generation}`, ...lines, ''].join('\n');
}
