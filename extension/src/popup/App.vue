<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import { Icon } from '@sfe/easyquick';
import { DIALOG_COUNT } from '../ui/dialog';
import { ENTRY_MODE_TEXT } from '../shared/text';
import BoundView from './BoundView.vue';
import UnboundView from './UnboundView.vue';
import OperationProgress from './OperationProgress.vue';
import RouteConfirmDialog from './RouteConfirmDialog.vue';
import type { PopupController } from './controller';

const props = defineProps<{ controller: PopupController }>();
const c = props.controller;
const s = c.state;

const dialogs = ref(0);
provide(DIALOG_COUNT, dialogs);

const view = computed(() => {
  if (!s.current) return s.loading ? 'loading' : 'error';
  if (!s.current.profile.identified) return 'unidentified';
  if (!s.current.environment) return 'unbound';
  return 'bound';
});

const stopPolling = () => c.stop();
onMounted(() => {
  window.addEventListener('pagehide', stopPolling);
  void c.start();
});
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', stopPolling);
  c.stop();
});
</script>

<template>
  <div class="space-y-3 p-4" :class="{ 'min-h-[560px]': dialogs > 0 || s.confirm }" data-test="popup">
    <header class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <span class="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-primary text-white shadow-glow">
          <Icon name="globe" size="sm" />
        </span>
        <span class="text-sm font-semibold text-gray-900 dark:text-white">Safari 场景出口</span>
      </div>
      <span v-if="s.current" class="text-xs text-gray-500 dark:text-dark-400" data-test="entry-mode">
        {{ ENTRY_MODE_TEXT[s.current.routeSummary.entryMode] }}
      </span>
    </header>

    <p v-if="s.actionError" role="alert" class="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" data-test="action-error">{{ s.actionError }}</p>
    <p v-if="s.notice" role="status" class="rounded-xl bg-success-soft px-3 py-2 text-sm text-success" data-test="notice">{{ s.notice }}</p>
    <p v-if="s.loadError && s.current" class="text-xs text-gray-500 dark:text-dark-400" data-test="stale-hint">读取最新状态失败，显示的是上次结果。</p>

    <div v-if="view === 'loading'" class="card" aria-busy="true">
      <div class="card-body space-y-2 p-4">
        <div class="skeleton h-5 w-40"></div>
        <div class="skeleton h-4 w-full"></div>
        <div class="skeleton h-4 w-3/4"></div>
      </div>
    </div>

    <div v-else-if="view === 'error'" class="card" data-test="load-error">
      <div class="card-body space-y-3 p-4">
        <div class="flex items-start gap-2 text-sm text-danger">
          <Icon name="xCircle" size="md" />
          <span>{{ s.loadError ?? '读取当前场景失败' }}</span>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" @click="c.refresh()">
          <Icon name="refresh" size="sm" />
          重新读取
        </button>
      </div>
    </div>

    <div v-else-if="view === 'unidentified'" class="card" data-test="unidentified">
      <div class="card-body space-y-2 p-4">
        <div class="flex items-start gap-2">
          <Icon name="exclamationTriangle" size="md" class="text-amber-500" />
          <h2 class="text-base font-semibold text-gray-900 dark:text-white">未识别当前场景</h2>
        </div>
        <p class="text-sm text-gray-600 dark:text-gray-300">Safari 没有提供当前场景的标识。扩展只能读取状态，不能关联、切换或修改环境。</p>
        <p class="text-sm text-gray-500 dark:text-dark-400">需要 macOS 14 与 Safari 17 或更新版本，并确认本扩展在此场景已启用。</p>
      </div>
    </div>

    <UnboundView v-else-if="view === 'unbound'" :controller="c" />
    <BoundView v-else :controller="c" />

    <OperationProgress v-if="s.operation" :operation="s.operation" :now="s.now" />

    <RouteConfirmDialog
      v-if="s.confirm"
      :confirm="s.confirm"
      :busy="!!s.busy"
      @choose="(p) => c.confirmPolicy(p)"
      @cancel="c.dismissConfirm()"
    />
  </div>
</template>
