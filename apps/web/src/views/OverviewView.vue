<script setup lang="ts">
// 概览：统计卡、当前路由、Surge 状态、能力门槛摘要与最近操作。
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { Badge, PageHeader, Skeleton, StatCard } from '@sfe/easyquick';
import RouteCard from '../components/RouteCard.vue';
import SurgeStatusCard from '../components/SurgeStatusCard.vue';
import GateSummaryCard from '../components/GateSummaryCard.vue';
import { useConsole } from '../store/context';
import { OPERATION_KIND_LABELS, OPERATION_PHASE_LABELS } from '../lib/labels';
import { envLabel } from '../lib/environments';
import { formatCount, formatRelative } from '../lib/format';

const { store, viewer } = useConsole();
const stats = computed(() => store.stats.value);
const recent = computed(() => store.state.operations.filter((o) => o.kind !== 'maintenance.reconcile').slice(0, 6));
const description = computed(() => {
  const s = stats.value;
  if (!store.state.snapshot) return '正在读取状态';
  return `共 ${formatCount(s.total)}环境，${formatCount(s.using)}使用中，最近对账于 ${formatRelative(store.route.value?.lastReconciledAt, store.state.now)}`;
});

function opEnvLabel(id: string | null): string | null {
  const env = id ? store.environmentsById.value.get(id) : null;
  return env ? envLabel(env) : null;
}
</script>

<template>
  <div>
    <PageHeader title="概览" :description="description" />
    <div v-if="!store.state.snapshot" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <div v-for="n in 4" :key="n" class="card card-body"><Skeleton class="h-12 w-full" /></div>
    </div>
    <template v-else>
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard title="环境总数" :value="stats.total" icon="users" />
        <StatCard title="使用中" :value="stats.using" icon="play" icon-variant="success" />
        <StatCard title="待部署" :value="stats.pending" icon="upload" icon-variant="warning" />
        <StatCard title="需要处理" :value="stats.attention" icon="exclamationTriangle" icon-variant="danger" />
      </div>
      <div class="mt-6 grid gap-6 xl:grid-cols-2">
        <RouteCard />
        <SurgeStatusCard />
      </div>
      <div class="mt-6 grid gap-6 xl:grid-cols-2">
        <GateSummaryCard />
        <div class="card">
          <div class="card-header flex items-center justify-between">
            <h3 class="text-base font-semibold text-gray-900 dark:text-white">最近操作</h3>
            <RouterLink to="/operations" class="btn btn-ghost btn-sm">查看全部</RouterLink>
          </div>
          <div v-if="recent.length" class="divide-y divide-gray-100 dark:divide-dark-700">
            <button
              v-for="op in recent"
              :key="op.id"
              type="button"
              class="flex w-full items-center justify-between gap-3 px-6 py-3 text-left text-sm hover:bg-gray-50 dark:hover:bg-dark-800"
              @click="viewer.open(op.id)"
            >
              <span class="min-w-0">
                <span class="block font-medium text-gray-900 dark:text-white">{{ OPERATION_KIND_LABELS[op.kind] }}</span>
                <span class="block truncate text-xs text-gray-500 dark:text-dark-400">{{ opEnvLabel(op.environmentId) ?? '全局' }} · {{ formatRelative(op.updatedAt, store.state.now) }}</span>
              </span>
              <Badge :variant="OPERATION_PHASE_LABELS[op.phase].variant">{{ OPERATION_PHASE_LABELS[op.phase].label }}</Badge>
            </button>
          </div>
          <p v-else class="card-body text-sm text-gray-500 dark:text-dark-400">还没有操作记录。新建或导入环境后，每个任务的进度会显示在这里。</p>
        </div>
      </div>
    </template>
  </div>
</template>
