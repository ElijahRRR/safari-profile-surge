<script setup lang="ts">
// 操作进度：阶段、步骤与结果。202 只代表已保存，进度以服务读回为准。
import { computed } from 'vue';
import type { OperationView } from '@sfe/contract';
import { PHASE_TEXT, formatRelative, rejectHeldText, rollbackText, statusIsTerminal } from '../shared/text';

const props = defineProps<{ operation: OperationView; now: Date }>();

const done = computed(() => statusIsTerminal(props.operation.status));
const failed = computed(() => ['failed', 'needs_attention', 'superseded'].includes(props.operation.status));
const steps = computed(() => props.operation.steps.slice(-5));
const rollback = computed(() => props.operation.result?.rollback ?? null);
/** 结束时服务改选了 SFE-ROUTE（result.rejectSelected）：路由已改变、需要处理，不是「路由不变」（普通模式完成时另有完成说明）。 */
const held = computed(() => (props.operation.phase === 'NORMAL_RESTORED' ? undefined : props.operation.result?.rejectSelected));
</script>

<template>
  <div class="card" data-test="operation-progress">
    <div class="card-body space-y-2 p-4">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span v-if="!done" class="spinner h-4 w-4 text-primary-500" role="status" aria-label="加载中"></span>
          <span class="text-sm font-medium text-gray-900 dark:text-white" data-test="operation-phase">{{ PHASE_TEXT[props.operation.phase] }}</span>
        </div>
        <span class="text-xs text-gray-500 dark:text-dark-400">{{ formatRelative(props.operation.updatedAt, props.now) }}</span>
      </div>
      <ol v-if="steps.length" class="space-y-1 text-xs text-gray-500 dark:text-dark-400">
        <li v-for="(step, i) in steps" :key="i" class="flex gap-2">
          <span class="flex-shrink-0">{{ PHASE_TEXT[step.phase] }}</span>
          <span class="min-w-0 break-words">{{ step.message }}</span>
        </li>
      </ol>
      <p v-if="failed && props.operation.error" class="text-sm text-danger" data-test="operation-error">{{ props.operation.error.message }}</p>
      <p v-if="rollback" class="text-sm text-gray-700 dark:text-gray-300" data-test="operation-rollback">{{ rollbackText(rollback) }}</p>
      <p v-if="held !== undefined" class="text-sm text-warning" data-test="operation-reject-held">{{ rejectHeldText(held) }}</p>
    </div>
  </div>
</template>
