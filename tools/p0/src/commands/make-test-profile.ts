// make-test-profile：从当前配置（只读副本）生成独立的 P0 测试配置「SFE-P0-测试.conf」与测试资源文件，
// 全部以 O_EXCL 0600 新建（已存在即拒绝，从不覆盖）；--check 测试配置；打印手动切换与回退步骤。
// 工具从不切换配置：切换到测试配置、测完切回原配置都由用户在 Surge 菜单中手动完成。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { VERIFY_ENDPOINTS } from '@sfe/contract';
import { DEFAULT_HTTP_API_PORT } from '../constants.js';
import { createProfileFiles, listRelativeReferences } from '../deps.js';
import { refused, type ExitCode } from '../errors.js';
import { logAction } from '../results.js';
import { classifyLocationRisk, findGitWorkTree } from '../run-dir.js';
import { saveState, upsertCreatedFile, type CreatedFile } from '../state.js';
import {
  CANARY_FILE,
  MANAGED_TEST_FILES,
  PRECEDENCE_MODULE_FILE,
  TEST_PROFILE_FILE,
  TEST_PROFILE_NAME,
  buildTestProfile,
} from '../test-profile.js';
import { confirmWrites, ensureCredentials, openRun, openSession, profileNameOf, type Ctx } from './common.js';

function kindOf(name: string): CreatedFile['kind'] {
  if (name === TEST_PROFILE_FILE) return 'test_profile';
  if (name === 'sfe-nodes.list') return 'node_resource';
  if (name === CANARY_FILE) return 'canary';
  if (name === PRECEDENCE_MODULE_FILE) return 'module';
  if (name.startsWith('sfe-entry-')) return 'entry_ruleset';
  return 'reference_copy';
}

