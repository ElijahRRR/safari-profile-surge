<script setup lang="ts">
// 待部署：列出期望版本比已部署新的环境。发布门槛不满足时发布按钮禁用并列出缺失能力——
// 没有“忽略/仍然发布”的按钮，也不提供重载配置作为兜底。
// 勾选后只发布所选：所选环境离开待部署列表（部署完成、在别处发布或删除）时从选择中移除并提示重新选择，
// 从不退回“发布全部待部署”。
import { computed, ref, watch } from 'vue';
import { Badge, DataTable, EmptyState, Icon, Spinner, type TableColumn } from '@sfe/easyquick';
import MissingCapabilities from './MissingCapabilities.vue';
import NoticeBox from './NoticeBox.vue';
import { useConsole } from '../store/context';
import { evaluateGate } from '../lib/gates';
import { DEPLOYMENT_FACET_LABELS } from '../lib/labels';
import { envLabel } from '../lib/environments';
import { formatCount, formatRevision } from '../lib/format';
import { newRequestId } from '../lib/request-id';

const { api, store, toasts, accepted } = useConsole();

const pending = computed(() => store.pendingDeploy.value);
const gate = computed(() => evaluateGate(store.capabilities.value, 'publish'));
const selected = ref<string[]>([]);
/** 已勾选、但之后离开待部署列表而被移出选择的环境（展示名）；非空时必须重新选择才能发布。 */
const dropped = ref<string[]>([]);
const publishing = ref(false);

const lastPublish = computed(() => store.state.operations.find((o) => o.kind === 'deploy.publish' && o.result?.readbackLevel) ?? null);

const columns: TableColumn[] = [
  { key: 'env', label: '环境' },
  { key: 'desired', label: '期望版本' },
  { key: 'deployed', label: '已部署版本' },
  { key: 'state', label: '部署状态' },
  { key: 'next', label: '下一步', wrap: true },
];

/** 把不在待部署列表中的已选环境移出选择，记下它们以提示重新选择；返回是否有移除。 */
function pruneSelection(): boolean {
  const byId = new Map(pending.value.map((e) => [e.id, e]));
  const gone = selected.value.filter((id) => !byId.has(id));
  if (gone.length === 0) return false;
  selected.value = selected.value.filter((id) => byId.has(id));
  const labels = gone.map((id) => {
    const env = store.environmentsById.value.get(id);
    return env ? envLabel(env) : '已删除的环境';
  });
  dropped.value = [...new Set([...dropped.value, ...labels])];
  return true;
}
watch(pending, (list) => {
  // 列表已清空：所选都已处理完，没有可发布的内容，也就不存在“退回发布全部”的风险。
  if (list.length === 0) clearSelection();
  else pruneSelection();
});

function onSelect(keys: string[]) {
  selected.value = keys;
  dropped.value = [];
}

function clearSelection() {
  selected.value = [];
  dropped.value = [];
}

// 所选已全部离开列表时不显示“发布全部待部署”：按钮保持「发布所选（0）」并禁用，直到重新选择或清除选择。
const selectionLost = computed(() => selected.value.length === 0 && dropped.value.length > 0);
const buttonText = computed(() => (selected.value.length || selectionLost.value ? `发布所选（${selected.value.length}）` : '发布全部待部署'));

async function publish() {
  if (!gate.value.met || pending.value.length === 0 || selectionLost.value) return;
  // 所选与当前待部署列表不一致（例如刚部署完成）：更新选择并请你重新确认，不发送、也不改为发布全部。
  if (pruneSelection()) {
    toasts.warning('所选环境中有的已不再待部署，已更新选择，请确认后重新发布');
    return;
  }
  const ids = [...selected.value];
  publishing.value = true;
  try {
    const acc = await api.publishPending({ request_id: newRequestId(), ...(ids.length ? { environment_ids: ids } : {}) });
    clearSelection();
    accepted(acc, '已受理：正在发布节点，结果以读回为准');
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '发布失败');
  } finally {
    publishing.value = false;
  }
}
</script>

<template>
  <div class="card" data-test="pending-deploy">
    <div class="card-header flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold text-gray-900 dark:text-white">待部署</h3>
        <p class="text-xs text-gray-500 dark:text-dark-400">{{ formatCount(pending.length) }}环境有未发布的新版本</p>
      </div>
      <button type="button" class="btn btn-primary" :disabled="!gate.met || pending.length === 0 || publishing || selectionLost" data-test="publish-button" @click="publish">
        <Spinner v-if="publishing" color="white" decorative /><Icon v-else name="upload" />{{ buttonText }}
      </button>
    </div>
    <div class="card-body space-y-4">
      <NoticeBox v-if="!gate.met" tone="warning" title="发布能力尚未通过实测" data-test="publish-gate">
        <MissingCapabilities :missing="gate.missing" intro="新版本已保存为待部署。以下能力在测试 Mac 上通过实测并经你确认后才能发布：" />
      </NoticeBox>
      <NoticeBox v-if="dropped.length" tone="warning" title="所选环境已不再待部署" data-test="selection-dropped">
        <p>{{ dropped.join('、') }} 已部署完成或已在别处处理，已从选择中移除。{{ selectionLost ? '请重新选择要发布的环境，或清除选择后发布全部待部署。' : '请确认剩余的选择后再发布。' }}</p>
        <div v-if="selectionLost" class="mt-2">
          <button type="button" class="btn btn-secondary btn-sm" data-test="clear-selection" @click="clearSelection">清除选择</button>
        </div>
      </NoticeBox>
      <NoticeBox v-if="lastPublish?.result?.readbackLevel === 'partial'" tone="warning" title="已部署，读回不完整">
        最近一次发布未能核对：{{ (lastPublish.result?.uncheckedFields ?? []).join('、') || '未列出的字段' }}。相关版本需要能力记录覆盖这些字段后才能激活。
      </NoticeBox>
      <p v-else-if="lastPublish?.result?.readbackLevel === 'full'" class="text-sm text-gray-500 dark:text-dark-400">最近一次发布读回完整。</p>
      <DataTable
        v-if="pending.length"
        :selected="selected"
        :columns="columns"
        :rows="pending"
        :row-key="(e) => e.id"
        :row-label="(e) => envLabel(e)"
        selectable
        flat
        caption="待部署环境"
        @update:selected="onSelect"
      >
        <template #cell-env="{ row }">{{ envLabel(row) }}</template>
        <template #cell-desired="{ row }"><span class="font-mono">{{ formatRevision(row.proxy.desired?.revision) }}</span></template>
        <template #cell-deployed="{ row }"><span class="font-mono">{{ formatRevision(row.proxy.deployed?.revision) }}</span></template>
        <template #cell-state="{ row }">
          <Badge :variant="DEPLOYMENT_FACET_LABELS[row.facets.deployment].variant">{{ DEPLOYMENT_FACET_LABELS[row.facets.deployment].label }}</Badge>
        </template>
        <template #cell-next="{ row }"><span class="text-gray-700 dark:text-gray-300">{{ row.nextActions[0]?.message ?? '—' }}</span></template>
      </DataTable>
      <EmptyState v-else icon="checkCircle" title="没有待部署的版本" description="修改代理参数后，新版本会出现在这里等待发布。" />
    </div>
  </div>
</template>
