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

  it('native sections measure what Apple leaves open: default-profile ID, embedded provisioning profile, macOS 26 quit prompt', () => {
    const section = (key: string) => {
      const start = text.indexOf(` ${key}（`);
      return text.slice(start, text.indexOf('\n### ', start));
    };
    const profile = section('native_profile_id');
    expect(profile).toContain('Perform normal browsing tasks.');
    expect(profile).toContain('未识别当前场景');
    expect(profile).not.toContain('加上默认场景都启用扩展');
    const persistence = section('extension_install_persistence');
    expect(persistence).toContain('embedded.provisionprofile');
    expect(persistence).toContain('Unlike Apple’s other platforms, macOS doesn’t require a provisioning profile to run third-party code.');
    expect(persistence).toContain('In Safari 17 or later, use the Developer tab in Settings');
    const bridge = section('native_bridge_ipc');
    expect(bridge).toContain('`quit_prompt`');
    expect(bridge).toContain('sfltool dumpbtm');
    // ps 的 comm 是 argv[0]，V1 只作候选
    const v1 = text.split('\n').find((l) => l.startsWith('| V1 |'))!;
    expect(v1).toContain('argv[0]');
  });

  it('report alarm steps: the delay expression handles a fired alarm, and the wake test schedules its own alarm after the background unloads', () => {
    const start = text.indexOf(' native_bridge_ipc（');
    const bridge = text.slice(start, text.indexOf('\n### ', start));
    // 闹钟已到点时 get() 没有结果；`(…)?.scheduledTime - Date.now()` 会得到 NaN 而不是 undefined
    expect(bridge).toContain("const a = await browser.alarms.get('sfe-profile-report'); a ? a.scheduledTime - Date.now() : '已到点'");
    expect(bridge).not.toContain("?.scheduledTime - Date.now()");
    // 新建标签页本身就会唤醒后台：唤醒测试由检查器创建闹钟、确认后台已卸载、之后不再操作 Safari
    expect(bridge).toContain("browser.alarms.create('sfe-profile-report', { delayInMinutes: 2 })");
    expect(bridge).toContain('确认后台已卸载');
    expect(bridge).toContain('不能**用它证明闹钟能唤醒已卸载的后台');
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
    for (const s of ['免费 Apple ID 签名', '接管与出站模式可读性', '页面登录身份', '不关闭，直接继续', '最低 Surge 版本', '维护重载', '秘密以明文保存（不使用钥匙串）']) expect(text).toContain(s);
    // 用户决定（2026-10-23）不使用钥匙串：不再声称钥匙串保护
    expect(text).not.toContain('钥匙串的保护范围');
  });

  it('records the 6.10 version cross-check and the measured watcher behaviour in the environment table', () => {
    for (const row of ['| 版本交叉核对（surge-cli --raw version 一致、Controller 协议 ≥ 22） | 未验证 |', '| 本地 policy-path 是否被自动重新读取及延迟（3.11 实测） | 未验证 |', '| 新临时规则的插入位置（entry 插入探测） | 未验证 |']) {
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

  it('records the no-keychain, plain-text secrets decision with the user question, the overridden design lines and the honest consequence', () => {
    expect(s0).toContain('**秘密的存放（用户决定，2026-10-23；偏离方案 1 设计第 195–199 行、实时同步设计第 13、22、80 行、固定工作配置设计第 73 行，以及 docs/DEVELOPMENT.md 第 9、35 行');
    expect(s0).toContain('为什么要访问我本机的钥匙串？这个项目拿到的ip账号密码，亚马逊账号密码等信息默认保存在自己的一套资料里，不需要从钥匙串中读取');
    expect(s0).toContain('任何以同一 macOS 用户身份运行的进程都能直接读取 `sfe.sqlite`');
    expect(s0).toContain('时间机器');
    expect(s0).not.toContain('**登录填充依赖已过时的钥匙串接口。**');
  });

  it('deleted secrets are zeroed (secure_delete + WAL truncation), and legacy data dirs are refused before migrating', () => {
    expect(text).not.toContain('服务没有开启 SQLite 的 `secure_delete`');
    expect(text).not.toContain('被删除的旧值可能留在空闲页或 WAL 中');
    expect(s0).toContain('`wal_checkpoint(TRUNCATE)`');
    expect(text).not.toContain('检测在迁移之后执行');
    expect(text).toContain('检测在迁移之前执行，拒绝时数据库原样保留');
    expect(text).toContain('完整的中文说明 `message`');
  });

  it('the -wal truncation never waits for another reader (deferred to a later delete, sweep or stop), and profile backups never copy the generated files that hold buyer proxy credentials', () => {
    expect(s0).toContain('这次 checkpoint 不等待锁（执行时临时把 `busy_timeout` 设为 0）');
    expect(s0).toContain('`SecretStore.flush`');
    expect(s0).toContain('配置备份从不复制本应用生成的文件（`sfe-nodes.list` 与四个 `sfe-entry-*.list`');
    const install = read('INSTALL.md');
    expect(install).not.toContain('截断可能推迟到下一次删除或服务停止）');
    expect(install).toContain('服务不等待它：这次截断不做，推迟到之后的删除、下一次清理');
    expect(install).toContain('不复制本应用生成的 `sfe-nodes.list` 与 `sfe-entry-*.list`');
  });

  it('§6.1 states what cancelling does per operation kind and that an accepted cancel wins over a queued verification result', () => {
    expect(text).not.toContain('取消（`cancelOperation`）只适用于等待中的路由操作：激活/重测按 §6.3.14 回滚');
    expect(text).toContain('Safari 重测（`probeKind` safari，含第 1 步复用时改为重测的激活，§6.4）只把检测结束为 FAILED，不回滚');
    // 通常不改变路由，例外是共同结束点（§6.3 第 14 步）：不无条件承诺路由不变
    expect(text).toContain('这两种通常不改变路由，例外是 §6.3 第 14 步的共同结束点');
    expect(text).toContain('已受理的取消优先，旧请求的结果不能覆盖新请求');
  });

  it('does not promise that replaced proxy credentials leave secret_values at the next sweep (they wait for the old revision to retire)', () => {
    expect(s0).not.toContain('被替换、清除或回收的旧值在清扫（启动时与每小时）时删除');
    expect(s0).toContain('被替换或清除的账号密码（以及删除环境时的账号密码）在同一事务中标为 orphaned，下一次清扫（启动时与每小时）删除');
    expect(s0).toContain('只有该版本在发布结算时 retired 之后的清扫才删除');
    expect(s0).toContain('部署新版本的那次发布仍保留旧节点');
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

  it('follows Apple: site access is granted once for all profiles, extensions are enabled per profile, and binding uses named profiles', () => {
    expect(text).toContain('across all profiles, private browsing, and browsing without a profile');
    expect(text).toContain('By default, extensions are turned off for each new profile.');
    expect(text).toContain('网站授权只需一次');
    expect(text).not.toContain('新建场景后需要重复本步');
    expect(text).not.toContain('不能替你给以后新建的场景自动授权');
    expect(text).toContain('Perform normal browsing tasks.');
    expect(text).toContain('**已命名** Safari 场景');
  });

  it('states Safari 17.6 as the minimum, the Developer tab for unsigned extensions and the macOS 26 quit prompt', () => {
    expect(text).toContain('Safari 17.6 或更高');
    expect(text).toContain('Fixed an issue where Safari Web Extension background pages would stop responding after about 30 seconds.');
    expect(text).not.toContain('macOS 14（Safari 17）或更高');
    expect(text).toContain('In Safari 17 or later, use the Developer tab in Settings');
    expect(text).not.toContain('「开发」菜单中的「允许未签名扩展」');
    expect(text).toContain('if background tasks are started by an app and remain active after a user quits the app');
    expect(text).toContain('登录项与扩展');
  });

  it('does not overstate keychain protection or the 7-day profile (TN3125: no profile needed without restricted entitlements)', () => {
    expect(text).not.toContain('拿到引用也读不到');
    expect(text).not.toContain('但读不到账号密码');
    expect(text).toContain('A Mac app that uses no restricted entitlements doesn’t need a provisioning profile.');
    expect(text).not.toContain('过期前需要在 Xcode 中重新构建运行');
  });

  it('states plain-text secrets honestly and explains the legacy keychain data directory (user decision 2026-10-23)', () => {
    expect(text).toContain('**本应用不使用 macOS 钥匙串**');
    expect(text).toContain('**`<数据目录>/sfe.sqlite`（及 `-wal`/`-shm`）：全部代理凭据、亚马逊账号密码与 pepper 的明文。**');
    expect(text).not.toContain('账号密码只存在钥匙串');
    expect(text).not.toContain('一次性钥匙串引用');
    const legacy = text.slice(text.indexOf('## 7. 从使用钥匙串的旧版本升级'));
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy).toContain('legacy_keychain_data');
    expect(legacy).toContain('while security delete-generic-password -s "$s" >/dev/null; do :; done');
    expect(legacy).toContain('for s in com.sfe.proxy com.sfe.account com.sfe.system; do');
    // 手动撤销旧临时规则时逐条移除，从不建议 flush（会清掉用户自己的临时规则）
    expect(legacy).toContain('不要用 `rule temp flush`');
  });

  it('legacy upgrade: the refusal leaves the data dir to the old version, the log carries the message, and the App is quit before the move', () => {
    const legacy = text.slice(text.indexOf('## 7. 从使用钥匙串的旧版本升级'));
    expect(legacy).not.toContain('之后装回旧版本也打不开这个数据目录');
    expect(legacy).toContain('检查在数据库迁移之前进行，拒绝时数据库原样保留');
    expect(legacy).toContain('`message` 字段是完整的中文说明');
    // 新版本 App 改写 install.json，但保留旧服务需要的 keychainHelperPath；装回旧版本后先打开旧 App，停止过的服务重新注册
    expect(legacy).not.toContain('拒绝时数据目录原样保留');
    expect(legacy).toContain('但保留旧版本的钥匙串工具路径 `keychainHelperPath`');
    expect(legacy).toContain('**打开一次旧版本 App**');
    expect(legacy).toContain('已经在新版本中「停止后台服务」时在旧版本菜单中「注册后台服务」');
    // App 只在启动时准备数据目录：改名前退出、之后重新打开（打开仍在运行的 App 什么也不创建）
    expect(legacy).toContain('再选菜单「退出」**退出 App**');
    expect(legacy).toContain('重新打开 App（第 4 步已退出，这是一次新的启动');
  });

  it('the host App keeps the old keychainHelperPath in install.json (rollback to the Keychain version needs it)', () => {
    const install = text.slice(text.indexOf('## 2. 安装'), text.indexOf('## 3.'));
    expect(text).not.toContain('`keychainHelperPath` 在合并时删除');
    expect(install).toContain('合并从不删除字段：旧版本写入的钥匙串工具路径 `keychainHelperPath` 原样保留');
    const arch = read('ARCHITECTURE.md');
    expect(arch).not.toContain('时删除旧版本写入的 `keychainHelperPath`');
    expect(arch).toContain('宿主 App 合并 `install.json` 时从不删除字段，旧版本写入的 `keychainHelperPath` 原样保留');
    expect(arch).not.toContain('（数据库迁移之前，不改动数据目录）');
    const macReadme = readFileSync(new URL('../../../apps/macos/README.md', import.meta.url), 'utf8');
    expect(macReadme).not.toContain('在合并时删除');
    expect(macReadme).not.toContain('含删除旧版本留下的 `keychainHelperPath`');
    expect(macReadme).toContain('保留旧版本留下的 `keychainHelperPath`');
  });

  it('describes how deleted secrets are removed from disk instead of denying secure_delete', () => {
    expect(text).not.toContain('服务没有开启 SQLite 的 `secure_delete`');
    expect(text).toContain('数据库开启了 SQLite 的 `secure_delete`');
    expect(text).toContain('每删除一个值（清理与导入一次删除一批时，在这一批结束时）就把 `-wal` 写回数据库并截断为 0 字节');
  });

  it('§6 separates account passwords (next sweep) from proxy credentials (only after the old revision retires)', () => {
    expect(text).not.toContain('修改、清除或删除环境后，旧值在下一次清理时');
    expect(text).toContain('**账号密码**：修改、清除密码或删除环境后，旧值在下一次清理时（服务启动时与之后每小时）删除。');
    expect(text).toContain('**代理用户名与密码**：旧值属于旧的代理版本，要等这个版本“退役”（retired）之后的下一次清理才删除。');
    expect(text).toContain('部署新版本的那次发布仍保留旧节点');
    expect(text).toContain('旧值一直留在 `secret_values` 中，通常也仍在 `sfe-nodes.list` 中，没有期限');
  });

  it('§7 stops the old service before the App is replaced and reuses old P0 runs with --raw-dir', () => {
    const legacy = text.slice(text.indexOf('## 7. 从使用钥匙串的旧版本升级'));
    // 替换 App 不重启已在运行的旧服务：先停止，否则旧服务继续应答新扩展
    expect(legacy).toContain('**然后先在旧版本的菜单中「停止后台服务」，再安装新版本 App**');
    expect(legacy).toContain('本机服务的填充应答格式不符');
    // 第 4 步把 p0/ 一起改名：propose 默认找不到旧运行，要指向旧的证据目录
    expect(legacy).toContain('--raw-dir "$HOME/Library/Application Support/SafariProfileSurge.keychain-old/p0"');
    expect(legacy).toContain('`propose` 会重新测量当前上下文，与测量时不一致');
  });
});

describe('docs/ARCHITECTURE.md §0.1 and apps/macos/README.md (Apple documentation check)', () => {
  const arch = read('ARCHITECTURE.md');
  const s0 = arch.slice(arch.indexOf('## 0.'), arch.indexOf('## 1.'));
  const macReadme = readFileSync(new URL('../../../apps/macos/README.md', import.meta.url), 'utf8');

  it('§0 summarises the Apple-doc architecture risks with quotes, URLs and the measurement that decides each', () => {
    const risks = s0.slice(s0.indexOf('### 0.1 Apple 官方文档核对的架构风险'));
    expect(risks.length).toBeGreaterThan(0);
    for (const [title, measurement, url] of [
      ['**签名：Personal Team 能否作为正式交付', '`extension_install_persistence`', 'https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles'],
      ['**原生桥依赖 App Group 容器。**', '`native_bridge_ipc`', 'https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes'],
      ['**默认场景可能拿不到场景 ID。**', '`native_profile_id`', 'https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension'],
      ['**进程归属与后台安全改进（BSI）。**', '`safari_process_attribution`', 'https://support.apple.com/guide/security/background-security-improvements-sec87fc038c2/web'],
    ] as const) {
      const at = risks.indexOf(title);
      expect(at, title).toBeGreaterThanOrEqual(0);
      const next = risks.indexOf('\n\n', risks.indexOf('由谁决定', at));
      const item = risks.slice(at, next === -1 ? undefined : next);
      expect(item, title).toContain(measurement);
      expect(item, title).toContain(url);
    }
    expect(s0).toContain('**最低系统**：macOS 14、Safari 17.6 或更高');
    expect(arch).not.toContain('拿到引用也读不到');
    expect(arch).toContain('`comm` 是进程自己提供的 argv[0]');
  });

  it('apps/macos/README.md drops unsupported keychain claims and per-profile site grants', () => {
    expect(macReadme).not.toContain('对文件型钥匙串在 macOS 14 上仍有效');
    expect(macReadme).not.toContain('不能替用户给未来的场景自动授权');
    expect(macReadme).not.toContain('（开发菜单）');
    expect(macReadme).not.toContain('各场景（含默认场景）');
    expect(macReadme).toContain('Safari 17.6 或更高');
    expect(macReadme).toContain('**只需一次**');
  });

  it('apps/macos/README.md gives the INSTALL §7 upgrade order for a legacy keychain data directory', () => {
    const note = macReadme.slice(macReadme.indexOf('- 用旧的钥匙串版本创建的数据目录不能直接沿用'), macReadme.indexOf('## 秘密与日志'));
    expect(note).toContain('docs/INSTALL.md §7');
    expect(note).toContain('**顺序不能颠倒**');
    expect(note).not.toContain('需要重新初始化（重新导入）。旧版本留在钥匙串中的项');
    // 先撤销旧入口，再停服务、退出 App、改名数据目录、删除旧 Surge 文件，最后重新初始化与导入
    const order = ['进入普通模式', '临时规则', '停止后台服务', '退出', '改名保存', '新的数据目录', '日常-Safari环境.conf', '重新初始化', '重新导入'].map((k) => note.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('docs/ARCHITECTURE.md §6.1, §6.3 step 14 and §6.4 (route end points)', () => {
  const text = read('ARCHITECTURE.md');

  it('the crash-superseded switch is an end point that may move SFE-ROUTE to REJECT, consistently in §6.1 and §6.3 step 14', () => {
    expect(text).not.toContain('不回滚、不写入 Surge，记为 `SUPERSEDED`');
    expect(text).toContain('不回滚、不改写入口，记为 `SUPERSEDED`（`superseded_by` 为接手的操作，步骤写明）；接手的操作已结束而 Safari 仍可能经未验证的出口时');
    expect(text).toContain('崩溃恢复中被之后的操作取代的切换（接手的操作已结束时）');
  });

  it('waiting and re-test cancels and timeouts do not promise an unchanged route unconditionally; an end point that selected REJECT ends as needing attention', () => {
    expect(text).not.toContain('只把检测结束为 FAILED，路由不变、不回滚');
    expect(text).not.toContain('超时或取消只把本次重测结束为 FAILED，路由不变（');
    expect(text).not.toContain('截止仍未到达 → 结束为 `READY_FOR_NEXT_OPEN`（下一步「切换到新版本」），路由不变。');
    expect(text).toContain('都结束为 `BLOCKED_NEEDS_ATTENTION`（needs_attention；错误保留原来的代码，没有错误时 `UNKNOWN_STATE`）');
    expect(text).toContain('或路由记在另一个未结束（排队、执行中、等待中）的操作名下——不论路由阶段');
  });
});

describe('the Surge-directory temp files of atomic writes are listed where secrets live and in the delete lists (ARCHITECTURE §2, INSTALL §5–§7)', () => {
  it('lists `.<file>.sfe-tmp-<hex>` with the startup sweep and in the uninstall and upgrade delete steps', () => {
    const arch = read('ARCHITECTURE.md');
    const install = read('INSTALL.md');
    const s2 = arch.slice(arch.indexOf('## 2.'), arch.indexOf('## 3.'));
    expect(s2).toContain('`.<文件名>.sfe-tmp-<16 位十六进制>`');
    expect(s2).toContain('sweepProfileTempFiles');
    const s5 = install.slice(install.indexOf('## 5.'), install.indexOf('## 6.'));
    const s6 = install.slice(install.indexOf('## 6.'), install.indexOf('## 7.'));
    const s7 = install.slice(install.indexOf('## 7.'));
    expect(s5).toContain('.sfe-tmp-<16 位十六进制>');
    expect(s6).toContain('.sfe-tmp-<16 位十六进制>');
    expect(s7).toContain('.sfe-tmp-<16 位十六进制>');
  });
});

describe('persisted digests cannot verify replaced passwords offline (ARCHITECTURE §0 and §4, INSTALL §6, ACCEPTANCE)', () => {
  it('describes the v2 request digest, the fingerprints cleared at retirement and migration 3 instead of "unchanged fingerprint rules"', () => {
    const arch = read('ARCHITECTURE.md');
    expect(arch).not.toContain('回收、指纹与 pepper 的规则不变');
    expect(arch).not.toContain('`request_digest`（对秘密值做 HMAC 后的规范形式的带密钥摘要）');
    expect(arch).toContain('`v2:<shape>:<进程标记>:<full>`');
    expect(arch).toContain('代理版本退役时清除它的用户名与密码指纹');
    expect(arch).toContain('`scrubbed-v1`');
    expect(arch).toContain('服务重新启动之后，同一 `request_id`、不带秘密值、内容相同的请求按重复返回原操作；带秘密值');
    expect(arch).not.toContain('服务重新启动之后，同一 `request_id`、秘密以外的内容相同的请求按重复返回原操作');
    // 维护操作不保存预览摘要（迁移 4 删除升级前的）
    expect(arch).toContain('操作中只保存进程内随机密钥下的核对值（`previewCheck`）');
    expect(arch).toContain('迁移 4 删除升级前保存的 `previewDigest`');
    expect(read('INSTALL.md')).toContain('数据库里也没有能用来离线核对猜测旧值的摘要');
    expect(read('ACCEPTANCE.md')).toContain('不能用于离线核对已替换、已清扫的旧密码');
  });
});
