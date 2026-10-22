<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import { Icon } from '@sfe/easyquick';
import { SITES } from '@sfe/contract';
import { DIALOG_COUNT } from '../ui/dialog';
import { WARNING_TEXT, entryModeHeaderText, summaryOffersNormal, unsettledRouteText } from '../shared/text';
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

// 原生桥拿不到 SFExtensionProfileKey 时服务按未识别场景处理（只允许读取状态与窗口上报）。Apple 的示例把没有这个键当作
// 普通浏览，Safari 的默认场景很可能就是这样，所以提示改用已命名的场景（默认场景的实际行为由 P0 native_profile_id 记录）。
const siteHosts = Object.values(SITES).map((site) => site.host).join('、');

// 未识别场景同样拿到路由关系与摘要（不含其他环境名称）：显示此场景的请求正经过另一个环境的出口、普通模式未能确认 Safari
// 已离开买家出口、或路由没有回到已确认的普通模式，并指明到哪里进入普通模式（服务端不受理未识别场景发起的普通模式）。
const unidentifiedRoute = computed(() => {
  const cur = s.current;
  if (!cur) return null;
  const summary = cur.routeSummary;
  const otherActive = cur.relation !== 'none_active';
  const buyerExit = summary.buyerExitConnectionsUnconfirmed === true;
  const unsettled = !otherActive && !buyerExit && summaryOffersNormal(summary);
  if (!otherActive && !buyerExit && !unsettled) return null;
  return { otherActive, buyerExit, unsettledText: unsettled ? unsettledRouteText(summary) : null };
});

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
        {{ entryModeHeaderText(s.current.routeSummary) }}
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
        <p class="text-sm text-gray-700 dark:text-gray-300" data-test="named-profile-required">
          环境只能关联在已命名的 Safari 场景中（默认场景可能拿不到场景标识）。请在 Safari 设置的「描述文件」中新建一个场景并为它启用本扩展（对 {{ siteHosts }} 的网站授权已对所有场景生效，授权过就不必重复），再在该场景的窗口中打开本扩展。
        </p>
        <p class="text-sm text-gray-500 dark:text-dark-400">已经在已命名的场景中仍看到此提示时：需要 macOS 14 与 Safari 17.6 或更新版本，并确认本扩展在此场景已启用。</p>
        <div v-if="unidentifiedRoute" class="space-y-2 border-t border-gray-100 pt-2 dark:border-dark-700" data-test="unidentified-route">
          <p v-if="unidentifiedRoute.otherActive" class="flex items-start gap-2 text-sm text-warning" data-test="unidentified-other-active">
            <Icon name="exclamationTriangle" size="sm" class="mt-0.5" />
            <span>另一个环境正在使用。整个 Safari 同一时刻只用一个出口，此场景的请求也会经过它的出口。</span>
          </p>
          <p v-if="unidentifiedRoute.buyerExit" class="flex items-start gap-2 text-sm text-warning" data-warning="buyer_exit_connections_unconfirmed">
            <Icon name="exclamationTriangle" size="sm" class="mt-0.5" />
            <span>{{ WARNING_TEXT.buyer_exit_connections_unconfirmed }}</span>
          </p>
          <p v-if="unidentifiedRoute.unsettledText" class="flex items-start gap-2 text-sm text-warning" data-test="route-unsettled">
            <Icon name="exclamationTriangle" size="sm" class="mt-0.5" />
            <span>{{ unidentifiedRoute.unsettledText }}</span>
          </p>
          <p class="text-sm text-gray-700 dark:text-gray-300" data-test="unidentified-normal-hint">
            未识别的场景不能在这里进入普通模式：请在网页后台，或在已命名场景的本扩展弹窗中进入普通模式。
          </p>
        </div>
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
