// P0 测试配置的生成（纯函数）。从源配置的只读副本出发：加入与正式结构相同的受管理段
// （SFE-ROUTE + 四条入口 RULE-SET，文件名与正式一致，便于证明真实的 key/位置识别），
// 本机测试节点（前置、坏前置、普通出口、canary 出口）和测试规则；源配置已有受管理段时整段替换，
// 从不引用真实环境节点。测试凭据是合成的，只对本机测试服务有效。

import {
  ENTRY_RULESET_FILES,
  NODE_RESOURCE_FILE,
  ROUTE_GROUP_NAME,
  type EntryBits,
} from '@sfe/contract';
import {
  ENTRY_BITS_IN_ORDER,
  detectManagedConfigHeader,
  dominantEol,
  entryRuleSetBlockLines,
  entryRuleSetFileContent,
  findForeignSfeObjects,
  findManagedBlock,
  findSections,
  groupBlockLines,
  insertInitialBlocks,
  isCommentLine,
  nodeLine,
  parseHttpApiLine,
  parseProfile,
  parseProxyLine,
  parseRule,
  replaceManagedBlock,
  resourceFile,
  serializeProfile,
  stripManagedConfigHeader,
} from './deps.js';
import { refused } from './errors.js';

export const TEST_PROFILE_NAME = 'SFE-P0-测试';
export const TEST_PROFILE_FILE = `${TEST_PROFILE_NAME}.conf`;
export const TEST_DOMAIN = 'p0.example.test';
export const ECHO_HOST = `echo.${TEST_DOMAIN}`;
export const CHAIN_HOST = `chain.${TEST_DOMAIN}`;
export const CANARY_SUFFIX = `canary.${TEST_DOMAIN}`;
export const CANARY_FILE = 'p0-canary.list';
export const PRECEDENCE_MODULE_FILE = 'SFE-P0-precedence.sgmodule';
/** 只用于生成占位规则集内容（关闭的位不含路径）。 */
export const PLACEHOLDER_PROCESS_PATH = '/Applications/Safari.app/Contents/MacOS/Safari';

export const TEST_PROXIES = {
  front: 'P0-Front',
  deadFront: 'P0-Front-Dead',
  /** 刻意不定义：前置名缺失的节点。 */
  missingFront: 'P0-Front-Missing',
  plain: 'P0-Plain',
  canary: 'P0-Canary',
} as const;

export const TEST_NODES = {
  a: 'SFE-N-P0-A',
  b: 'SFE-N-P0-B',
  c: 'SFE-N-P0-C',
  dead: 'SFE-N-P0-DEAD',
  missing: 'SFE-N-P0-MISSING',
} as const;

/** 出口服务按用户名区分“节点”；回显服务据此报告连接经过哪个节点。 */
export const TEST_USERS = {
  a: 'p0-a',
  b: 'p0-b',
  c: 'p0-c',
  dead: 'p0-dead',
  missing: 'p0-missing',
  plain: 'p0-plain',
  canary: 'p0-canary',
} as const;

export const MANAGED_TEST_FILES = [NODE_RESOURCE_FILE, ...ENTRY_BITS_IN_ORDER.map((b) => ENTRY_RULESET_FILES[b]), CANARY_FILE] as const;

export interface TestPorts {
  echo: number;
  exit: number;
  front: number;
  deadFront: number;
}

export interface TestProfileOptions {
  ports: TestPorts;
  /** 合成测试密码（[A-Za-z0-9]，只对本机测试出口有效）。 */
  password: string;
  verifyHost: string;
  /** 需要时加入的回环 http-api；null 表示不加入（--no-http-api）。 */
  httpApi: { key: string; port: number } | null;
}

export interface TestProfileResult {
  profileText: string;
  files: Record<string, string>;
  moduleText: string;
  notes: string[];
  httpApi: { configured: boolean; loopbackOnly: boolean | null; added: boolean };
  sourceHadManagedBlocks: boolean;
}

export type TestNodeKey = keyof typeof TEST_NODES;

