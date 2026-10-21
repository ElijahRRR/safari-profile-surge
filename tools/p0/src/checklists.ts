// 人工检查清单：原生桥、场景 ID、钥匙串、签名持久性、首请求与旧连接，以及只作记录的批量创建/按 ID 打开。
// 由自动测试命令测量的能力不走清单。答案：y 通过、n 不通过、空 未完成。

import type { CapabilityKey } from '@sfe/contract';
import { check, type CheckItem } from './results.js';

export interface ChecklistItem {
  id: string;
  question: string;
}

export interface Checklist {
  title: string;
  /** 只记录，不作为任何动作的门槛。 */
  recordOnly?: boolean;
  items: ChecklistItem[];
}

export const AUTOMATED_BY: Partial<Record<CapabilityKey, string>> = {
  safari_process_attribution: 'attribution',
  fixed_profile_no_switch: 'refresh',
  runtime_entry_modes: 'entry',
  entry_rules_after_restart: 'entry --restart-test',
  safari_udp_quic_handling: 'entry',
  targeted_resource_refresh: 'refresh',
  policy_path_reread: 'refresh',
  external_node_underlying_proxy: 'chain',
  connection_continuity: 'continuity',
  auto_reload_atomic_replace: 'refresh',
  independent_node_preflight: 'preflight',
  takeover_state_readable: 'inventory',
  same_profile_reload_impact: 'continuity（在 Surge 中手动重载配置并输入 reload 标记）',
};

export const CHECKLISTS: Partial<Record<CapabilityKey, Checklist>> = {
  native_profile_id: {
    title: '原生场景 ID 稳定性',
    items: [
      { id: 'distinct', question: '默认场景与至少两个测试场景在扩展弹窗中显示的场景 ID 前 8 位互不相同？' },
      { id: 'safari_restart', question: 'Safari 退出重开后，各场景 ID 不变？' },
      { id: 'reinstall', question: '扩展停用再启用（或重新安装）后的 ID 行为已记录在备注中（不变或变化）？' },
      { id: 'resign', question: 'App 重新构建、重新签名后的 ID 行为已记录在备注中？' },
    ],
  },
  native_bridge_ipc: {
    title: '扩展与本机服务通信（含后台休眠唤醒）',
    items: [
      { id: 'roundtrip', question: '扩展弹窗经原生桥读到服务状态（往返成功）？' },
      { id: 'safari_restart', question: 'Safari 退出重开后往返仍成功？' },
      { id: 'reboot', question: '系统重启后往返仍成功？' },
      { id: 'service_restart', question: '菜单「停止后台服务」再「注册后台服务」后往返仍成功？' },
      { id: 'service_upgrade', question: '重新构建并替换 App（服务升级）后往返仍成功？' },
      { id: 'background_wake', question: '扩展后台脚本休眠后（Safari 闲置 5 分钟以上，或在开发菜单中确认后台已卸载）点击弹窗仍能完成往返？' },
      { id: 'no_tcc', question: '整个过程没有出现「访问其他 App 的数据」等系统提示？' },
    ],
  },
  bridge_keychain_access: {
    title: '原生桥读取钥匙串',
    items: [
      { id: 'write', question: 'sfe-keychain 写入合成测试账号密码项成功？' },
      { id: 'read_no_prompt', question: '签名的原生桥读取该项没有额外提示？' },
      { id: 'resign_prompts', question: '重新构建/重签后的提示次数已记录在备注中？' },
      { id: 'errors', question: '钥匙串锁定、用户拒绝时错误分类正确（denied / locked）？' },
    ],
  },
  extension_install_persistence: {
    title: '扩展签名与启用持久性（免费 Apple ID）',
    items: [
      { id: 'unsigned_off', question: '「允许未签名扩展」保持关闭？' },
      { id: 'safari_restart', question: 'Safari 退出重开后扩展仍启用？' },
      { id: 'reboot', question: '系统重启后扩展仍启用？' },
      { id: 'eight_days', question: '安装 8 天以上后扩展仍启用（备注写开始与检查日期）？' },
      { id: 'rebuild', question: '重新构建安装后扩展仍启用？' },
      { id: 'validity', question: '证书与描述文件有效期已记录在备注中？' },
    ],
  },
  first_request_and_old_connections: {
    title: '首请求与旧连接处理',
    items: [
      { id: 'first_request', question: '受控入口（菜单「打开环境」）发起时，首个业务请求（测试页）已经过目标测试节点？' },
      { id: 'old_long_connection', question: '切换时 Safari 测试页的 WebSocket（旧长连接）被结束，之后不再经旧出口？' },
      { id: 'background_requests', question: '旧环境窗口的后台请求（测试页轮询）在切换后不经旧出口？' },
      { id: 'restored_tabs', question: 'Safari 退出时保留窗口、重开后恢复的标签页没有在入口阻断前经旧出口加载？' },
      { id: 'extension_sleep', question: '扩展后台休眠后再唤醒的情况下，首请求仍经过目标节点？' },
      { id: 'limitations', question: '不能证明的情况已写入备注（作为限制显示）？' },
    ],
  },
  open_profile_by_id: {
    title: '按场景 ID 打开 Safari（只记录）',
    recordOnly: true,
    items: [
      { id: 'public_api', question: '找到了公开、受支持的方式按场景 ID 打开指定 Safari 场景（备注写方式与系统版本）？' },
      { id: 'no_private', question: '该方式不使用私有数据库或界面自动化？' },
    ],
  },
  profile_batch_create: {
    title: '批量创建 Safari 场景（只记录）',
    recordOnly: true,
    items: [
      { id: 'public_api', question: '找到了公开方式批量创建 Safari 场景（备注写方式）？' },
      { id: 'manual_steps', question: '官方界面逐个创建与启用扩展的步骤已记录（用于关联向导）？' },
    ],
  },
};

export type Answer = { answer: 'y' | 'n' | null; note: string };

export function parseAnswer(raw: string | null): 'y' | 'n' | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'y' || v === 'yes' || v === '是') return 'y';
  if (v === 'n' || v === 'no' || v === '否') return 'n';
  return null;
}

export function checklistChecks(list: Checklist, answers: Record<string, Answer>): CheckItem[] {
  return list.items.map((item) => {
    const a = answers[item.id];
    return check(item.question, a?.answer === 'y' ? true : a?.answer === 'n' ? false : null, a?.note ?? '');
  });
}
