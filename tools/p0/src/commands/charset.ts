// charset：逐类测试代理凭据字符。每类一个合成节点（用户名/密码开头、中间、结尾都含该类字符）连同正常节点 C 经回环测试
// 资源服务发布（D10：一次单 key 更新 + 读回，loopback-ops.ts publishGeneration），读回成员必须含 A、B、C（C 是“已经载入这一版”
// 的见证；字符类节点可能被 Surge 跳过，success 与空错误不能说明它被接受）；逐个选择并经 SFE-ROUTE 发请求，比较出口服务实际
// 收到的值。只有完全一致的类别才算已证明安全；结果用于决定是否放宽 SURGE_SAFE_CREDENTIAL_RE（domain/validate.ts）。
// 这一版刻意含产品发布前校验会拒绝的字符，所以不做发布前校验（只测 Surge）。发布读回失败时不测试任何类别（结论为未测试，
// 不当作“被 Surge 跳过”）。入口必须是 NORMAL。

import { ROUTE_GROUP_NAME } from '@sfe/contract';
import { CHARSET_EXPECT_FILE, SERVER_LOGS } from '../constants.js';
import { charsetExpectation, charsetNodeLine, classifyCharset, selectClasses, type CharsetAuthVerdict, type CharsetClassResult } from '../charset.js';
import { refused, type ExitCode } from '../errors.js';
import { saveState } from '../state.js';
import { TEST_NODES, entryFilesForBits, testNodeLine } from '../test-profile.js';
import { confirmWrites, tryRead, verifyHostOf, type Ctx } from './common.js';
import { openLoopback, readbackText } from './loopback-ops.js';
import { requestViaRoute } from './test-ops.js';

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
  const { dir, session, ops, lb, servers, creds, ports, proxy } = await openLoopback(ctx, { requireSetup: true });
  // 入口必须是 NORMAL：入口规则集全部为占位规则，且没有本工具的临时规则在用。
  const placeholders = entryFilesForBits({ udp: false, verify: false, block: false, active: false }, [], verifyHostOf(ctx));
  for (const [name, content] of Object.entries(placeholders)) {
    const current = await ops.files.read(name);
    if (current !== null && current !== content) throw refused('前置条件不满足：入口不是 NORMAL（入口规则集不是占位规则），先运行 entry --to NORMAL');
  }
  if (ops.state.tempRules.some((r) => r.state === 'present' && r.purpose === 'entry')) throw refused('前置条件不满足：本工具的入口临时规则仍在，先运行 entry --to NORMAL');
  await lb.ensureKey();
  const expectations = classes.map(({ index, cls }) => charsetExpectation(index, cls));
  const before = await tryRead(() => session.adapter.getGroupSelection(ROUTE_GROUP_NAME));
  const ok = await confirmWrites(
    ctx,
    '凭据字符测试',
    [
      `测试资源服务提供加入 ${expectations.length} 个合成凭据节点（只对本机测试出口有效）与正常节点 ${TEST_NODES.c} 的新版本；对测试资源执行一次单 key 更新并读回（${TEST_NODES.c} 出现在成员中为准）`,
      'SFE-ROUTE 依次选择每个字符类节点，经 SFE-ROUTE 发一次测试请求',
      '恢复只含 A、B 的版本（一次单 key 更新并读回）与原选择',
    ],
    ['测试资源服务恢复提供只含 A、B 的版本，一次单 key 更新并读回；SFE-ROUTE 选择恢复', '合成凭据只在运行目录与测试资源服务提供的内容中'],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');
  dir.writeJson(CHARSET_EXPECT_FILE, { classes: expectations });

  const outcome: Array<{ index: number; id: string; label: string; result: CharsetClassResult; verdicts: CharsetAuthVerdict[] }> = [];
  // 回环资源提供的内容不经 --check（候选副本中没有它；surge-cli --check 是否下载远端 policy-path 是 TODO(P0)）：只看读回
  const checkOk = true;
  let published = false;
  try {
    // 正常节点 C 作为“已经载入这一版”的见证：字符类节点可能被 Surge 跳过，不能用它们判断这一版是否已被载入。
    const lines = [testNodeLine('a', ports, creds.password), testNodeLine('b', ports, creds.password), testNodeLine('c', ports, creds.password), ...expectations.map((e) => charsetNodeLine(e, ports))];
    const pub = await lb.publishGeneration(lines, { label: 'charset', required: [TEST_NODES.a, TEST_NODES.b, TEST_NODES.c], prevalidate: false });
    published = pub.committed;
    dir.writeJson(`charset/publish-${now().getTime()}.json`, { generation: pub.generation, committed: pub.committed, failed: pub.assessment.failed, level: pub.assessment.level });
    if (!published) out.warn(`凭据字符节点没有经读回确认发布（${readbackText(pub.assessment)}）：无法测试凭据字符`);
    const members = pub.after?.members ?? [];
    for (const e of expectations) {
      const cls = classes.find((c) => c.index === e.index)!.cls;
      if (!published) {
        outcome.push({ index: e.index, id: e.id, label: cls.label, result: 'not_tested', verdicts: [] });
        continue;
      }
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
      const restoreTo = before === TEST_NODES.a || before === TEST_NODES.b ? before : 'REJECT';
      await ops.select(restoreTo).catch(() => undefined);
      const back = await lb.publishGeneration([testNodeLine('a', ports, creds.password), testNodeLine('b', ports, creds.password)], { label: 'charset-restore' });
      if (!back.committed) out.warn(`恢复只含 A、B 的版本没有经读回确认（${readbackText(back.assessment)}）：请按回退方式处理`);
    } catch {
      out.warn('恢复测试资源或选择失败：请按回退方式处理');
    }
    saveState(dir, ops.state);
  }
  const safe = outcome.filter((o) => o.result === 'safe');
  dir.writeJson('charset/result.json', { at: now().toISOString(), checkOk, published, outcome: outcome.map(({ index, id, result, verdicts }) => ({ index, id, result, verdicts })) });
  out.heading('凭据字符测试结果');
  out.table([['类别', '结果'], ...outcome.map((o) => [o.label, RESULT_LABEL[o.result]])]);
  out.line(`已证明安全的类别：${safe.map((o) => o.label).join('、') || '无'}`);
  out.line('放宽 SURGE_SAFE_CREDENTIAL_RE 只能包含已证明安全的字符；没有证明的字符继续返回 UNSAFE_CREDENTIAL_CHARS。');
  return 0;
}
