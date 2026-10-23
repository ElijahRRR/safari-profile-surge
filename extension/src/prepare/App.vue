<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { Icon } from '@sfe/easyquick';
import { OPERATION_PHASES, type OperationPhase } from '@sfe/contract';
import { PHASE_TEXT, rollbackText } from '../shared/text';
import type { PrepareController } from './controller';

const props = defineProps<{ controller: PrepareController }>();
const c = props.controller;
const s = c.state;

function phaseLabel(phase: string | null): string | null {
  if (!phase) return null;
  return (OPERATION_PHASES as readonly string[]).includes(phase) ? PHASE_TEXT[phase as OperationPhase] : phase;
}

const busy = computed(() => ['arriving', 'pending', 'verifying', 'submitting', 'waiting_result'].includes(s.stage));
const title = computed(() => {
  switch (s.stage) {
    case 'invalid':
      return '缺少操作编号';
    case 'arriving':
      return '正在连接本机服务';
    case 'pending':
      return phaseLabel(s.phase) ?? '正在准备出口';
    case 'verifying':
      return '正在由此场景请求出口检测服务';
    case 'submitting':
      return '正在核对检测结果';
    case 'waiting_result':
      return phaseLabel(s.operation?.phase ?? null) ?? '正在等待结果';
    case 'succeeded':
      return '出口检测通过';
    case 'failed':
      return failedTitle.value;
    case 'parked':
      return phaseLabel(s.operation?.phase ?? null) ?? '操作已结束';
    case 'error':
      return '检测失败';
  }
  return '';
});
// 失败的标题按实际结果：只有实测失败才说「出口检测未通过」
const VERIFY_FAILURE_CODES = new Set(['SAFARI_VERIFY_FAILED', 'SAFARI_VERIFY_TIMEOUT', 'EXIT_IP_MISMATCH']);
const failedTitle = computed(() => {
  if (s.outcome === 'superseded') return '切换未完成：已被之后的请求取代';
  if (s.outcome === 'attention') return '切换未能确认，需要处理';
  const code = s.operation?.error?.code;
  if (code === 'SAFARI_VERIFY_TIMEOUT' && s.outcome === 'probe_failed') return '重新检测超时';
  if (code && VERIFY_FAILURE_CODES.has(code)) return '出口检测未通过';
  if (code === 'SUPERSEDED') return s.outcome === 'probe_failed' ? '已取消重新检测' : '已取消切换';
  return s.outcome === 'probe_failed' ? '重新检测未完成' : '切换未完成';
});
// 重测结束时是否真的停止了自动打开订单与填充：只有核对后失败或出口不符（服务把警告加到路由上，result.probeWarning；旧版服务
// 按错误代码）才停止。取消、超时与开始等待之前的失败只结束这次重测，路由与之前的检测结果都不变（§6.4）
const PROBE_STOP_CODES = new Set(['SAFARI_VERIFY_FAILED', 'EXIT_IP_MISMATCH']);
const probeStopped = computed(() => {
  const op = s.operation;
  if (!op) return false;
  return Boolean(op.result?.probeWarning) || PROBE_STOP_CODES.has(op.error?.code ?? '');
});
// 失败后的说明只写读回确认过的：「不会改用直连或其他环境的出口」只在回滚读回确认 Safari 保持阻断时成立
const failedNote = computed(() => {
  switch (s.outcome) {
    case 'rolled_back':
      return '不会改用直连或其他环境的出口。可以关闭此页面，在扩展弹窗中查看状态与下一步。';
    case 'probe_failed':
      return probeStopped.value
        ? '路由未改变，已停止自动打开订单与填充。可以关闭此页面，在扩展弹窗中查看状态与下一步。'
        : '这次重新检测已结束，路由与之前的检测结果都未改变，自动打开订单与填充不受这次重新检测影响。可以关闭此页面，在扩展弹窗中查看状态与下一步。';
    case 'superseded':
      return `这次${s.operation?.probeKind === 'safari' ? '重新检测' : '切换'}没有完成，也没有在此场景完成出口检测。Safari 的出口由之后的请求决定：进入普通模式后按 Surge 原规则发出（可能直连），切换到其他环境后经该环境的出口。请在扩展弹窗中查看当前状态。`;
    case 'attention':
      return '不能确认 Safari 的出口状态。请按上面的说明处理，需要时在扩展弹窗中进入普通模式。';
    default:
      return '请在扩展弹窗中查看当前状态与下一步。';
  }
});
const rollback = computed(() => s.operation?.result?.rollback ?? null);
const steps = computed(() => s.operation?.steps.slice(-8) ?? []);
const ordersText = computed(() => {
  if (s.ordersResult === 'focused') return '已切换到已打开的订单页。';
  if (s.ordersResult === 'navigated') return '正在打开订单页。';
  if (s.ordersResult === 'created') return '已在新标签页打开订单页。';
  return null;
});

onMounted(() => {
  void c.start();
});
onBeforeUnmount(() => c.stop());
</script>

