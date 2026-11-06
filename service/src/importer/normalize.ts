// 单行导入记录 → EnvironmentInput。只做格式转换与校验，不查数据库：环境编号是否存在、
// 前置引用（名称或 id）是否已登记、同名冲突都由导入引擎判断。错误消息从不包含单元格的值
// （尤其是秘密），只说明哪个字段、应当如何填写。

import { isSiteCode, type EnvironmentInput, type FieldError, type ImportRecord, type SecretChange, type SiteCode } from '@sfe/contract';
import { validateEnvironmentInput } from '../domain/validate.js';
import type { ImportField } from './columns.js';

export interface NormalizeOptions {
  /** 行内缺站点时使用；为 null 时该行无效（从不默认美国站）。 */
  defaultSite: SiteCode | null;
  /** 用户看到的行号，用于字段前缀 rows[N].。 */
  row: number;
}

export interface NormalizedRecord {
  /** 文件中填写的环境编号（格式不正确时为 null，并带错误）。 */
  environmentId: string | null;
  /** 前置代理引用（已登记前置的 Surge 节点名或 id），由引擎解析；空则用默认前置。 */
  frontProxyRef: string | null;
  /** proxy.frontProxyId 始终为 null：前置由引擎按 frontProxyRef 解析。 */
  input: EnvironmentInput;
  errors: FieldError[];
  /**
   * 单元格为空（或缺列）的字段。input 中这些字段已按默认值填写（自动打开订单开、自动填充关、
   * 秘密保留）；更新已有环境时引擎可据此区分“明确填写”与“留空”。
   */
  blankFields: ImportField[];
}

const ENV_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const SITE_ALIASES: Readonly<Record<string, SiteCode>> = {
  us: 'US',
  美国: 'US',
  美国站: 'US',
  'amazon.com': 'US',
  'www.amazon.com': 'US',
  amazon美国站: 'US',
  亚马逊美国站: 'US',
};

/** 站点文本 → 站点代码；不认识返回 null（调用方报错，从不猜测）。 */
export function resolveSite(raw: string): SiteCode | null {
  let s = raw.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
  s = s.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const upper = s.toUpperCase();
  if (isSiteCode(upper)) return upper;
  return SITE_ALIASES[s] ?? null;
}

const TRUE_WORDS = new Set(['是', 'true', '1', '开', '开启', 'yes', 'on']);
const FALSE_WORDS = new Set(['否', 'false', '0', '关', '关闭', 'no', 'off']);

/** 开关文本 → 布尔；空返回 undefined，无法识别返回 null。 */
export function parseImportBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== 'string') return null;
  const s = value.normalize('NFKC').trim().toLowerCase();
  if (s === '') return undefined;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}

/** 文件内同名判断用的键；引擎与已有环境比较同名时应使用同一函数。 */
export function displayNameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

type Cell = { kind: 'blank' } | { kind: 'value'; value: string } | { kind: 'invalid' };
const BLANK: Cell = { kind: 'blank' };

/** 文本字段：字符串（默认去首尾空白）或数字（例如手机号被表格存成数字）。布尔、对象等无效。 */
function readCell(v: unknown, trim = true): Cell {
  if (v === undefined || v === null) return BLANK;
  if (typeof v === 'string') {
    if (v.trim() === '') return BLANK;
    return { kind: 'value', value: trim ? v.trim() : v };
  }
  if (typeof v === 'number' && Number.isFinite(v)) return { kind: 'value', value: String(v) };
  return { kind: 'invalid' };
}

function parsePort(v: unknown): number | 'blank' | 'invalid' {
  if (typeof v === 'number') return Number.isInteger(v) ? v : 'invalid';
  const c = readCell(v);
  if (c.kind === 'blank') return 'blank';
  if (c.kind === 'invalid' || !/^\d{1,5}$/.test(c.value)) return 'invalid';
  return Number(c.value);
}

