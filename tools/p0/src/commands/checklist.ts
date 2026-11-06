// checklist <能力>：逐项询问人工检查结果并记录（y 通过 / n 不通过 / 回车 未完成）。备注会脱敏，
// 不要输入账号、密码或 IP。原生相关能力的上下文含宿主 App 的签名身份（codesign 的 Team ID）。

import { CAPABILITY_CONTEXT_DEPS, CAPABILITY_CRITERIA, CAPABILITY_LABELS } from '@sfe/contract';
import { parseCapabilityKey } from '../args.js';
import { AUTOMATED_BY, CHECKLISTS, checklistChecks, parseAnswer, type Answer } from '../checklists.js';
import { refused, type ExitCode } from '../errors.js';
import { redactSummary } from '../redact.js';
import { readResult, writeResult } from '../results.js';
import { DEFAULT_HOST_APP, codesignTeamId } from '../system.js';
import { measureContext, openRun, openSession, printResult, type Ctx, type Session } from './common.js';

export async function runChecklist(ctx: Ctx): Promise<ExitCode> {
  const { out, prompt, now, home } = ctx.deps;
  const key = parseCapabilityKey(ctx.args.positionals[0]);
  const list = CHECKLISTS[key];
  if (!list) throw refused(`${CAPABILITY_LABELS[key]} 由 ${AUTOMATED_BY[key] ?? '测试命令'} 测量，不走人工清单`);
  const { dir, state } = openRun(ctx);
  out.heading(`${list.title}${list.recordOnly ? '（只记录）' : ''}`);
  out.line(`通过条件：${CAPABILITY_CRITERIA[key]}`);
  if (key === 'first_request_and_old_connections') {
    const ev = dir.readJson<{ killResults?: Array<{ ok: boolean }> | null; safariWsClosesAfterBlocked?: number | null }>('entry/old-connections-evidence.json');
    if (ev) {
      const kr = ev.killResults ?? [];
      out.line(`entry 记录的证据：结束 Safari 连接 ${kr.filter((k) => k.ok).length}/${kr.length} 条；BLOCKED 后 Safari 测试页 WebSocket 断开 ${ev.safariWsClosesAfterBlocked ?? '未知'} 次`);
    } else {
      out.line('还没有 entry 记录的旧连接证据：建议先运行 entry。');
    }
  }
  const answers: Record<string, Answer> = {};
  for (const item of list.items) {
    const a = parseAnswer(await prompt.ask(`${item.question}（y 通过 / n 不通过 / 回车 未完成）`));
    const note = (await prompt.ask('备注（可空；不要输入账号、密码或 IP）：')) ?? '';
    answers[item.id] = { answer: a, note: redactSummary(note.slice(0, 500), { home }) };
  }
  const deps = CAPABILITY_CONTEXT_DEPS[key];
  const signingIdentity = deps.includes('signingIdentity') ? (ctx.args.strings['signing-identity'] ?? (await codesignTeamId(ctx.deps.exec, ctx.args.strings['app-path'] ?? DEFAULT_HOST_APP))) : null;
  let session: Session | null = null;
  if (deps.some((f) => f.startsWith('surge')) && state.mechanism) session = await openSession(ctx, dir, state, { needTestProfile: false }).catch(() => null);
  const entry = readResult(dir, 'runtime_entry_modes');
  const processPaths = entry?.processPaths ?? state.processPaths;
  const context = await measureContext(ctx, session, state, {
    signingIdentity,
    entryStrategy: deps.includes('entryStrategy') ? (entry?.entryStrategy ?? null) : null,
    processPaths,
  });
  const result = writeResult(dir, {
    key,
    command: 'checklist',
    at: now().toISOString(),
    checks: checklistChecks(list, answers),
    summary: [`通过条件：${CAPABILITY_CRITERIA[key]}`, ...(list.recordOnly ? ['只记录：不作为任何动作的门槛'] : [])],
    context,
    ...(deps.includes('entryStrategy') && entry?.entryStrategy ? { entryStrategy: entry.entryStrategy } : {}),
    ...(deps.includes('processPathsDigest') ? { processPaths: [...processPaths] } : {}),
  });
  printResult(out, result);
  out.line(`下一步：propose ${key} ${result.verdict === 'pass' ? 'supported' : 'unsupported'}`);
  return 0;
}
