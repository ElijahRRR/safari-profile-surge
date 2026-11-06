// 登录页条件填充（内容脚本逻辑）。
// - 只在该站点 HTTPS 登录页（不含 /ap/mfa）运行；只识别表单内可见的账号与密码字段；
// - 只向后台发送 { type, form_action, fields }，顶层地址、框架与路由序号由后台填写；
// - 未识别到字段时先向后台确认本场景适用填充（checkLoginFill），不适用或无法确认时不显示任何东西；
// - 应答逐项检查形状（字段名、非空字符串值、不重复），任何一项不符就一个字段也不填；
// - 写入每个值前重读 form.action，变化即丢弃；每页每字段最多填一次；
// - 从不提交、不点击、不处理验证码或二次验证；从不保存或打印填充值。

import { SITES, SITE_CODES, classifySiteUrl, type LoginFillResponse, type SiteCode } from '@sfe/contract';
import type { ContentFillMessage } from '../shared/messages';
import { createPanel, type Panel, type PanelContent } from './panel';

export type FillField = 'identifier' | 'password';

const IDENTIFIER_SELECTORS = ['#ap_email', '#ap_email_login', 'input[name="email"]', 'input[type="email"]', 'input[autocomplete="username"]'];
const PASSWORD_SELECTORS = ['#ap_password', 'input[name="password"]', 'input[type="password"]'];
const IDENTIFIER_TYPES = new Set(['', 'text', 'email', 'tel']);
const FIELD_LABEL: Record<FillField, string> = { identifier: '账号', password: '密码' };

/** 每次页面加载一份：已请求与已填写的字段。 */
export interface PageMemory {
  requested: Set<FillField>;
  filled: Set<FillField>;
}

export function newPageMemory(): PageMemory {
  return { requested: new Set(), filled: new Set() };
}

export function isVisibleInput(el: HTMLInputElement): boolean {
  if (!el.isConnected || el.disabled || el.readOnly || el.type === 'hidden') return false;
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const view = el.ownerDocument.defaultView;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  }
  return true;
}

function firstVisible(doc: Document, selectors: string[], accept: (el: HTMLInputElement) => boolean): HTMLInputElement | null {
  const view = doc.defaultView;
  for (const selector of selectors) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      if (view && el instanceof view.HTMLInputElement && accept(el) && isVisibleInput(el)) return el;
    }
  }
  return null;
}

