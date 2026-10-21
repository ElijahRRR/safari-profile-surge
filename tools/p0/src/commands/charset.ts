// charset：逐类测试代理凭据字符。每类一个合成节点（用户名/密码开头、中间、结尾都含该类字符）写入测试资源，
// --check 测试配置，定向刷新，逐个选择并经 SFE-ROUTE 发请求，比较出口服务实际收到的值。只有完全一致的类别
// 才算已证明安全；结果用于决定是否放宽 SURGE_SAFE_CREDENTIAL_RE（domain/validate.ts）。入口必须是 NORMAL。

import { NODE_RESOURCE_FILE, ROUTE_GROUP_NAME } from '@sfe/contract';
import { CHARSET_EXPECT_FILE, SERVER_LOGS } from '../constants.js';
import { charsetExpectation, charsetNodeLine, classifyCharset, selectClasses, type CharsetAuthVerdict, type CharsetClassResult } from '../charset.js';
import { resourceFile } from '../deps.js';
import { refused, type ExitCode } from '../errors.js';
import { saveState } from '../state.js';
import { entryFilesForBits, testNodeLine, testNodeResource, type TestPorts } from '../test-profile.js';
import { allowRefreshFor, confirmWrites, loadCredentials, openRun, openSession, requireServers, tryRead, verifyHostOf, proxyOf, type Ctx } from './common.js';
import { TestOps, requestViaRoute } from './test-ops.js';

const RESULT_LABEL: Record<CharsetClassResult, string> = {
  safe: '已证明安全',
  altered: '被改变',
  skipped_by_surge: 'Surge 跳过了该节点',
  check_failed: '--check 未通过',
  no_connection: '没有到达出口',
  not_tested: '未测试',
};

