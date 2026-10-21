<script setup lang="ts">
// 全局弹窗宿主：旧窗口确认、操作进度、取消等待中的路由操作、确认旧窗口已关闭。
// 同一时刻只显示一个弹窗（设计系统不允许弹窗套弹窗）。
import { computed, ref } from 'vue';
import { ConfirmDialog } from '@sfe/easyquick';
import RouteConfirmDialog from './RouteConfirmDialog.vue';
import OperationDialog from './OperationDialog.vue';
import { useConsole } from '../store/context';
import { newRequestId } from '../lib/request-id';

const { api, store, toasts, routeActions, viewer } = useConsole();

const ra = routeActions.state;
const showConfirm = computed(() => ra.phase === 'confirming' || (ra.phase === 'sending' && ra.confirmation !== null));

const cancelOp = computed(() => store.operationById(viewer.state.cancelId));
const cancelling = ref(false);
const cancelText = computed(() => {
  const op = cancelOp.value;
  if (!op) return { title: '取消操作', message: '确定要取消此操作吗？', detail: '' };
  if (op.phase === 'WAITING_ROUTE') {
    return { title: '取消等待', message: '确定要取消等待场景打开吗？', detail: '新版本保持已部署，下次打开该场景时再切换；当前出口不变，不会进入普通模式。' };
  }
  if (op.kind === 'probe.safari') {
    return { title: '取消重测', message: '确定要取消这次 Safari 重测吗？', detail: '取消后按服务端规则结束本次检测；不会进入普通模式。' };
  }
  return { title: '取消切换', message: '确定要取消此次切换吗？', detail: '服务会恢复切换前的节点选择并保持 Safari 阻断，之后需要重新核验；不会进入普通模式。' };
});

async function confirmCancel() {
  const id = viewer.state.cancelId;
  if (!id) return;
  cancelling.value = true;
  try {
    await api.cancelOperation(id, { request_id: newRequestId() });
    toasts.info('已受理：正在取消，结果见操作详情');
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '取消失败');
  } finally {
    cancelling.value = false;
    viewer.finishCancel();
  }
}

const acknowledging = ref(false);
async function confirmAcknowledge() {
  acknowledging.value = true;
  try {
    await api.acknowledgeWindows({ request_id: newRequestId() });
    toasts.success('已记录：旧环境窗口已关闭');
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '提交失败');
  } finally {
    acknowledging.value = false;
    viewer.finishAcknowledgeWindows();
  }
}
</script>

<template>
  <RouteConfirmDialog
    :show="showConfirm"
    :target="ra.target"
    :details="ra.confirmation"
    :policy="ra.policy"
    :sending="ra.phase === 'sending'"
    :error="ra.error"
    @update:policy="(p) => (ra.policy = p)"
    @confirm="routeActions.confirm()"
    @cancel="routeActions.dismiss()"
  />
  <OperationDialog />
  <ConfirmDialog
    :show="viewer.state.cancelId !== null"
    :title="cancelText.title"
    :message="cancelText.message"
    :confirm-text="cancelText.title"
    variant="danger"
    :loading="cancelling"
    @confirm="confirmCancel"
    @cancel="viewer.finishCancel()"
  >
    <p>{{ cancelText.detail }}</p>
  </ConfirmDialog>
  <ConfirmDialog
    :show="viewer.state.acknowledgeWindows"
    title="确认旧窗口已关闭"
    message="确定旧环境的 Safari 窗口都已关闭吗？"
    confirm-text="确认"
    :loading="acknowledging"
    @confirm="confirmAcknowledge"
    @cancel="viewer.finishAcknowledgeWindows()"
  >
    <p>只清除旧窗口警告并记录你的确认，不改变路由。</p>
  </ConfirmDialog>
</template>
