// test-servers：在 127.0.0.1 启动回显/WebSocket/测试页、SOCKS5 出口（必须认证）、SOCKS5 前置，并保持运行。
// 打印测试页地址与合成节点行（合成测试凭据，只对本机测试服务有效）。按 Ctrl+C 停止。

import { VERIFY_ENDPOINTS } from '@sfe/contract';
import { DEFAULT_H3_HOST, DEFAULT_IPV6_HOST, DEFAULT_PORTS, SERVER_LOGS } from '../constants.js';
import { refused, type ExitCode } from '../errors.js';
import { logAction } from '../results.js';
import { portIsFree, readCharsetExpectations, startTestServers } from '../servers/run.js';
import { saveState } from '../state.js';
import { ECHO_HOST, TEST_PROXIES, testNodeLine, type TestPorts } from '../test-profile.js';
import { createRun, ensureCredentials, openRun, type Ctx } from './common.js';

const HOST_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export async function runTestServers(ctx: Ctx, waitForStop: () => Promise<void>): Promise<ExitCode> {
  const { out, now } = ctx.deps;
  let opened;
  try {
    opened = openRun(ctx);
  } catch {
    opened = createRun(ctx);
  }
  const { dir } = opened;
  let state = opened.state;
  const creds = ensureCredentials(dir);
  const n = ctx.args.numbers;
  const ports: TestPorts = {
    echo: n['echo-port'] ?? DEFAULT_PORTS.echo,
    exit: n['exit-port'] ?? DEFAULT_PORTS.exit,
    front: n['front-port'] ?? DEFAULT_PORTS.front,
    deadFront: n['dead-front-port'] ?? DEFAULT_PORTS.deadFront,
  };
  const fixed = Object.values(ports).filter((p) => p !== 0);
  if (new Set(fixed).size !== fixed.length) throw refused('启动测试服务失败：四个端口必须互不相同');
  if (!(await portIsFree(ports.deadFront))) throw refused(`启动测试服务失败：坏前置端口 ${ports.deadFront} 上已有服务，坏前置必须连不上`);
  const h3Host = ctx.args.strings['h3-host'] ?? DEFAULT_H3_HOST;
  const ipv6Host = DEFAULT_IPV6_HOST;
  const extra = ctx.args.lists['allow-upstream'] ?? [];
  for (const h of [h3Host, ...extra]) if (!HOST_RE.test(h)) throw refused('启动测试服务失败：允许的上游必须是域名');
  const allowUpstream = [...new Set([...VERIFY_ENDPOINTS.map((e) => e.host), h3Host, ipv6Host, ...extra].map((h) => h.toLowerCase()))];

  const servers = await startTestServers({
    ports,
    password: creds.password,
    allowUpstream,
    h3Host,
    ipv6Host,
    charsetExpectations: () => readCharsetExpectations(dir),
    log: (file, event) => dir.appendJsonl(SERVER_LOGS[file], event),
    now,
  });
  state = {
    ...state,
    servers: { echoPort: servers.ports.echo, exitPort: servers.ports.exit, frontPort: servers.ports.front, deadFrontPort: ports.deadFront, startedAt: now().toISOString(), allowUpstream, h3Host },
  };
  saveState(dir, state);
  logAction(dir, { at: now().toISOString(), command: 'test-servers', action: 'servers_started', detail: { ...servers.ports } });

  out.heading(`P0 测试服务已启动 · 运行 ${dir.id}`);
  out.table([
    ['服务', '地址', '说明'],
    ['回显 / 测试页', `127.0.0.1:${servers.ports.echo}`, `经 Surge 访问 http://${ECHO_HOST}:${servers.ports.echo}/`],
    ['SOCKS5 出口', `127.0.0.1:${servers.ports.exit}`, '必须认证；测试域名转到回显，允许的上游只限 80/443'],
    ['SOCKS5 前置', `127.0.0.1:${servers.ports.front}`, '只允许连到出口服务'],
    ['坏前置', `127.0.0.1:${ports.deadFront}`, '刻意没有服务'],
  ]);
  out.line(`允许出口转发的公网测试主机：${allowUpstream.join('、')}`);
  out.heading('测试页');
  out.line(`Safari 测试场景（轮询）：http://${ECHO_HOST}:${servers.ports.echo}/app/safari`);
  out.line(`Chrome 对照（轮询）：http://${ECHO_HOST}:${servers.ports.echo}/app/chrome`);
  out.line(`归属测试：http://${ECHO_HOST}:${servers.ports.echo}/attr/safari（Chrome 用 /attr/chrome，其他 WebKit 应用用 /attr/other）`);
  out.heading('合成测试节点行（make-test-profile 会自动写入；只对本机测试服务有效，本次运行结束即失效）');
  out.unredacted(`${TEST_PROXIES.front} = socks5, 127.0.0.1, ${servers.ports.front}`);
  out.unredacted(`${TEST_PROXIES.deadFront} = socks5, 127.0.0.1, ${ports.deadFront}`);
  for (const k of ['a', 'b'] as const) out.unredacted(testNodeLine(k, { ...ports, exit: servers.ports.exit, front: servers.ports.front }, creds.password));
  out.line('日志写入运行目录 servers/*.jsonl。保持本终端运行；按 Ctrl+C 停止。');

  await waitForStop();
  await servers.close();
  logAction(dir, { at: now().toISOString(), command: 'test-servers', action: 'servers_stopped' });
  out.line('测试服务已停止。');
  return 0;
}
