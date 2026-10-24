<script setup lang="ts">
// 全局弹窗宿主：旧窗口确认、操作进度、取消等待中的路由操作、确认旧窗口已关闭。
// 同一时刻只显示一个弹窗（设计系统不允许弹窗套弹窗）。
import { computed, ref } from 'vue';
import { ConfirmDialog } from '@sfe/easyquick';
import RouteConfirmDialog from './RouteConfirmDialog.vue';
import OperationDialog from './OperationDialog.vue';
import { useConsole } from '../store/context';
import { newRequestId } from '../lib/request-id';
import { HELD_ON_END, RETEST_SUBMITTED_MISMATCH, cancelActionLabel, isSafariRetest } from '../lib/environments';

const { api, store, toasts, routeActions, viewer } = useConsole();

const ra = routeActions.state;
const showConfirm = computed(() => ra.phase === 'confirming' || (ra.phase === 'sending' && ra.confirmation !== null));

const cancelOp = computed(() => store.operationById(viewer.state.cancelId));
const cancelling = ref(false);
const cancelText = computed(() => {
  const op = cancelOp.value;
  if (!op) return { title: '取消操作', message: '确定要取消此操作吗？', detail: '' };
  const title = cancelActionLabel(op);
  // 等待与重测的取消通常不改变路由；结束时 SFE-ROUTE 已不是使用中环境已验证的出口（例如在 Surge 中被改选）时，服务按 §6.3
  // 第 14 步的结束点失败即关闭改选 REJECT 并要求处理——确认说明不能无条件承诺出口不变
  if (op.phase === 'WAITING_ROUTE') {
    return { title, message: '确定要取消等待场景打开吗？', detail: `新版本保持已部署，下次打开该场景时再切换，不会进入普通模式。通常当前出口不变；${HELD_ON_END}` };
  }
  // 重测（含激活复用时改为的重测）从不切换或回滚：取消通常只结束本次检测（§6.4）；例外除 HELD_ON_END 外，还有已提交的结果中
  // 出口 IP 与预期出口不一致时照样记下不符、停止订单与填充（§6.1，RETEST_SUBMITTED_MISMATCH）
  if (isSafariRetest(op)) {
    return {
      title,
      message: '确定要取消这次 Safari 重测吗？',
      detail: `不会进入普通模式。通常只结束本次检测，路由不变（不切换、不阻断 Safari）；${HELD_ON_END}${RETEST_SUBMITTED_MISMATCH}`,
    };
  }
  return { title, message: '确定要取消此次切换吗？', detail: '服务会尝试恢复切换前的节点选择并保持 Safari 阻断，之后需要重新核验；无法确认时不恢复，改选 REJECT 拒绝 Safari 经本应用出口的新连接并要求处理。不会进入普通模式。' };
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
