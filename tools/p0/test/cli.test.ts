import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { EXIT } from '../src/errors.js';
import { createMemoryOutput, createScriptedPrompter } from '../src/io.js';
import type { ExecFn } from '../src/system.js';

const noExec: ExecFn = async () => ({ stdout: '', stderr: '', code: -1 });

function rawBase(): string {
  return join(mkdtempSync(join(tmpdir(), 'sfe-p0-cli-')), 'p0');
}

function deps(answers: string[] = [], opts: { yes?: boolean } = {}) {
  const out = createMemoryOutput();
  return { out, prompt: createScriptedPrompter(answers, { assumeYes: opts.yes }), exec: noExec, home: '/nonexistent-home', platform: 'linux' as const, env: {}, sleep: async () => undefined };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('main', () => {
  it('refuses secrets on the command line without echoing them', async () => {
    const d = deps();
    expect(await main(['inventory', '--password', 'example-secret-value'], d)).toBe(EXIT.USAGE);
    expect(d.out.text()).toContain('不能出现密码');
    expect(d.out.text()).not.toContain('example-secret-value');
  });

  it('reports unknown commands as usage errors', async () => {
    const d = deps();
    expect(await main(['switch-profile'], d)).toBe(EXIT.USAGE);
    expect(d.out.text()).toContain('未知命令');
  });

  it('refuses a raw directory inside the repository', async () => {
    const d = deps();
    expect(await main(['inventory', '--raw-dir', join(process.cwd(), 'tools', 'p0', 'out')], d)).toBe(EXIT.REFUSED);
    expect(d.out.text()).toContain('Git 工作树');
  });

  it('inventory on a machine without Surge records unavailable primitives and a failed takeover result', async () => {
    const base = rawBase();
    const d = deps();
    expect(await main(['inventory', '--raw-dir', base], d)).toBe(EXIT.OK);
    const [runId] = readdirSync(base).filter((n) => n !== 'latest');
    const inv = JSON.parse(readFileSync(join(base, runId!, 'inventory.json'), 'utf8'));
    expect(inv.proposedMechanism.reloadProfile).toBe('unavailable');
    expect(Object.values(inv.proposedMechanism).every((v) => v === 'unavailable')).toBe(true);
    const takeover = JSON.parse(readFileSync(join(base, runId!, 'results', 'takeover_state_readable.json'), 'utf8'));
    expect(takeover.verdict).toBe('fail');
    expect(d.out.text()).toContain('建议的 adapterMechanism');
  });

  it('make-test-profile refuses without running test servers', async () => {
    const base = rawBase();
    await main(['inventory', '--raw-dir', base], deps());
    const d = deps();
    expect(await main(['make-test-profile', '--raw-dir', base], d)).toBe(EXIT.REFUSED);
    expect(d.out.text()).toContain('test-servers');
  });

  it('checklist refuses capabilities measured by commands', async () => {
    const base = rawBase();
    await main(['inventory', '--raw-dir', base], deps());
    const d = deps();
    expect(await main(['checklist', 'runtime_entry_modes', '--raw-dir', base], d)).toBe(EXIT.REFUSED);
    expect(d.out.text()).toContain('entry');
  });

  it('checklist then propose --dry-run builds a proposal with a keyed evidence digest', async () => {
    const base = rawBase();
    await main(['inventory', '--raw-dir', base], deps());
    // 8 项：往返、Safari 重开、重启、服务重启、服务升级、后台唤醒（含上报闹钟）、无系统提示（只说明宿主 App）、
    // macOS 26 退出提示（更早的系统写不适用）
    const answers = [
      'y', '',
      'y', '',
      'y', '',
      'y', '',
      'y', '',
      'y', '后台卸载后 3 秒内完成往返；后台卸载后闹钟到点约 20 秒内 service.log 出现 reportProfileState',
      'y', '宿主 App 无提示；扩展访问以 roundtrip 为准',
      'y', '不适用（测试机为 macOS 15）',
    ];
    expect(await main(['checklist', 'native_bridge_ipc', '--raw-dir', base, '--signing-identity', 'ABCDE12345'], deps(answers))).toBe(EXIT.OK);
    const d = deps();
    expect(await main(['propose', 'native_bridge_ipc', 'supported', '--dry-run', '--raw-dir', base, '--signing-identity', 'ABCDE12345'], d)).toBe(EXIT.OK);
    const [runId] = readdirSync(base).filter((n) => n !== 'latest');
    const [file] = readdirSync(join(base, runId!, 'proposals'));
    const saved = JSON.parse(readFileSync(join(base, runId!, 'proposals', file!), 'utf8'));
    expect(saved.request).toMatchObject({ key: 'native_bridge_ipc', proposed_status: 'supported' });
    expect(saved.request.evidence_digest).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(saved.request.context.signingIdentity).toBe('ABCDE12345');
    expect(saved.manifest.files.some((f: { path: string }) => f.path === 'results/native_bridge_ipc.json')).toBe(true);
    expect(d.out.text()).toContain('--dry-run：没有发送');
  });

  it('propose refuses supported when the checklist was not passed', async () => {
    const base = rawBase();
    await main(['inventory', '--raw-dir', base], deps());
    await main(['checklist', 'open_profile_by_id', '--raw-dir', base], deps(['n', '没有公开 API', '', '']));
    const d = deps();
    expect(await main(['propose', 'open_profile_by_id', 'supported', '--dry-run', '--raw-dir', base], d)).toBe(EXIT.REFUSED);
    expect(await main(['propose', 'open_profile_by_id', 'unsupported', '--dry-run', '--raw-dir', base], deps())).toBe(EXIT.OK);
  });

  it('propose sends the request to agent.sock and reports the proposal id', async () => {
    const base = rawBase();
    await main(['inventory', '--raw-dir', base], deps());
    await main(['checklist', 'profile_batch_create', '--raw-dir', base], deps(['n', '', 'y', '向导步骤已记录']));
    const dataDir = mkdtempSync(join(tmpdir(), 'sfe-p0-svc-'));
    const received: unknown[] = [];
    const server = createServer((s) => {
      let buf = '';
      s.on('data', (c) => {
        buf += c.toString();
        if (buf.includes('\n')) {
          received.push(JSON.parse(buf.slice(0, buf.indexOf('\n'))));
          s.end(`${JSON.stringify({ ok: true, data: { proposal_id: 'prop_test' } })}\n`);
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(join(dataDir, 'agent.sock'), () => r()));
    const d = deps();
    expect(await main(['propose', 'profile_batch_create', 'unsupported', '--raw-dir', base, '--data-dir', dataDir], d)).toBe(EXIT.OK);
    expect(d.out.text()).toContain('prop_test');
    expect(d.out.text()).toContain('网页后台');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ v: 1, op: 'proposeCapability', args: { key: 'profile_batch_create', proposed_status: 'unsupported' } });
  });

  it('propose reports an unreachable service', async () => {
    const base = rawBase();
    await main(['inventory', '--raw-dir', base], deps());
    await main(['checklist', 'profile_batch_create', '--raw-dir', base], deps(['n', '', 'n', '']));
    const d = deps();
    expect(await main(['propose', 'profile_batch_create', 'unsupported', '--raw-dir', base, '--data-dir', mkdtempSync(join(tmpdir(), 'sfe-p0-none-'))], d)).toBe(EXIT.ERROR);
    expect(d.out.text()).toContain('agent.sock');
  });

  it('rollback prints the plan and needs --execute to change anything', async () => {
    const base = rawBase();
    await main(['inventory', '--raw-dir', base], deps());
    const d = deps();
    expect(await main(['rollback', '--raw-dir', base], d)).toBe(EXIT.OK);
    expect(d.out.text()).toContain('没有需要删除的本工具规则');
    expect(d.out.text()).toContain('只打印');
  });
});
