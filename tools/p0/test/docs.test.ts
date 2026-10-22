// 文档与契约保持一致：手册与验收模板逐字引用 CAPABILITY_CRITERIA，覆盖每一项能力；
// 验收模板的每个结果格子初始为「未验证」。
import { readFileSync } from 'node:fs';
import { CAPABILITY_CRITERIA, CAPABILITY_KEYS, CAPABILITY_LABELS } from '@sfe/contract';
import { describe, expect, it } from 'vitest';

const read = (name: string): string => readFileSync(new URL(`../../../docs/${name}`, import.meta.url), 'utf8');

describe('docs/P0-RUNBOOK.md', () => {
  const text = read('P0-RUNBOOK.md');

  it('has a section and the verbatim pass criteria for every capability', () => {
    for (const key of CAPABILITY_KEYS) {
      expect(text).toMatch(new RegExp(`^### \\d+\\.\\d+ ${key}（`, 'm'));
      expect(text).toContain(`**通过条件**：${CAPABILITY_CRITERIA[key]}`);
    }
    expect(text).not.toContain('{{CRITERIA');
  });

  it('every capability section covers purpose, steps, failure handling, evidence and rollback', () => {
    const sections = text.split(/^### /m).filter((s) => CAPABILITY_KEYS.some((k) => s.includes(` ${k}（`)));
    expect(sections).toHaveLength(CAPABILITY_KEYS.length);
    for (const s of sections) {
      for (const label of ['**用途**', '**步骤**', '**通过条件**', '**失败处理**', '**证据**', '**回退**']) expect(s).toContain(label);
    }
  });

  it('documents the read-only running-instance checks V1–V10 and the instance command', () => {
    expect(text).toMatch(/^### 1\.5 运行中 Surge 的版本（只读核对 V1–V10）/m);
    for (let i = 1; i <= 10; i++) expect(text).toMatch(new RegExp(`^\\| V${i} \\|`, 'm'));
    for (const s of ['instance [--surge-team-id', '--self-test-bundle', 'test.sfe.p0.instance-selftest', '不要为了测试而触发更新', 'SURGE_BUNDLE_IDS', 'TODO(P0)', 'inventory/surge-instance.json']) expect(text).toContain(s);
    // PR #5 的过渡说明已被替换：版本读取已经实现（仍待测试 Mac 核对）
    expect(text).not.toContain('运行实例版本读取仍待实现与验证');
    expect(text).toContain('从**运行中的 Surge 实例**取得');
  });

  it('V6 defines RUN as an absolute $HOME path (instance prints ~, which does not expand inside quotes) and builds a new scratch app per case', () => {
    const v6 = text.slice(text.indexOf('V6 的步骤'), text.indexOf('## 2. 通用回退'));
    expect(v6).toContain('RUN="$HOME/Library/Application Support/SafariProfileSurge/p0/<运行编号>"');
    expect(v6).not.toMatch(/RUN="~/);
    expect(v6).toContain('绝对路径');
    expect(v6).toMatch(/APP="\$DIR\/SFE-P0-Selftest\.app"/);
    expect(v6).toContain('DIR="$RUN/selftest/$CASE-$(date +%Y%m%d%H%M%S)"');
    expect(v6).toContain('instance --run <运行编号> --self-test-bundle "$APP"');
  });

  it('documents the overall order and the manual profile switch', () => {
    for (const cmd of ['inventory', 'instance', 'test-servers', 'make-test-profile', 'attribution', 'entry', 'refresh', 'continuity', 'chain', 'charset', 'preflight', 'checklist', 'propose', 'rollback']) {
      expect(text).toContain(cmd);
    }
    expect(text).toContain('手动');
    expect(text).toContain('SFE-P0-测试');
  });
});

describe('docs/ACCEPTANCE.md', () => {
  const text = read('ACCEPTANCE.md');

  it('has one table per capability with label and criteria', () => {
    for (const key of CAPABILITY_KEYS) {
      expect(text).toContain(`${key}（${CAPABILITY_LABELS[key]}）`);
      expect(text).toContain(CAPABILITY_CRITERIA[key]);
    }
  });

  it('uses the DEVELOPMENT §9 evidence columns and protocol rows', () => {
    expect(text).toContain('| 测试编号 | 时间 | 场景代号 | 扩展/入口状态 | 期望节点 | Surge 实际策略 | 实际出口 | 连接处理结果 | 配置身份 | 对照应用结果 |');
    for (const row of ['HTTP', 'HTTPS', 'HTTP/2', 'HTTP/3（QUIC）', 'WebSocket', 'WebRTC', 'DNS', 'IPv6', '系统服务']) expect(text).toContain(`| ${row} | 未验证 |`);
  });

  it('every result cell starts as 未验证', () => {
    const rows = text
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| 协议') && !l.startsWith('| 检查项') && !l.startsWith('| 项目') && !l.startsWith('| 限制') && !l.startsWith('|---'));
    expect(rows.length).toBeGreaterThan(300);
    for (const r of rows) {
      const cells = r.split('|').slice(1, -1).map((c) => c.trim());
      expect(cells.at(-1)).toBe('未验证');
    }
  });

  it('lists the known limitations', () => {
    for (const s of ['免费 Apple ID 签名', '接管与出站模式可读性', '页面登录身份', '不关闭，直接继续']) expect(text).toContain(s);
  });
});

describe('docs/INSTALL.md', () => {
  const text = read('INSTALL.md');

  it('covers build, install, first run, uninstall and security notes', () => {
    for (const s of ['xcodegen generate', 'Personal Team', '注册后台服务', 'www.amazon.com', '日常-Safari环境', '先进入普通模式', 'com.sfe.proxy', 'bridge.token', '同一用户的本机进程']) {
      expect(text).toContain(s);
    }
  });

  it('never instructs the tool to switch profiles or bulk-delete certificates', () => {
    expect(text).toContain('工具从不调用 switch-profile');
    expect(text).toContain('不批量删除证书');
  });
});