export function testNodeLine(key: TestNodeKey, ports: TestPorts, password: string): string {
  const front = key === 'dead' ? TEST_PROXIES.deadFront : key === 'missing' ? TEST_PROXIES.missingFront : TEST_PROXIES.front;
  return nodeLine({ name: TEST_NODES[key], host: '127.0.0.1', port: ports.exit, username: TEST_USERS[key], password, front });
}

/** 节点资源内容：默认只含 A、B；其他测试按需加入。 */
export function testNodeResource(keys: readonly TestNodeKey[], ports: TestPorts, password: string, generation = 1): string {
  return resourceFile(generation, keys.map((k) => testNodeLine(k, ports, password)));
}

export function canaryContent(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('canary index');
  return `# SFE P0 canary\nDOMAIN,c${n}.${CANARY_SUFFIX}\n`;
}

export function canaryHost(n: number): string {
  return `c${n}.${CANARY_SUFFIX}`;
}

export function entryFilesForBits(bits: EntryBits, processPaths: readonly string[], verifyHost: string): Record<string, string> {
  const opts = { processPaths: processPaths.length > 0 ? processPaths : [PLACEHOLDER_PROCESS_PATH], verifyHost };
  return Object.fromEntries(ENTRY_BITS_IN_ORDER.map((bit) => [ENTRY_RULESET_FILES[bit], entryRuleSetFileContent(bit, bits[bit], opts)]));
}

function testProxyLines(ports: TestPorts, password: string): string[] {
  return [
    `${TEST_PROXIES.front} = socks5, 127.0.0.1, ${ports.front}`,
    `${TEST_PROXIES.deadFront} = socks5, 127.0.0.1, ${ports.deadFront}`,
    `${TEST_PROXIES.plain} = socks5, 127.0.0.1, ${ports.exit}, username=${TEST_USERS.plain}, password=${password}`,
    `${TEST_PROXIES.canary} = socks5, 127.0.0.1, ${ports.exit}, username=${TEST_USERS.canary}, password=${password}`,
  ];
}

function testRuleLines(): string[] {
  return [
    `RULE-SET,${CANARY_FILE},${TEST_PROXIES.canary}`,
    `DOMAIN,${CHAIN_HOST},${ROUTE_GROUP_NAME}`,
    `DOMAIN-SUFFIX,${TEST_DOMAIN},${TEST_PROXIES.plain}`,
  ];
}

/** 配置 [Rule] 段中的规则文本（按文件顺序，跳过空行、注释与无法解析的行）；入口探测用它定位配置规则的起点。 */
export function profileRuleLines(text: string): string[] {
  const parsed = parseProfile(text);
  return findSections(parsed, 'Rule').flatMap((s) =>
    parsed.lines
      .slice((s.header ?? s.start) + 1, s.end)
      .map((l) => l.text.trim())
      .filter((t) => t !== '' && !isCommentLine(t) && parseRule(t) !== null),
  );
}

export function precedenceModuleText(verifyHost: string): string {
  return [
    '#!name=SFE-P0 优先级测试',
    '#!desc=P0 测试用：启用后应被入口优先级检查识别为阻断项；测试结束后停用并删除',
    '',
    '[Rule]',
    `DOMAIN,${verifyHost},DIRECT`,
    '',
  ].join('\n');
}

/** 在第 at 行之前插入若干行（at 为当前文本的行号，0 起）。 */
function insertLines(text: string, at: number, lines: readonly string[]): string {
  const parsed = parseProfile(text);
  const eol = dominantEol(parsed);
  const src = parsed.lines.map((l) => ({ ...l }));
  if (at > 0 && src[at - 1] && src[at - 1]!.eol === '') src[at - 1]!.eol = eol;
  const ins = lines.map((t) => ({ text: t, eol }));
  return serializeProfile([...src.slice(0, at), ...ins, ...src.slice(at)]);
}