/** 读取表单目标：用原型上的 getter，避免页面用 name="action" 的元素遮盖 form.action。 */
export function readFormAction(form: HTMLFormElement): string | null {
  const view = form.ownerDocument.defaultView;
  const getter = view ? Object.getOwnPropertyDescriptor(view.HTMLFormElement.prototype, 'action')?.get : undefined;
  const value: unknown = getter ? getter.call(form) : (form as unknown as { action: unknown }).action;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export type Detection =
  | { kind: 'none' }
  | { kind: 'no_form' }
  | { kind: 'form'; form: HTMLFormElement; action: string; inputs: Partial<Record<FillField, HTMLInputElement>> };

export function detectLoginForm(doc: Document): Detection {
  const passwordInput = firstVisible(doc, PASSWORD_SELECTORS, (el) => el.type === 'password');
  const identifierInput = firstVisible(doc, IDENTIFIER_SELECTORS, (el) => IDENTIFIER_TYPES.has(el.type));
  if (!passwordInput && !identifierInput) return { kind: 'none' };
  const form = (passwordInput ?? identifierInput)!.form;
  if (!form) return { kind: 'no_form' };
  const action = readFormAction(form);
  if (!action) return { kind: 'no_form' };
  // 两个字段不在同一表单时，只取主表单（有密码字段时以它为准）里的字段。
  const inputs: Partial<Record<FillField, HTMLInputElement>> = {
    ...(identifierInput && identifierInput.form === form ? { identifier: identifierInput } : {}),
    ...(passwordInput && passwordInput.form === form ? { password: passwordInput } : {}),
  };
  return { kind: 'form', form, action, inputs };
}

/** 用原生 setter 写值并派发 input/change，让页面框架感知变化。 */
export function setNativeValue(input: HTMLInputElement, value: string): void {
  const view = input.ownerDocument.defaultView;
  const setter = view ? Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set : undefined;
  if (setter) setter.call(input, value);
  else input.value = value;
  const EventCtor = view?.Event ?? Event;
  input.dispatchEvent(new EventCtor('input', { bubbles: true }));
  input.dispatchEvent(new EventCtor('change', { bubbles: true }));
}

export function pageSite(url: string): { site: SiteCode; kind: ReturnType<typeof classifySiteUrl> } | null {
  for (const site of SITE_CODES) {
    const kind = classifySiteUrl(site, url);
    if (kind !== 'foreign') return { site, kind };
  }
  return null;
}

export type AssistOutcome = 'skipped' | 'manual' | 'silent' | 'refused' | 'filled' | 'discarded';

export interface AssistDeps {
  doc: Document;
  pageUrl: string;
  sendMessage(message: ContentFillMessage): Promise<unknown>;
  navigate(url: string): void;
  memory?: PageMemory;
  panel?: Panel;
  /** 首次未识别到字段时，等待页面渲染的最长时间。 */
  waitForFieldsMs?: number;
}

// 用户未开启填充或场景未绑定时保持安静，不在页面上显示任何东西。
const SILENT_REASONS = new Set(['unbound', 'autofill_off']);

/**
 * 本机服务因已受理、尚未结束的路由操作而拒绝时的说明（docs/ARCHITECTURE.md §6.10）：用户已请求进入普通模式，或出口正在切换。
 * 不提示手动填充——用户已请求离开买家出口。只写服务确认过的：拒绝时只知道普通模式已受理，还不知道它能否完成（Surge 不可达、
 * 撤销或结束连接未能确认时 Safari 的请求仍可能经买家出口），所以不说「不经买家出口」，请用户在扩展弹窗中确认结果；面板停在
 * 页面上直到刷新，普通模式结束时不会更新。
 */
const ROUTE_REFUSAL_DETAIL: ReadonlyMap<string, string> = new Map([
  [
    'normal_pending',
    '已请求进入普通模式：完成后本场景的请求按 Surge 原规则发出（可能直连）；在此之前请求仍可能经买家出口。请在扩展弹窗中确认已进入普通模式。扩展不会提交表单。',
  ],
  ['route_busy', '出口正在切换或检测：完成后刷新页面再试。扩展不会提交表单。'],
]);

const MANUAL: PanelContent = { title: '可手动填充', detail: '未识别到可填充的登录字段。扩展不会猜测或提交表单。', tone: 'info' };

/**
 * 没有可填充字段时是否值得提示：只有后台确认本场景已绑定、开启自动填充且是使用中的环境时才提示。
 * 未绑定、未识别、未开启填充，以及后台或本机服务没有应答（无法确认）时都保持安静。
 */
async function fillApplies(deps: AssistDeps): Promise<boolean> {
  let reply: unknown;
  try {
    reply = await deps.sendMessage({ type: 'checkLoginFill' });
  } catch {
    return false;
  }
  if (typeof reply !== 'object' || reply === null) return false;
  const r = reply as { ok?: unknown; data?: { eligible?: unknown } };
  return r.ok === true && r.data?.eligible === true;
}

function waitForDetection(doc: Document, timeoutMs: number): Promise<Detection> {
  return new Promise((resolve) => {
    const view = doc.defaultView;
    if (!view || typeof view.MutationObserver !== 'function' || timeoutMs <= 0) {
      resolve(detectLoginForm(doc));
      return;
    }
    let settled = false;
    const finish = (d: Detection) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(d);
    };
    const observer = new view.MutationObserver(() => {
      const d = detectLoginForm(doc);
      if (d.kind !== 'none') finish(d);
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
    const timer = setTimeout(() => finish(detectLoginForm(doc)), timeoutMs);
  });
}

// 原生桥原样转发服务的应答，不再检查形状，所以在写入页面之前由这里检查。唯一现实的原因是替换 App 后旧版（钥匙串）服务
// 仍在运行：它仍能进入普通模式，而新版本服务在旧版本的数据目录上拒绝启动（docs/INSTALL.md §7）。所以不建议重新注册后台服务
// ——那会停掉仍能撤销本应用入口的旧服务，换上一个启动不了的新服务；先用旧服务进入普通模式，再按 §7 换用新的数据目录。
const MALFORMED_FILL_MESSAGE =
  '本机服务的填充应答格式不符（可能仍在运行旧版本的后台服务）：不要直接重新注册后台服务——本版本无法在旧版本的数据目录上启动，之后弹窗与网页后台都无法进入普通模式。请先在扩展弹窗或网页后台进入普通模式（旧版本的服务仍能处理），再按 docs/INSTALL.md §7 升级（需要换用新的数据目录）';

/**
 * 每一项都必须是 { field: 'identifier' | 'password', value: 非空字符串 }，且字段不重复；任何一项不符就整个拒绝，
 * 一个字段也不填。例如旧版（钥匙串）服务的密码项只有 keychainRef 而没有 value，不能把 undefined 写成文字 "undefined"。
 */
function wellFormedFills(fills: unknown): fills is LoginFillResponse['fills'] {
  if (!Array.isArray(fills)) return false;
  const seen = new Set<FillField>();
  for (const item of fills as unknown[]) {
    if (typeof item !== 'object' || item === null) return false;
    const { field, value } = item as { field?: unknown; value?: unknown };
    if (field !== 'identifier' && field !== 'password') return false;
    if (seen.has(field)) return false;
    seen.add(field);
    if (typeof value !== 'string' || value.length === 0) return false;
  }
  return true;
}

function parseReply(reply: unknown): { ok: true; data: LoginFillResponse } | { ok: false; message: string; reason: string | null } {
  if (typeof reply === 'object' && reply !== null) {
    const r = reply as { ok?: unknown; data?: unknown; error?: { message?: unknown; details?: { reason?: unknown } } };
    if (r.ok === true) {
      const fills = typeof r.data === 'object' && r.data !== null ? (r.data as { fills?: unknown }).fills : undefined;
      if (wellFormedFills(fills)) return { ok: true, data: { fills } };
      return { ok: false, message: MALFORMED_FILL_MESSAGE, reason: 'malformed_reply' };
    }
    if (r.ok === false) {
      const message = typeof r.error?.message === 'string' ? r.error.message : '登录填充失败';
      const reason = typeof r.error?.details?.reason === 'string' ? r.error.details.reason : null;
      return { ok: false, message, reason };
    }
  }
  return { ok: false, message: '登录填充失败：扩展后台没有应答', reason: null };
}

export async function runLoginAssist(deps: AssistDeps): Promise<AssistOutcome> {
  const page = pageSite(deps.pageUrl);
  // 只在登录页运行；二次验证页、订单页与其他页面什么都不做。
  if (!page || page.kind !== 'signin') return 'skipped';
  const memory = deps.memory ?? newPageMemory();
  let panel: Panel | null = deps.panel ?? null;
  const show = (content: PanelContent) => {
    panel ??= createPanel(deps.doc, { ordersUrl: SITES[page.site].ordersUrl, navigate: deps.navigate });
    panel.show(content);
  };

  let detection = detectLoginForm(deps.doc);
  if (detection.kind === 'none') detection = await waitForDetection(deps.doc, deps.waitForFieldsMs ?? 5000);
  if (detection.kind !== 'form') {
    if (!(await fillApplies(deps))) return 'silent';
    show(MANUAL);
    return 'manual';
  }

  const fields = (Object.keys(detection.inputs) as FillField[]).filter((f) => !memory.requested.has(f) && !memory.filled.has(f));
  if (fields.length === 0) return 'skipped';
  for (const f of fields) memory.requested.add(f);

  const { form, action } = detection;
  const reply = parseReply(await deps.sendMessage({ type: 'requestLoginFill', form_action: action, fields }));
  if (!reply.ok) {
    if (reply.reason && SILENT_REASONS.has(reply.reason)) return 'silent';
    const routeNote = reply.reason ? ROUTE_REFUSAL_DETAIL.get(reply.reason) : undefined;
    show({ title: '未自动填充', detail: `${reply.message.replace(/[。.]+$/, '')}。${routeNote ?? '可手动填充。'}`, tone: 'warning' });
    return 'refused';
  }

  const filled: FillField[] = [];
  for (const fill of reply.data.fills) {
    const field = fill.field;
    if (!fields.includes(field) || memory.filled.has(field)) continue;
    // 每次写入前重读表单目标：页面改了提交地址就整体放弃。
    if (readFormAction(form) !== action) {
      show({ title: '未自动填充', detail: '登录表单已变化，填充已取消。可手动填充。', tone: 'warning' });
      return 'discarded';
    }
    const input = detection.inputs[field];
    if (!input || !input.isConnected || input.form !== form || !isVisibleInput(input)) continue;
    // 用户正在这个字段里输入时不覆盖。
    if (deps.doc.activeElement === input && input.value !== '') continue;
    setNativeValue(input, fill.value);
    memory.filled.add(field);
    filled.push(field);
  }

  if (filled.length === 0) {
    show({ title: '可手动填充', detail: '没有可用的填充值，或字段已变化。扩展不会提交表单。', tone: 'info' });
    return 'manual';
  }
  show({ title: `已填充${filled.map((f) => FIELD_LABEL[f]).join('与')}`, detail: '请核对后自行登录。扩展不会提交表单。', tone: 'success' });
  return 'filled';
}
