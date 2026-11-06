// 弹窗内打开的对话框计数：弹窗高度随内容变化，对话框打开时给弹窗留出最小高度。
import { inject, onBeforeUnmount, onMounted, type InjectionKey, type Ref } from 'vue';

export const DIALOG_COUNT: InjectionKey<Ref<number>> = Symbol('sfe-dialog-count');

export function useDialogTracking(): void {
  const count = inject(DIALOG_COUNT, null);
  onMounted(() => {
    if (count) count.value += 1;
  });
  onBeforeUnmount(() => {
    if (count) count.value = Math.max(0, count.value - 1);
  });
}
