// 操作详情/进度弹窗的打开状态（全局只有一个，避免弹窗套弹窗），以及取消等待中的路由操作的确认。

import { reactive } from 'vue';

export interface OperationViewerState {
  id: string | null;
  /** 受控入口引导用的场景名（环境展示名）。 */
  sceneName: string | null;
  /** 取消确认弹窗针对的操作；打开时暂时收起详情弹窗。 */
  cancelId: string | null;
  /** 旧窗口确认弹窗。 */
  acknowledgeWindows: boolean;
}

export function createOperationViewer() {
  const state = reactive<OperationViewerState>({ id: null, sceneName: null, cancelId: null, acknowledgeWindows: false });
  let returnTo: { id: string; sceneName: string | null } | null = null;

  return {
    state,
    open(id: string, sceneName: string | null = null) {
      state.cancelId = null;
      state.id = id;
      state.sceneName = sceneName;
    },
    close() {
      state.id = null;
      state.sceneName = null;
    },
    /** 从详情弹窗或路由卡发起取消：先收起详情，确认后再回到详情。 */
    requestCancel(id: string) {
      returnTo = state.id ? { id: state.id, sceneName: state.sceneName } : null;
      state.id = null;
      state.cancelId = id;
    },
    finishCancel() {
      state.cancelId = null;
      if (returnTo) {
        state.id = returnTo.id;
        state.sceneName = returnTo.sceneName;
      }
      returnTo = null;
    },
    requestAcknowledgeWindows() {
      returnTo = state.id ? { id: state.id, sceneName: state.sceneName } : null;
      state.id = null;
      state.acknowledgeWindows = true;
    },
    finishAcknowledgeWindows() {
      state.acknowledgeWindows = false;
      if (returnTo) {
        state.id = returnTo.id;
        state.sceneName = returnTo.sceneName;
      }
      returnTo = null;
    },
  };
}

export type OperationViewer = ReturnType<typeof createOperationViewer>;