export function normalizeRecord(record: ImportRecord, opts: NormalizeOptions): NormalizedRecord {
  const prefix = `rows[${opts.row}].`;
  const own: FieldError[] = [];
  const blankFields: ImportField[] = [];
  const err = (field: string, message: string) => own.push({ field: `${prefix}${field}`, message });
  const r = record as unknown as Record<ImportField, unknown>;

  const text = (field: ImportField, path: string, label: string, trim = true): string | null => {
    const c = readCell(r[field], trim);
    if (c.kind === 'blank') {
      blankFields.push(field);
      return null;
    }
    if (c.kind === 'invalid') {
      err(path, `${label}格式不正确：只能填写文本`);
      return null;
    }
    return c.value;
  };

  const secret = (field: ImportField, path: string, label: string, trim: boolean): SecretChange => {
    const c = readCell(r[field], trim);
    if (c.kind === 'blank') {
      // 导入从不清除秘密：留空表示保留现有值（新建时即未设置）。
      blankFields.push(field);
      return { action: 'keep' };
    }
    if (c.kind === 'invalid') {
      err(path, `${label}格式不正确：只能填写文本`);
      return { action: 'keep' };
    }
    return { action: 'replace', value: c.value };
  };

  // 环境编号
  let environmentId: string | null = null;
  const idText = text('environment_id', 'environment_id', '环境编号');
  if (idText !== null) {
    if (ENV_ID_RE.test(idText)) environmentId = idText;
    else err('environment_id', '环境编号格式不正确：只能包含字母、数字、下划线和连字符');
  }

  const displayName = text('display_name', 'displayName', '环境名称') ?? '';

  // 代理类型：缺省 socks5，其他一律无效
  const typeCell = readCell(r.proxy_type);
  if (typeCell.kind === 'blank') blankFields.push('proxy_type');
  else if (typeCell.kind === 'invalid' || typeCell.value.toLowerCase() !== 'socks5') {
    err('proxy.protocol', '代理类型不受支持：首版只支持 SOCKS5');
  }

  const host = text('proxy_host', 'proxy.host', '代理地址') ?? '';

  let port = 0;
  const portParsed = parsePort(r.proxy_port);
  if (portParsed === 'blank') {
    blankFields.push('proxy_port');
    err('proxy.port', '代理端口必填');
  } else if (portParsed === 'invalid') {
    err('proxy.port', '端口必须是 1–65535 的整数');
  } else {
    port = portParsed;
  }

  const proxyUsername = secret('proxy_username', 'proxy.username', '代理用户名', true);
  const proxyPassword = secret('proxy_password', 'proxy.password', '代理密码', true);
  const frontProxyRef = text('front_proxy', 'front_proxy', '前置代理');

  // 站点：行内值优先，其次导入时选择的默认站点；都没有则无效
  let site: SiteCode | null = null;
  const siteCell = readCell(r.site);
  if (siteCell.kind === 'blank') {
    blankFields.push('site');
    site = opts.defaultSite;
    if (site === null) err('site', '站点必填：请在文件中填写站点，或在导入时选择默认站点（首版只支持 Amazon 美国站）');
  } else if (siteCell.kind === 'invalid') {
    err('site', '站点格式不正确：只能填写文本');
  } else {
    site = resolveSite(siteCell.value);
    if (site === null) err('site', '站点不受支持：首版只支持 Amazon 美国站（填写 US）');
  }

  const label = text('account_label', 'account.label', '买家号备注');
  const loginIdentifier = text('login_identifier', 'account.loginIdentifier', '登录账号');
  // 登录密码不去首尾空白：不悄悄改动用户提供的秘密。
  const loginPassword = secret('login_password', 'account.password', '登录密码', false);
  const expectedExitIp = text('expected_exit_ip', 'proxy.expectedExitIp', '预期出口 IP');

  const bool = (field: ImportField, path: string, label: string, dflt: boolean): boolean => {
    const b = parseImportBoolean(r[field]);
    if (b === undefined) {
      blankFields.push(field);
      return dflt;
    }
    if (b === null) {
      err(path, `${label}只能填写 是/否（也可填 true/false、1/0、开/关、yes/no）`);
      return dflt;
    }
    return b;
  };
  const autoOpenOrders = bool('auto_open_orders', 'autoOpenOrders', '自动打开订单', true);
  const autoFillLogin = bool('auto_fill_login', 'autoFillLogin', '登录页自动填充', false);

  const input: EnvironmentInput = {
    displayName,
    // 无效站点时留空字符串，校验会把它记为错误；errors 非空的行不会被提交。
    site: (site ?? '') as SiteCode,
    autoOpenOrders,
    autoFillLogin,
    proxy: {
      protocol: 'socks5',
      host,
      port,
      username: proxyUsername,
      password: proxyPassword,
      frontProxyId: null,
      expectedExitIp,
    },
    account: {
      label,
      loginIdentifier,
      password: loginPassword,
    },
  };

  // 同一字段已有更具体的导入错误时，不再重复校验器的通用消息。
  const ownFields = new Set(own.map((e) => e.field));
  const validated = validateEnvironmentInput(input, prefix).filter((e) => !ownFields.has(e.field));
  return { environmentId, frontProxyRef, input, errors: [...own, ...validated], blankFields };
}
