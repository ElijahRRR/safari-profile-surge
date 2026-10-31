<script setup lang="ts">
// 已识别、未绑定的场景：关联已有环境（逐个确认，不按名称自动套用）、在此创建环境；
// 有其他环境使用中时可以结束当前环境、进入普通模式；没有使用中的环境、但服务端仍提供「进入普通模式」时（入口不是普通模式，
// 例如第一次激活被取消后停在阻断；回滚失败记为 NORMAL、阶段 attention；上一次普通模式未能确认 Safari 已没有经买家出口的连接）
// 显示原因并提供「进入普通模式」（§6.5：任何已识别场景都可发起）。
import { computed, ref } from 'vue';
import { Icon } from '@sfe/easyquick';
import { SITES, type BindableEnvironment } from '@sfe/contract';
import BaseDialog from '../ui/BaseDialog.vue';
import StatusBadge from '../ui/StatusBadge.vue';
import CreateForm from './CreateForm.vue';
import type { PopupController } from './controller';
import { WARNING_TEXT, summaryOffersNormal, unsettledRouteText } from '../shared/text';

const props = defineProps<{ controller: PopupController }>();
const c = props.controller;
const s = c.state;

const buyerExit = computed(() => s.current?.routeSummary.buyerExitConnectionsUnconfirmed === true);
/** 没有使用中的环境时按路由摘要提供「进入普通模式」；有其他环境使用中时由下方「结束当前环境」提供。 */
const offerNormal = computed(() => !!s.current && s.current.relation === 'none_active' && summaryOffersNormal(s.current.routeSummary));

const creating = ref(false);
const bindTarget = ref<BindableEnvironment | null>(null);

async function confirmBind() {
  const target = bindTarget.value;
  bindTarget.value = null;
  if (target) await c.bind(target);
}
</script>

<template>
  <div class="space-y-3" data-test="unbound-view">
    <CreateForm v-if="creating" :controller="c" @close="creating = false" @saved="creating = false" />
    <template v-else>
      <div class="card">
        <div class="card-body space-y-3 p-4">
          <div class="flex items-start justify-between gap-2">
            <div>
              <h2 class="text-base font-semibold text-gray-900 dark:text-white">当前场景未绑定</h2>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-dark-400">
                场景 <span class="code">{{ s.current?.profile.profileIdShort ?? '未知' }}</span>
              </p>
            </div>
            <StatusBadge status="info" label="未绑定" />
          </div>
          <p class="text-sm text-gray-600 dark:text-gray-300">选择要关联的环境，或在此创建。不会按场景名称自动关联。</p>
          <ul v-if="s.current?.bindable.length" class="divide-y divide-gray-100 dark:divide-dark-700" data-test="bindable-list">
            <li v-for="e in s.current.bindable" :key="e.id" class="flex items-center justify-between gap-2 py-2">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-gray-900 dark:text-white">{{ e.label }}</p>
                <p class="text-xs text-gray-500 dark:text-dark-400">{{ SITES[e.site].label }}</p>
              </div>
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                :disabled="!!s.busy"
                :data-test="`bind-${e.id}`"
                @click="bindTarget = e"
              >
                <Icon name="link" size="sm" />
                关联
              </button>
            </li>
          </ul>
          <p v-else class="rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-500 dark:bg-dark-900/40 dark:text-dark-400">
            没有可关联的环境。可以在此创建，或在网页后台导入后再关联。
          </p>
          <button type="button" class="btn btn-primary w-full" :disabled="!!s.busy" data-test="open-create" @click="creating = true">
            <Icon name="plus" size="md" />
            在此创建环境
          </button>
        </div>
      </div>

      <div v-if="s.current && (buyerExit || offerNormal)" class="card" data-test="route-attention">
        <div class="card-body space-y-2 p-4">
          <p v-if="buyerExit" class="flex items-start gap-2 text-sm text-warning" data-test="buyer-exit-unconfirmed" data-warning="buyer_exit_connections_unconfirmed">
            <Icon name="exclamationTriangle" size="sm" class="mt-0.5" />
            <span>{{ WARNING_TEXT.buyer_exit_connections_unconfirmed }}</span>
          </p>
          <p v-else-if="offerNormal" class="flex items-start gap-2 text-sm text-warning" data-test="route-unsettled">
            <Icon name="exclamationTriangle" size="sm" class="mt-0.5" />
            <span>{{ unsettledRouteText(s.current.routeSummary) }}</span>
          </p>
          <button
            v-if="offerNormal"
            type="button"
            class="btn btn-secondary btn-sm w-full"
            :disabled="!!s.busy"
            data-test="normal"
            @click="c.enterNormal()"
          >
            进入普通模式
          </button>
        </div>
      </div>

      <div v-if="s.current?.relation === 'other_active'" class="card" data-test="other-active">
        <div class="card-body space-y-2 p-4">
          <p class="text-sm text-gray-700 dark:text-gray-300">
            当前正在使用「{{ s.current.otherActiveLabel ?? '另一个环境' }}」。整个 Safari 同一时刻只用一个出口，此场景的请求也会经过它。
          </p>
          <button type="button" class="btn btn-secondary btn-sm w-full" :disabled="!!s.busy" data-test="end-current" @click="c.enterNormal()">
            结束当前环境，进入普通模式
          </button>
        </div>
      </div>
    </template>

    <BaseDialog v-if="bindTarget" title="确定要关联此环境吗？" width="narrow" @close="bindTarget = null">
      <p>当前 Safari 场景将关联到「{{ bindTarget.label }}」。之后只按场景标识识别，修改名称不影响关联。</p>
      <template #footer>
        <button type="button" class="btn btn-secondary btn-sm" @click="bindTarget = null">取消</button>
        <button type="button" class="btn btn-primary btn-sm" data-test="confirm-bind" @click="confirmBind">关联</button>
      </template>
    </BaseDialog>
  </div>
</template>
