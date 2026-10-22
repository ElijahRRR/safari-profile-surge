// 文档与契约保持一致：手册与验收模板逐字引用 CAPABILITY_CRITERIA，覆盖每一项能力；
// 验收模板的每个结果格子初始为「未验证」。
import { readFileSync } from 'node:fs';
import { CAPABILITY_CRITERIA, CAPABILITY_KEYS, CAPABILITY_LABELS } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import { SERVICE_CODESIGN_TIMEOUT_MS, SERVICE_INSTANCE_READ_BUDGET_MS, SURGE_MINIMUM } from '../src/deps.js';
import { CLI_HELP_TOPICS } from '../src/surge-access.js';

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

  it('V1 and V5 hold the instance read to the service reader limits (P0 waits longer than the service)', () => {
    const row = (n: number) => text.split('\n').find((l) => l.startsWith(`| V${n} |`))!;
    expect(row(5)).toContain(`在 ${SERVICE_CODESIGN_TIMEOUT_MS / 1000} 秒内完成`);
    expect(row(1)).toContain(`合计在 ${SERVICE_INSTANCE_READ_BUDGET_MS / 1000} 秒内`);
    expect(text).toContain('instance 同时按服务的时限核对');
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

  it('V6 command blocks carry no # comments: macOS zsh (interactivecomments off) passes them to the command as arguments', () => {
    const v6 = text.slice(text.indexOf('V6 的步骤'), text.indexOf('## 2. 通用回退'));
    const blocks = [...v6.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks).toHaveLength(2);
    for (const line of blocks.join('').split('\n')) {
      // 单引号中的 # 是字面量（printf 写出的 #include）
      expect(line.replace(/'[^']*'/g, "''"), line).not.toContain('#');
    }
    // 第一段建 App 并运行一次 instance；按情况的改动写在正文中；第二段再运行一次并结束进程
    expect(blocks[0]).toContain('CASE=plain\n');
    expect(blocks[0]).toContain('cp -p "$APP/Contents/MacOS/selftest" "$DIR/selftest.copy"\n');
    expect(blocks[0]).toContain('instance --run <运行编号> --self-test-bundle "$APP"\n');
    expect(blocks[1]).toBe('npx tsx tools/p0/src/cli.ts instance --run <运行编号> --self-test-bundle "$APP"\nkill "$SELFTEST_PID"\n');
    for (const c of ['plutil -convert xml1 -o "$DIR/Info.new" "$APP/Contents/Info.plist" && mv "$DIR/Info.new" "$APP/Contents/Info.plist"', 'mv "$DIR/selftest.copy" "$APP/Contents/MacOS/selftest"', 'xattr -w com.example.sfe-p0 1 "$APP"']) {
      expect(v6).toContain(`\`${c}\``);
    }
    expect(v6).toContain('--raw-dir <目录>');
  });

  it('targets Surge Mac 6.10.0 (12500) with the documented minimum, and V8 is the surge-cli --raw version cross-check', () => {
    expect(text).toContain('Surge Mac 6.10.0 (12500)');
    expect(text).toContain(`最低支持 ${SURGE_MINIMUM.version}、构建 ≥ ${SURGE_MINIMUM.build}、Controller 协议 ≥ ${SURGE_MINIMUM.controllerProtocol}`);
    const row = (n: number) => text.split('\n').find((l) => l.startsWith(`| V${n} |`))!;
    expect(row(8)).toContain('| V8 | 版本交叉核对 |');
    expect(row(8)).toContain('--raw version');
    expect(row(8)).toContain('inventory/surge-version.json');
    // --version 只记录现在的行为，产品与工具从不使用；不再期望它打印交互模式提示
    expect(row(8)).toContain('产品与工具从不使用');
    expect(text).not.toContain('`--version` 在 2 秒内结束并打印交互模式提示');
    // V7 的期望文字来自 6.10 的发布说明与包内文字
    expect(row(7)).toContain("Surge isn't running on the local machine. Use --remote to specify a remote target.");
    expect(row(7)).toContain('Command errors are now written to standard error and produce a non-zero exit status.');
    expect(text).not.toContain('不借用新版本文档中的能力');
  });

  it('describes the per-command help that inventory reads', () => {
    for (const topic of CLI_HELP_TOPICS) expect(text).toContain(`\`help ${topic.join(' ')}\``);
    expect(text).toContain('inventory/surge-cli-help/');
    expect(text).toContain('`--check/-c` 这样的写法按 `--check` 识别');
  });

  it('measures the documented local-file watcher instead of a targeted update, and the 6.9+ reload escalation', () => {
    for (const quote of [
      'Local resources are skipped.',
      'Local files are watched and reloaded automatically when they change.',
      'Automatically performs a full engine restart if a change requires one.',
      '`PROTOCOL,UDP` also matches QUIC and STUN connections.',
      'Add a temporary rule with the highest priority',
    ]) {
      expect(text).toContain(quote);
    }
    // 配置 canary 与引擎运行时长取代规则集 canary 作为重载/重启信号
    const signals = text.slice(text.indexOf('### 1.4'), text.indexOf('### 1.5'));
    expect(signals).toContain('配置 canary');
    expect(signals).toContain('引擎运行时长');
    // 旧机制的说法已移除
    for (const stale of ['temp-rule add', '按 key 定向刷新', '定向刷新被重新读取', 'updateExternalResource(key) 后改变匹配', '资源更新时间前进']) expect(text).not.toContain(stale);
    expect(text).toContain('不要为了测试运行 `restart-engine`');
    expect(text).toContain('### 1.6 文档没有写明、要在测试 Mac 上实测的行为（TODO(P0)）');
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
    for (const s of ['免费 Apple ID 签名', '接管与出站模式可读性', '页面登录身份', '不关闭，直接继续', '最低 Surge 版本', '维护重载']) expect(text).toContain(s);
  });

  it('records the 6.10 version cross-check and the measured watcher behaviour in the environment table', () => {
    for (const row of ['| 版本交叉核对（surge-cli --raw version 一致、Controller 协议 ≥ 22） | 未验证 |', '| 本地 policy-path 是否被自动重新读取及延迟（3.12 实测） | 未验证 |', '| 新临时规则的插入位置（entry 插入探测） | 未验证 |']) {
      expect(text).toContain(row);
    }
  });
});

describe('docs/ARCHITECTURE.md §0', () => {
  const text = read('ARCHITECTURE.md');
  const s0 = text.slice(text.indexOf('## 0.'), text.indexOf('## 1.'));

  it('records the deviations from the design docs: minimum Surge, local-file refresh mechanism, reload semantics, temp_rule texts', () => {
    for (const s of ['**最低 Surge（用户决定', '**节点发布机制（用户决定', '**入口规则（偏离', '**本地文件的重新读取与 P0 测量（偏离', '**reload 语义（6.9.0 起', '**临时规则命令（偏离固定工作配置设计 §3']) {
      expect(s0).toContain(s);
    }
    // 契约措辞已改写：不再说“待文档步骤改写”
    expect(s0).not.toContain('待文档步骤改写');
    expect(text).not.toContain('6.5 没有版本命令');
  });

  it('records the normal-mode conflict when rule match is unavailable instead of claiming normal mode is unaffected', () => {
    expect(s0).toContain('**进入普通模式与 `rule match`（需要指出的冲突');
    expect(s0).toContain('entry_unverified');
    expect(s0).not.toContain('进入普通模式不受影响');
    // CAPABILITY_PRIMITIVES 已调整：不再说仍列 updateExternalResource、没有 matchRule
    expect(s0).not.toContain('仍列 `updateExternalResource`、没有 `matchRule`');
  });

  it('§5.5 scopes the witness and placeholder rules to the synthetic process and quotes the domain-rule doc', () => {
    expect(text).toContain('`AND,((PROCESS-NAME,/var/empty/sfe-entry-witness),(DOMAIN,sfe-entry-<位>-<标记>.invalid))`');
    expect(text).toContain('Domain rules match the hostname of a request. They are the most common rule types and never trigger a DNS lookup');
    expect(text).not.toContain('`.invalid` 永不解析，真实请求不会命中');
  });
});

describe('README.md and docs/DEVELOPMENT.md (read first per CLAUDE.md)', () => {
  const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
  const dev = read('DEVELOPMENT.md');

  it('state the 6.10 minimum and node publishing by file watch, not the 6.5 target or a targeted refresh', () => {
    expect(readme).toContain('最低支持 Surge for Mac 6.10.0（构建 ≥ 12500、Controller 协议 ≥ 22');
    expect(dev).toContain('最低支持 Surge for Mac 6.10.0（构建 ≥ 12500、Controller 协议 ≥ 22）');
    for (const t of [readme, dev]) {
      expect(t).toContain('external-resource update');
      for (const stale of ['本次设计调研的目标版本为 Surge 6.5.0', '定向刷新并读回', '当前仅有 Surge 6.5 的只读命令', '节点资源定向刷新 |', '定向节点刷新']) expect(t).not.toContain(stale);
    }
  });
});

describe('docs/INSTALL.md', () => {
  const text = read('INSTALL.md');

  it('covers build, install, first run, uninstall and security notes', () => {
    for (const s of ['xcodegen generate', 'Personal Team', '注册后台服务', 'www.amazon.com', '日常-Safari环境', '先进入普通模式', 'com.sfe.proxy', 'bridge.token', '同一用户的本机进程']) {
      expect(text).toContain(s);
    }
  });

  it('states the minimum Surge version and that getVersion, matchRule and getCurrentProfile must be mapped to cli', () => {
    expect(text).toContain('Surge for Mac 6.10.0（构建 12500）或更高');
    expect(text).toContain('`getVersion` 必须映射为 `cli`');
    expect(text).toContain('`matchRule` 也必须映射为 `cli`');
    expect(text).toContain('`getCurrentProfile` 必须映射为 `cli`');
    expect(text).not.toContain('开发调研时为 6.5.0');
  });

  it('never instructs the tool to switch profiles or bulk-delete certificates', () => {
    expect(text).toContain('工具从不调用 switch-profile');
    expect(text).toContain('不批量删除证书');
  });
});