export async function runMakeTestProfile(ctx: Ctx): Promise<ExitCode> {
  const { out, now, home } = ctx.deps;
  const { dir, state: initial } = openRun(ctx);
  let state = initial;
  if (!state.servers) throw refused('前置条件不满足：请先运行 test-servers（测试配置需要它的端口）');
  if (state.testProfilePath && existsSync(state.testProfilePath)) throw refused('前置条件不满足：本次运行已经生成过测试配置');
  const sourcePath = ctx.args.strings.profile ?? state.sourceProfilePath;
  if (!sourcePath || !isAbsolute(sourcePath) || !existsSync(sourcePath) || !statSync(sourcePath).isFile() || !sourcePath.endsWith('.conf')) {
    throw refused('前置条件不满足：需要源配置文件的绝对路径（--profile，或 inventory 时提供）');
  }
  const sourceDir = dirname(sourcePath);
  const targetDir = resolve(ctx.args.strings['target-dir'] ?? sourceDir);
  const risk = classifyLocationRisk(targetDir, home);
  if (risk === 'unknown') throw refused('前置条件不满足：无法确认目标目录的真实位置（祖先目录不可读或不是目录）；请用 --target-dir 指定本机目录');
  if (risk !== 'none') {
    throw refused('前置条件不满足：目标目录位于 iCloud/同步或受保护位置。正式产品不在此写入；请用 --target-dir 指定本机目录，并在 Surge 设置中手动把配置目录指向它');
  }
  if (findGitWorkTree(targetDir) !== null) throw refused('前置条件不满足：目标目录位于 Git 工作树内');

  const creds = ensureCredentials(dir);
  const httpApi = ctx.args.booleans['no-http-api'] ? null : { key: creds.httpApiKey, port: ctx.args.numbers['http-api-port'] ?? DEFAULT_HTTP_API_PORT };
  const sourceText = readFileSync(sourcePath, 'utf8');
  const s = state.servers;
  const built = buildTestProfile(sourceText, {
    ports: { echo: s.echoPort, exit: s.exitPort, front: s.frontPort, deadFront: s.deadFrontPort },
    password: creds.password,
    verifyHost: VERIFY_ENDPOINTS[0]!.host,
    httpApi,
  });

  // 目标目录与源目录不同：复制源配置引用的同级相对文件（只读副本）。
  const copies: Record<string, string> = {};
  if (targetDir !== sourceDir) {
    const managed = new Set<string>(MANAGED_TEST_FILES);
    for (const ref of listRelativeReferences(built.profileText)) {
      if (managed.has(ref.value)) continue;
      if (ref.value.includes('/')) throw refused(`生成测试配置失败：源配置引用了子目录中的文件（第 ${ref.line} 行），不能复制到其他目录`);
      const src = join(sourceDir, ref.value);
      if (!existsSync(src)) throw refused(`生成测试配置失败：源配置引用的文件不存在（第 ${ref.line} 行）`);
      copies[ref.value] = readFileSync(src, 'utf8');
    }
  }
  const toWrite: Record<string, string> = { [TEST_PROFILE_FILE]: built.profileText, ...built.files, [PRECEDENCE_MODULE_FILE]: built.moduleText, ...copies };
  const existing = Object.keys(toWrite).filter((n) => existsSync(join(targetDir, n)));
  if (existing.length > 0) throw refused(`生成测试配置失败：目标目录中已存在 ${existing.join('、')}，不覆盖任何文件`);

  const paths = Object.keys(toWrite).map((n) => join(targetDir, n));
  const ok = await confirmWrites(
    ctx,
    '生成 P0 测试配置',
    [`在 ${targetDir} 新建 ${Object.keys(toWrite).length} 个文件（O_EXCL 0600，不覆盖）：${Object.keys(toWrite).join('、')}`, '对测试配置运行 --check（只读校验，不激活）'],
    ['这些文件不被任何活动配置使用；不需要时（且 Surge 不在测试配置上）把它们移到废纸篓即可', ...paths.map((p) => `  ${p}`)],
  );
  if (!ok) throw refused('已取消：没有写入任何文件');

  const files = createProfileFiles({ directory: targetDir, hmacKey: dir.key() });
  for (const [name, content] of Object.entries(toWrite)) {
    await files.writeAtomic(name, content, null);
    state = upsertCreatedFile(state, { path: join(targetDir, name), digest: (await files.digest(name))!, kind: kindOf(name), createdAt: now().toISOString() });
    saveState(dir, state);
  }
  state = { ...state, testProfilePath: join(targetDir, TEST_PROFILE_FILE), testDirectory: targetDir, sourceProfileName: profileNameOf(sourcePath), sourceProfilePath: sourcePath };
  saveState(dir, state);
  logAction(dir, { at: now().toISOString(), command: 'make-test-profile', action: 'test_profile_created', detail: { files: Object.keys(toWrite) } });

  // --check（只读校验；不激活测试配置）。
  let checkLine = 'checkProfile 不可用：请在 Surge 中切换前确认没有语法错误提示';
  try {
    const session = await openSession(ctx, dir, state, { needTestProfile: false });
    if (session.mechanism.checkProfile !== 'unavailable') {
      const r = await session.adapter.checkProfile(state.testProfilePath!);
      dir.writeJson('make-test-profile/check.json', { at: now().toISOString(), ok: r.ok, message: r.message });
      checkLine = r.ok ? '--check 通过（只证明语法被接受，不证明运行时加载或连通）' : '--check 未通过：详情见运行目录 make-test-profile/check.json';
    }
  } catch {
    checkLine = '--check 执行失败：详情见运行目录 surge-calls.jsonl';
  }

  out.heading('测试配置已生成');
  out.line(`测试配置：${state.testProfilePath}`);
  out.line(checkLine);
  for (const n of built.notes) out.line(`提示：${n}`);
  out.heading('手动切换（工具从不切换配置）');
  out.line(`1. 确认 test-servers 正在运行。`);
  out.line(`2. 在 Surge 菜单「配置」中选择「${TEST_PROFILE_NAME}」。`);
  out.line(`3. 确认增强模式/系统代理与切换前一致，出站模式为规则模式。`);
  out.line(`4. 运行 inventory --run ${dir.id} --profile "${state.testProfilePath}"，按测试配置（含回环 http-api）更新原语映射。`);
  out.line(`5. 运行 attribution 开始测试。`);
  out.heading('回退');
  out.line(`在 Surge 菜单「配置」中切回「${profileNameOf(sourcePath)}」；之后运行 rollback 查看需要删除的文件与临时规则。`);
  return 0;
}