function endOfSection(text: string, name: string): number | null {
  const parsed = parseProfile(text);
  const s = findSections(parsed, name)[0];
  if (!s) return null;
  let last = s.header ?? s.start;
  for (let i = s.start; i < s.end; i++) if (parsed.lines[i]!.text.trim() !== '') last = i;
  return last + 1;
}

function sectionStart(text: string, name: string): number | null {
  const s = findSections(parseProfile(text), name)[0];
  return s ? s.start : null;
}

function proxyNames(text: string): Set<string> {
  const parsed = parseProfile(text);
  const names = new Set<string>();
  for (const name of ['Proxy', 'Proxy Group']) {
    for (const s of findSections(parsed, name)) {
      for (let i = (s.header ?? s.start) + 1; i < s.end; i++) {
        const p = parseProxyLine(parsed.lines[i]!.text);
        if (p) names.add(p.name.toLowerCase());
        else {
          const m = /^\s*([^=#;/][^=]*?)\s*=/.exec(parsed.lines[i]!.text);
          if (m) names.add(m[1]!.toLowerCase());
        }
      }
    }
  }
  return names;
}

/** [General] skip-proxy 等绕过设置是否覆盖测试主机或检测主机（覆盖时 Surge 不会处理这些请求）。 */
export function bypassWarnings(text: string, hosts: readonly string[]): string[] {
  const parsed = parseProfile(text);
  const notes: string[] = [];
  for (const s of findSections(parsed, 'General')) {
    for (let i = s.start; i < s.end; i++) {
      const m = /^\s*(skip-proxy|always-real-ip|bypass-tun)\s*=\s*(.*)$/i.exec(parsed.lines[i]!.text);
      if (!m) continue;
      const items = m[2]!.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
      for (const host of hosts) {
        const h = host.toLowerCase();
        const hit = items.some((it) => it === h || (it.startsWith('*.') && (h.endsWith(it.slice(1)) || h === it.slice(2))) || (it.startsWith('*') && h.endsWith(it.slice(1))));
        if (hit) notes.push(`[General] ${m[1]} 覆盖了 ${host}：Surge 可能不处理该主机的请求，相关测试会失真`);
      }
    }
  }
  return notes;
}

export function buildTestProfile(sourceText: string, opts: TestProfileOptions): TestProfileResult {
  const notes: string[] = [];
  let text = sourceText;
  if (detectManagedConfigHeader(text)) {
    text = stripManagedConfigHeader(text);
    notes.push('源配置带 #!MANAGED-CONFIG 远端托管头：测试配置副本已移除该行，避免被远端更新覆盖');
  }

  // 受管理段：已有则整段替换为测试内容（不引用真实环境节点），没有则按初始化位置插入。
  let parsed = parseProfile(text);
  const group = findManagedBlock(parsed, 'group');
  const entry = findManagedBlock(parsed, 'entry');
  const sourceHadManagedBlocks = group !== 'missing' || entry !== 'missing';
  const hasAnyMarker = /^\s*#\s*SFE-(BEGIN|END)\b/m.test(text);
  if (group === 'ambiguous' || entry === 'ambiguous') throw refused('生成测试配置失败：源配置的 SFE 受管理段边界不清晰');
  if (hasAnyMarker && (group === 'missing' || entry === 'missing')) {
    throw refused('生成测试配置失败：源配置只有部分 SFE 受管理段，请先修复或换用原始配置');
  }

  const existingApi = parseHttpApiLine(text);
  let httpApi: TestProfileResult['httpApi'] = { configured: existingApi !== null, loopbackOnly: existingApi?.loopbackOnly ?? null, added: false };
  const apiLines = opts.httpApi ? [`http-api = ${opts.httpApi.key}@127.0.0.1:${opts.httpApi.port}`, 'http-api-tls = false', 'http-api-web-dashboard = false'] : null;

  if (existingApi && !existingApi.loopbackOnly) {
    if (!apiLines) throw refused('生成测试配置失败：源配置的 http-api 绑定到非回环地址；不加 --no-http-api 时测试副本会改为回环地址');
    // 测试副本中改为回环地址（只影响测试配置，不改源配置）。
    const p = parseProfile(text);
    const idx = p.lines.findIndex((l) => /^\s*http-api\s*=/i.test(l.text));
    p.lines[idx]!.text = apiLines[0]!;
    text = serializeProfile(p);
    httpApi = { configured: true, loopbackOnly: true, added: true };
    notes.push('源配置的 http-api 绑定到非回环地址：测试配置副本已改为只监听 127.0.0.1');
  }

  const needApi = existingApi === null && apiLines !== null;
  if (!sourceHadManagedBlocks) {
    text = insertInitialBlocks(text, { group: groupBlockLines(), entry: entryRuleSetBlockLines(), general: needApi ? apiLines : null });
  } else {
    text = replaceManagedBlock(text, 'group', groupBlockLines());
    text = replaceManagedBlock(text, 'entry', entryRuleSetBlockLines());
    notes.push('源配置已有 SFE 受管理段：测试配置中已整段替换为测试内容，不引用真实环境节点');
    if (needApi) {
      const at = endOfSection(text, 'General');
      if (at === null) text = insertLines(text, 0, ['[General]', ...apiLines!, '']);
      else text = insertLines(text, at, apiLines!);
    }
  }
  if (needApi) {
    httpApi = { configured: true, loopbackOnly: true, added: true };
    notes.push('测试配置加入了只监听 127.0.0.1 的 http-api（随机密钥，只在测试配置中，关闭 TLS 与网页仪表盘）');
  }
  if (existingApi === null && apiLines === null) notes.push('未加入 http-api：HTTP 原语（组选择、请求记录、结束请求、策略测试）将不可用');

  // 非本应用的 SFE- 对象（受管理段之外）：存在时拒绝。
  const foreign = findForeignSfeObjects(text, {
    names: [ROUTE_GROUP_NAME],
    files: [NODE_RESOURCE_FILE, ...Object.values(ENTRY_RULESET_FILES)],
  });
  if (foreign.length > 0) {
    throw refused(`生成测试配置失败：源配置中已有 ${foreign.length} 个 SFE- 对象（行 ${foreign.map((f) => f.line).join('、')}），不能确定归属`);
  }

  const names = proxyNames(text);
  for (const n of Object.values(TEST_PROXIES)) {
    if (names.has(n.toLowerCase())) throw refused(`生成测试配置失败：源配置已有名为 ${n} 的策略`);
  }

  // [Proxy] 末尾加入测试节点；没有 [Proxy] 时在 [Proxy Group] 之前新建。
  const proxyEnd = endOfSection(text, 'Proxy');
  const proxyLines = ['# P0-TEST-BEGIN proxy', ...testProxyLines(opts.ports, opts.password), '# P0-TEST-END proxy'];
  if (proxyEnd !== null) text = insertLines(text, proxyEnd, proxyLines);
  else text = insertLines(text, sectionStart(text, 'Proxy Group')!, ['[Proxy]', ...proxyLines, '']);

  // 测试规则紧跟 entry 受管理段之后（入口仍是 [Rule] 最前面的规则）。
  parsed = parseProfile(text);
  const entryBlock = findManagedBlock(parsed, 'entry');
  if (typeof entryBlock !== 'object') throw refused('生成测试配置失败：未能定位 entry 受管理段');
  text = insertLines(text, entryBlock.end + 1, ['# P0-TEST-BEGIN rule', ...testRuleLines(), '# P0-TEST-END rule']);

  notes.push(...bypassWarnings(text, [ECHO_HOST, CHAIN_HOST, opts.verifyHost]));

  const files: Record<string, string> = {
    [NODE_RESOURCE_FILE]: testNodeResource(['a', 'b'], opts.ports, opts.password),
    ...entryFilesForBits({ udp: false, verify: false, block: false, active: false }, [], opts.verifyHost),
    [CANARY_FILE]: canaryContent(0),
  };
  return { profileText: text, files, moduleText: precedenceModuleText(opts.verifyHost), notes, httpApi, sourceHadManagedBlocks };
}