<template>
  <main class="mx-auto max-w-lg space-y-4 px-4 py-10" data-test="prepare">
    <header class="flex items-center gap-2">
      <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-primary text-white shadow-glow">
        <Icon name="shield" size="md" />
      </span>
      <div>
        <h1 class="text-lg font-semibold text-gray-900 dark:text-white">Safari 出口检测</h1>
        <p class="text-xs text-gray-500 dark:text-dark-400">在当前场景中确认出口，通过前不会打开 Amazon。</p>
      </div>
    </header>

    <div class="card">
      <div class="card-body space-y-3" :data-stage="s.stage">
        <div class="flex items-start gap-3">
          <span v-if="busy" class="spinner mt-0.5 h-5 w-5 text-primary-500" role="status" aria-label="加载中"></span>
          <Icon v-else-if="s.stage === 'succeeded'" name="checkCircle" size="md" class="text-green-500" />
          <Icon v-else-if="s.stage === 'failed' || s.stage === 'error'" name="xCircle" size="md" class="text-red-500" />
          <Icon v-else name="infoCircle" size="md" class="text-gray-400" />
          <div class="min-w-0 space-y-1">
            <h2 class="text-base font-semibold text-gray-900 dark:text-white" data-test="stage-title">{{ title }}</h2>
            <p v-if="s.stage === 'invalid'" class="text-sm text-gray-600 dark:text-gray-300">请从扩展弹窗重新打开此页面。</p>
            <p v-if="s.message && (s.stage === 'pending' || s.stage === 'waiting_result' || s.stage === 'parked')" class="text-sm text-gray-600 dark:text-gray-300" data-test="stage-message">
              {{ s.message }}
            </p>
            <p v-if="s.stage === 'parked' && s.outcome === 'not_checked'" class="text-sm text-gray-500 dark:text-dark-400" data-test="not-checked">
              这次没有进行出口检测。请在扩展弹窗中查看当前状态，需要时重新使用此环境。
            </p>
            <!-- 只有切换才阻断：重新检测、等待中（尚未到达）、已请求取消时不说 Safari 被拒绝 -->
            <p v-if="s.stage === 'pending'" class="text-sm text-gray-500 dark:text-dark-400" data-test="pending-note">
              请保持此页面打开。<template v-if="s.switching">切换期间 Safari 的其他请求会被暂时拒绝，Chrome 不受影响。</template>
            </p>
            <p v-if="s.stage === 'succeeded' && s.exitIp" class="text-sm text-gray-700 dark:text-gray-300" data-test="exit-ip">
              实际出口 <span class="code">{{ s.exitIp }}</span>
            </p>
            <p v-if="s.stage === 'failed' && s.error" class="text-sm text-danger" data-test="failure">{{ s.error }}</p>
            <p v-if="s.stage === 'failed' && rollback" class="text-sm text-gray-700 dark:text-gray-300" data-test="rollback">{{ rollbackText(rollback) }}</p>
            <p v-if="s.stage === 'failed'" class="text-sm text-gray-500 dark:text-dark-400" data-test="failed-note">{{ failedNote }}</p>
            <p v-if="s.stage === 'error' && s.error" class="text-sm text-danger" data-test="error">{{ s.error }}</p>
            <p v-if="ordersText" class="text-sm text-gray-700 dark:text-gray-300" data-test="orders-result">{{ ordersText }}</p>
            <p v-if="s.stage === 'succeeded' && s.autoOpenNotice && !s.ordersResult" class="text-sm text-warning" data-test="auto-open-blocked">
              未自动打开订单页：{{ s.autoOpenNotice }}
            </p>
            <p v-if="s.stage === 'succeeded' && s.ordersBlockedReason" class="text-sm text-gray-500 dark:text-dark-400" data-test="orders-blocked">
              订单页未打开：{{ s.ordersBlockedReason }}
            </p>
          </div>
        </div>
        <div v-if="s.stage === 'succeeded' && s.ordersOfferable && !s.ordersResult" class="flex justify-end">
          <button type="button" class="btn btn-primary" data-test="open-orders" @click="c.openOrders()">打开订单页</button>
        </div>
        <div v-if="s.stage === 'error'" class="flex justify-end">
          <button type="button" class="btn btn-secondary" data-test="retry" @click="c.retry()">
            <Icon name="refresh" size="md" />
            重新检测
          </button>
        </div>
      </div>
    </div>

    <div v-if="steps.length" class="card">
      <div class="card-body">
        <h3 class="text-sm font-medium text-gray-900 dark:text-white">进度</h3>
        <ol class="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-300">
          <li v-for="(step, i) in steps" :key="i" class="flex gap-2">
            <span class="flex-shrink-0 text-gray-500 dark:text-dark-400">{{ PHASE_TEXT[step.phase] }}</span>
            <span class="min-w-0 break-words">{{ step.message }}</span>
          </li>
        </ol>
      </div>
    </div>

    <p class="text-xs text-gray-500 dark:text-dark-400">检测只请求独立的 IP 服务，不发送 Amazon 地址、买家号或密码。</p>
  </main>
</template>
