// 秘密字段草稿与 SecretChange 的转换。草稿只在表单组件内存中，提交或关闭时清空。
import type { SecretChange } from '@sfe/contract';

export interface SecretDraft {
  action: 'keep' | 'replace' | 'clear';
  value: string;
}

export function keepDraft(): SecretDraft {
  return { action: 'keep', value: '' };
}

/** keep → undefined（不发送，服务端按保留处理）；replace 且为空视为未修改。 */
export function draftToChange(draft: SecretDraft): SecretChange | undefined {
  if (draft.action === 'clear') return { action: 'clear' };
  if (draft.action === 'replace' && draft.value.length > 0) return { action: 'replace', value: draft.value };
  return undefined;
}

export function wipeDraft(draft: SecretDraft): void {
  draft.value = '';
  draft.action = 'keep';
}
