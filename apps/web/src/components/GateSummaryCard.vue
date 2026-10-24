<script setup lang="ts">
// 能力门槛摘要：各结论的数量，以及每个动作当前是否被阻止、缺哪些能力。
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { CAPABILITY_LABELS } from '@sfe/contract';
import { StatusBadge } from '@sfe/easyquick';
import { useConsole } from '../store/context';
import { GATE_LABELS, SUMMARY_GATES, capabilityCounts, evaluateGate } from '../lib/gates';
import { formatCount } from '../lib/format';

const { store } = useConsole();
const counts = computed(() => capabilityCounts(store.capabilities.value));
const gates = computed(() =>
  SUMMARY_GATES.map((g) => {
    const result = evaluateGate(store.capabilities.value, g, store.settings.value?.entryStrategy ?? null);
    return { name: g, label: GATE_LABELS[g], ...result, missingText: result.missing.map((m) => CAPABILITY_LABELS[m.key]).join('、') };
  }),
);
</script>

<template>
  <div class="card" data-test="gate-card">
    <div class="card-header flex items-center justify-between gap-3">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">能力门槛</h3>
      <RouterLink to="/capabilities" class="btn btn-ghost btn-sm">查看全部</RouterLink>
    </div>
    <div class="card-body space-y-4">
      <div class="flex flex-wrap gap-4 text-sm">
        <StatusBadge status="success" :label="`已通过 ${formatCount(counts.supported, '项')}`" />
        <StatusBadge status="danger" :label="`不支持 ${formatCount(counts.unsupported, '项')}`" />
        <StatusBadge status="unknown" :label="`待验证 ${formatCount(counts.unverified, '项')}`" />
      </div>
      <ul class="divide-y divide-gray-100 text-sm dark:divide-dark-700">
        <li v-for="g in gates" :key="g.name" class="flex flex-wrap items-start justify-between gap-3 py-2.5">
          <span class="text-gray-900 dark:text-gray-100">{{ g.label }}</span>
          <span class="flex min-w-0 flex-col items-end gap-1">
            <StatusBadge :status="g.met ? 'success' : 'danger'" :label="g.met ? '可用' : g.name === 'killSafariConnections' ? '受阻（普通模式下尽力而为）' : '受阻'" />
            <span v-if="!g.met" class="text-right text-xs text-gray-500 dark:text-dark-400">缺少：{{ g.missingText }}</span>
          </span>
        </li>
      </ul>
      <p class="text-xs text-gray-500 dark:text-dark-400">进入普通模式不受门槛限制，任何时候都可以撤销本应用的入口。</p>
    </div>
  </div>
</template>