export async function runCharset(ctx: Ctx): Promise<ExitCode> {
  const { out, now, sleep } = ctx.deps;
  const waitMs = (ctx.args.numbers.wait ?? 2) * 1000;
  let classes;
  try {
    classes = selectClasses(ctx.args.lists.classes);
  } catch {
    throw refused('参数检查失败：--classes 中有未知类别');
  }
  const { dir, state } = openRun(ctx);
  const servers = await requireServers(ctx, state);
  const creds = loadCredentials(dir);
  if (!creds) throw refused('前置条件不满足：缺少合成测试凭据，请先运行 test-servers');
  const session = await openSession(ctx, dir, state, { needTestProfile: true });
  const ops = new TestOps(ctx, dir, session, state);
  // 入口必须是 NORMAL：入口规则集全部为占位规则，且没有本工具的临时规则在用。
  const placeholders = entryFilesForBits({ udp: false, verify: false, block: false, active: false }, [], verifyHostOf(ctx));
  for (const [name, content] of Object.entries(placeholders)) {
    const current = await ops.files.read(name);
    if (current !== null && current !== content) throw refused('前置条件不满足：入口不是 NORMAL（入口规则集不是占位规则），先运行 entry --to NORMAL');
  }
  if (ops.state.tempRules.some((r) => r.state === 'present' && r.purpose === 'entry')) throw refused('前置条件不满足：本工具的入口临时规则仍在，先运行 entry --to NORMAL');
  const keys = await allowRefreshFor(session, ops.state, [NODE_RESOURCE_FILE]);
  const key = keys[NODE_RESOURCE_FILE];
  if (!key) throw refused('前置条件不满足：Surge 中找不到指向测试节点资源的外部资源');
  const ports: TestPorts = { echo: servers.echoPort, exit: servers.exitPort, front: servers.frontPort, deadFront: servers.deadFrontPort };
  const proxy = proxyOf(ctx);
  const expectations = classes.map(({ index, cls }) => charsetExpectation(index, cls));
  const before = await tryRead(() => session.adapter.getGroupSelection(ROUTE_GROUP_NAME));
  const ok = await confirmWrites(
    ctx,
    '凭据字符测试',
    [
      `测试节点资源加入 ${expectations.length} 个合成凭据节点（只对本机测试出口有效）并 --check、定向刷新`,
      'SFE-ROUTE 依次选择每个字符类节点，经 SFE-ROUTE 发一次测试请求',
      '恢复测试节点资源（A、B）并刷新，恢复原选择',
    ],
    ['测试节点资源恢复为只含 A、B 并刷新；SFE-ROUTE 选择恢复', '合成凭据只在测试资源与运行目录中'],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');
  dir.writeJson(CHARSET_EXPECT_FILE, { classes: expectations });

  const outcome: Array<{ index: number; id: string; label: string; result: CharsetClassResult; verdicts: CharsetAuthVerdict[] }> = [];
  let checkOk = true;
  try {
    const lines = [testNodeLine('a', ports, creds.password), testNodeLine('b', ports, creds.password), ...expectations.map((e) => charsetNodeLine(e, ports))];
    await ops.writeTestFile(NODE_RESOURCE_FILE, resourceFile(7, lines));
    if (session.mechanism.checkProfile !== 'unavailable' && ops.state.testProfilePath) {
      const c = await tryRead(() => session.adapter.checkProfile(ops.state.testProfilePath!));
      checkOk = c?.ok ?? true;
      dir.writeJson(`charset/check-${now().getTime()}.json`, c);
    }
    const r = await ops.refresh(key, 'charset-nodes');
    if (!r.ok) throw refused(`凭据字符测试失败：刷新测试资源失败（${r.code}）`);
    await sleep(1000);
    const members = (await tryRead(() => session.adapter.getGroupMembers(ROUTE_GROUP_NAME))) ?? [];
    for (const e of expectations) {
      const cls = classes.find((c) => c.index === e.index)!.cls;
      const inMembers = members.includes(e.node);
      let selected = false;
      let requestOk = false;
      let verdicts: CharsetAuthVerdict[] = [];
      if (inMembers && checkOk) {
        const t = now().getTime();
        selected = (await ops.select(e.node)) === e.node;
        if (selected) {
          requestOk = (await requestViaRoute(proxy, servers.echoPort, `cs-${e.index}`)).ok;
          await sleep(waitMs);
          verdicts = dir
            .readJsonl<{ at?: string; kind?: string; index?: number; verdict?: CharsetAuthVerdict }>(SERVER_LOGS.exit)
            .filter((x) => x.kind === 'charset_auth' && x.index === e.index && typeof x.at === 'string' && Date.parse(x.at) >= t)
            .map((x) => x.verdict!)
            .filter(Boolean);
        }
      }
      outcome.push({ index: e.index, id: e.id, label: cls.label, result: classifyCharset({ index: e.index, inMembers, selected, requestOk, authVerdicts: verdicts }, checkOk), verdicts });
    }
  } finally {
    try {
      await ops.writeTestFile(NODE_RESOURCE_FILE, testNodeResource(['a', 'b'], ports, creds.password, 8));
      await ops.refresh(key, 'charset-restore');
      await ops.select(before ?? 'REJECT').catch(() => undefined);
    } catch {
      out.warn('恢复测试资源或选择失败：请按回退方式处理');
    }
    saveState(dir, ops.state);
  }
  const safe = outcome.filter((o) => o.result === 'safe');
  dir.writeJson('charset/result.json', { at: now().toISOString(), checkOk, outcome: outcome.map(({ index, id, result, verdicts }) => ({ index, id, result, verdicts })) });
  out.heading('凭据字符测试结果');
  out.table([['类别', '结果'], ...outcome.map((o) => [o.label, RESULT_LABEL[o.result]])]);
  out.line(`已证明安全的类别：${safe.map((o) => o.label).join('、') || '无'}`);
  out.line('放宽 SURGE_SAFE_CREDENTIAL_RE 只能包含已证明安全的字符；没有证明的字符继续返回 UNSAFE_CREDENTIAL_CHARS。');
  return 0;
}
