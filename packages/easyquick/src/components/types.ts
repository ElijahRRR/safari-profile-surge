// EasyQuick 组件共用的类型与 DataTable 内边距规则（设计系统 DataTable 说明：按数据列数收紧，勾选列不计入）。

export function cellPaddingClass(columnCount: number): string {
  if (columnCount <= 4) return 'px-6';
  if (columnCount <= 6) return 'px-4';
  if (columnCount <= 9) return 'px-3';
  return 'px-2';
}

export interface TableColumn {
  key: string;
  label: string;
  /** 额外的单元格类（只用设计系统的工具类）。 */
  class?: string;
  /** 长文本列允许换行；默认不换行。 */
  wrap?: boolean;
  /** 表头只给读屏（例如操作列）。 */
  srOnly?: boolean;
}

export type BadgeVariant = 'primary' | 'success' | 'warning' | 'danger' | 'gray' | 'purple';

export interface SelectOption<T> {
  value: T;
  label: string;
  description?: string | null;
  disabled?: boolean;
}

export interface MenuItem {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}

export interface ToastItem {
  id: number;
  type: 'success' | 'error' | 'warning' | 'info';
  title?: string | null;
  message: string;
  /** 毫秒；0 表示不自动关闭。 */
  duration: number;
}
