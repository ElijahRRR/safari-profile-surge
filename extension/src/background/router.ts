// 后台消息路由：原生消息的唯一出口。
// - 扩展页面（sender.url 以扩展地址开头）可以转发原生请求（requestLoginFill 除外，它只能由
//   内容脚本路径重建），以及读取/上报场景状态；
// - 内容脚本只能发 requestLoginFill（后台丢弃其自报的 top_url/frame_is_top/route_epoch，
//   从 sender 与一次新的 getCurrentState 重建）与 checkLoginFill（只回答本场景是否适用填充）；
//   Safari 不提供所需的 sender 字段时直接拒绝。
// 从不打印请求或应答。

import { classifySiteUrl, type CurrentStateResponse, type NativeRequest, type NativeResponse } from '@sfe/contract';
import type { MessageSender } from '../shared/browser';
import type { ProfileStateReport } from '../shared/messages';
import { failure, isNativeRequestType, type NativeClient } from '../shared/native';

export interface RouterDeps {
  runtimeId: string;
  /** runtime.getURL('')，例如 safari-web-extension://<UUID>/ */
  extensionBaseUrl: string;
  native: NativeClient;
  collectProfileState(): Promise<ProfileStateReport>;
}

export type Router = (message: unknown, sender: MessageSender) => Promise<NativeResponse<unknown>>;

export type SenderKind = 'extension_page' | 'content_script' | 'foreign';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function classifySender(sender: MessageSender | undefined, deps: Pick<RouterDeps, 'runtimeId' | 'extensionBaseUrl'>): SenderKind {
  if (!sender || typeof sender.id !== 'string' || sender.id !== deps.runtimeId) return 'foreign';
  const base = deps.extensionBaseUrl;
  if (base && typeof sender.url === 'string' && sender.url.startsWith(base)) return 'extension_page';
  return 'content_script';
}

const FILL_FIELDS = ['identifier', 'password'] as const;
type FillField = (typeof FILL_FIELDS)[number];

function parseFields(value: unknown): FillField[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > FILL_FIELDS.length) return null;
  const out: FillField[] = [];
  for (const f of value) {
    if (!(FILL_FIELDS as readonly unknown[]).includes(f) || out.includes(f as FillField)) return null;
    out.push(f as FillField);
  }
  return out;
}

function refuseFill(reason: string, message: string): NativeResponse<never> {
  return failure('FILL_NOT_ALLOWED', `登录填充失败：${message}`, { reason });
}

/**
 * 本场景是否适用登录填充（requestLoginFill 与 checkLoginFill 共用，顺序即拒绝原因的优先级）：
 * 已绑定 → 页面是该站点登录页 → 表单目标在该站点（只在有表单时）→ 已开启自动填充 → 是使用中的环境。
 */
function fillEligibility(
  state: CurrentStateResponse,
  sender: MessageSender,
  topUrl: string,
  formAction: string | null,
): { ok: true; routeEpoch: number } | { ok: false; refusal: NativeResponse<never> } {
  const refuse = (reason: string, message: string) => ({ ok: false as const, refusal: refuseFill(reason, message) });
  const env = state.environment;
  if (!env) return refuse('unbound', '当前场景未绑定环境');
  if (classifySiteUrl(env.site, topUrl) !== 'signin') return refuse('not_signin', '当前页面不是该站点的登录页');
  // 顶层框架自己的地址也必须是登录页（与标签页地址交叉核对）。
  if (typeof sender.url === 'string' && classifySiteUrl(env.site, sender.url) !== 'signin') {
    return refuse('not_signin', '当前页面不是该站点的登录页');
  }
  if (formAction !== null && classifySiteUrl(env.site, formAction) === 'foreign') return refuse('bad_form_action', '表单目标不是该站点的 HTTPS 地址');
  if (!env.autoFillLogin) return refuse('autofill_off', '此环境未开启登录页自动填充');
  if (!state.route) return refuse('not_active', '当前场景不是使用中的环境');
  return { ok: true, routeEpoch: state.route.routeEpoch };
}

async function handleContentFill(message: unknown, sender: MessageSender, deps: RouterDeps): Promise<NativeResponse<unknown>> {
  if (!isObject(message) || (message.type !== 'requestLoginFill' && message.type !== 'checkLoginFill')) {
    return failure('FORBIDDEN_ORIGIN', '请求被拒绝：登录页脚本只能请求填充');
  }
  if (typeof sender.frameId !== 'number') return refuseFill('missing_sender', 'Safari 未提供框架信息');
  if (sender.frameId !== 0) return refuseFill('not_top_frame', '请求不是来自顶层页面');
  const topUrl = sender.tab?.url ?? sender.url;
  if (typeof topUrl !== 'string' || topUrl.length === 0) return refuseFill('missing_sender', 'Safari 未提供页面地址');

  if (message.type === 'checkLoginFill') {
    // 只回答是否适用，从不向服务请求填充值。
    const state = await deps.native.call({ type: 'getCurrentState' });
    if (!state.ok) return state;
    const check = fillEligibility(state.data, sender, topUrl, null);
    return check.ok ? { ok: true, data: { eligible: true } } : check.refusal;
  }

  const fields = parseFields(message.fields);
  if (!fields) return refuseFill('bad_fields', '字段列表不正确');
  const formAction = message.form_action;
  if (typeof formAction !== 'string' || formAction.length === 0) return refuseFill('no_form', '字段不在表单内');

  const state = await deps.native.call({ type: 'getCurrentState' });
  if (!state.ok) return state;
  const check = fillEligibility(state.data, sender, topUrl, formAction);
  if (!check.ok) return check.refusal;

  const request: NativeRequest = {
    type: 'requestLoginFill',
    top_url: topUrl,
    frame_is_top: sender.frameId === 0,
    form_action: formAction,
    fields,
    route_epoch: check.routeEpoch,
  };
  return deps.native.call(request);
}

async function handlePage(message: unknown, deps: RouterDeps): Promise<NativeResponse<unknown>> {
  if (!isObject(message)) return failure('BAD_REQUEST', '请求格式不正确');
  if (message.sfe === 'profileState') {
    const report = await deps.collectProfileState();
    if (message.report === true) {
      // 只作提示：失败（例如未识别场景不允许上报）不影响弹窗。
      await deps.native.call({ type: 'reportProfileState', ...report });
    }
    return { ok: true, data: report };
  }
  if (message.sfe === 'native') {
    const inner = message.message;
    if (!isObject(inner) || !isNativeRequestType(inner.type)) return failure('BAD_REQUEST', '请求类型不受支持');
    if (inner.type === 'requestLoginFill') {
      return failure('FORBIDDEN_ORIGIN', '请求被拒绝：登录填充只能由登录页发起');
    }
    return deps.native.call(inner as unknown as NativeRequest);
  }
  return failure('BAD_REQUEST', '请求格式不正确');
}

export function createRouter(deps: RouterDeps): Router {
  return async (message, sender) => {
    const kind = classifySender(sender, deps);
    if (kind === 'foreign') return failure('FORBIDDEN_ORIGIN', '请求被拒绝：来源不是本扩展');
    if (kind === 'extension_page') return handlePage(message, deps);
    return handleContentFill(message, sender, deps);
  };
}
