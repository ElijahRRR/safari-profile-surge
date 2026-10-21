// 服务端字段错误到表单输入的映射：字段路径可能带前缀（environment.proxy.host），按后缀匹配。
import type { FieldError } from '@sfe/contract';

export function fieldError(errors: readonly FieldError[] | undefined, key: string): string | null {
  if (!errors) return null;
  const hit = errors.find((e) => e.field === key || e.field.endsWith(`.${key}`));
  return hit ? hit.message : null;
}

export function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= 65535 ? n : null;
}
