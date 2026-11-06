<script setup lang="ts">
// 待部署：列出期望版本比已部署新的环境。发布门槛不满足时发布按钮禁用并列出缺失能力——
// 没有“忽略/仍然发布”的按钮，也不提供重载配置作为兜底。
// 勾选后只发布所选：所选环境离开待部署列表（部署完成、在别处发布或删除）时从选择中移除并提示重新选择，
// 从不退回“发布全部待部署”。
// 本机资源服务（D10）的状态不满足发布前提（未监听、令牌不可用或可疑、工作配置未接入或仍是本地节点文件引用）时同样禁用并
// 写明原因，与服务端停泊的条件一致；Surge 中的节点可能不是已提交版本（needsRefresh）而没有待部署的环境时，按钮改为
// 「重新同步节点资源」（不带环境的发布：对本应用这一项资源执行一次单 key 更新并读回）。
import { computed, ref, watch } from 'vue';
import type { CapabilityKey } from '@sfe/contract';
import { Badge, DataTable, EmptyState, Icon, Spinner, type TableColumn } from '@sfe/easyquick';
import MissingCapabilities from './MissingCapabilities.vue';
import NoticeBox from './NoticeBox.vue';
import { useConsole } from '../store/context';
import { evaluateGate, nodeResourcePublishBlocks } from '../lib/gates';
import { DEPLOYMENT_FACET_LABELS, NODE_RESOURCE_NEEDS_REFRESH_BLOCKED_TEXT, NODE_RESOURCE_NEEDS_REFRESH_TEXT } from '../lib/labels';
import { envLabel } from '../lib/environments';
import { formatCount, formatRevision } from '../lib/format';
import { newRequestId } from '../lib/request-id';

const { api, store, toasts, accepted } = useConsole();

const pending = computed(() => store.pendingDeploy.value);
const gate = computed(() => evaluateGate(store.capabilities.value, 'publish'));
/** 回环资源四项补测（D10：节点由本机资源服务提供，只对这一项资源单 key 更新并读回）。 */
const LOOPBACK_KEYS: readonly CapabilityKey[] = ['loopback_resource_update', 'loopback_resource_auth', 'loopback_resource_restart', 'loopback_publish_crash'];
/** 回环资源补测尚未全部通过：新版本保持待部署。 */
const loopbackUnproven = computed(() => gate.value.missing.some((m) => LOOPBACK_KEYS.includes(m.key)));
/** 本机资源服务的状态（不含地址、端口或令牌）；旧版服务不带这一项时为 undefined。 */
const nodeResource = computed(() => store.surge.value?.nodeResource);
/** 本机资源服务上发布的前提不满足的原因（为空时可以发布）。 */
const resourceBlocks = computed(() => nodeResourcePublishBlocks(nodeResource.value));
/** 没有待部署的环境，但 Surge 中的节点可能不是已提交的版本：发布只重新同步节点资源。 */
const resyncOnly = computed(() => pending.value.length === 0 && nodeResource.value?.needsRefresh === true);
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
const buttonText = computed(() => {
  if (selected.value.length || selectionLost.value) return `发布所选（${selected.value.length}）`;
  return resyncOnly.value ? '重新同步节点资源' : '发布全部待部署';
});
const canPublish = computed(() => gate.value.met && resourceBlocks.value.length === 0 && (pending.value.length > 0 || resyncOnly.value) && !selectionLost.value);

async function publish() {
  if (!canPublish.value) return;
  // 所选与当前待部署列表不一致（例如刚部署完成）：更新选择并请你重新确认，不发送、也不改为发布全部。
  if (pruneSelection()) {
    toasts.warning('所选环境中有的已不再待部署，已更新选择，请确认后重新发布');
    return;
  }
  const ids = [...selected.value];
  const resync = resyncOnly.value;
  publishing.value = true;
  try {
    const acc = await api.publishPending({ request_id: newRequestId(), ...(ids.length ? { environment_ids: ids } : {}) });
    clearSelection();
    accepted(acc, resync ? '已受理：正在重新同步节点资源，结果以读回为准' : '已受理：正在发布节点，结果以读回为准');
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
      <button type="button" class="btn btn-primary" :disabled="!canPublish || publishing" data-test="publish-button" @click="publish">
        <Spinner v-if="publishing" color="white" decorative /><Icon v-else name="upload" />{{ buttonText }}
      </button>
    </div>
    <div class="card-body space-y-4">
      <NoticeBox v-if="!gate.met" tone="warning" title="发布能力尚未通过实测" data-test="publish-gate">
        <MissingCapabilities :missing="gate.missing" intro="新版本已保存为待部署。以下能力在测试 Mac 上通过实测并经你确认后才能发布：" />
        <p v-if="loopbackUnproven" class="mt-2 text-sm text-gray-700 dark:text-gray-300" data-test="node-resource-note">
          新节点改由本应用的本机资源服务提供（只监听 127.0.0.1，地址带随机读取令牌）：发布时只对这一项外部资源执行一次更新（从不更新全部），再读回资源错误、组成员、选择与节点参数，Surge 报告成功不算已载入。回环资源单 key 更新、服务认证与端口占用、重启缓存、并发与崩溃四项补测在测试 Mac 上通过并经你确认之前，新版本保持“已保存，待部署”。资源服务停止时已载入的节点继续工作已实测；Surge 或 Mac 重启后的行为尚待补测。
        </p>
      </NoticeBox>
      <NoticeBox v-if="resourceBlocks.length" tone="danger" title="发布暂停" data-test="node-resource-block">
        <ul class="list-disc space-y-1 pl-5">
          <li v-for="r in resourceBlocks" :key="r">{{ r }}</li>
        </ul>
        <p class="mt-2">新版本保持“已保存，待部署”。</p>
      </NoticeBox>
      <!-- “下一次发布会单 key 更新”只在资源服务满足发布前提时成立；否则（仍引用本地节点文件、未监听、令牌可疑等）发布停泊、服务也不自动同步 -->
      <NoticeBox v-if="nodeResource?.needsRefresh" tone="warning" title="节点资源待重新同步" data-test="node-resource-refresh">{{
        resourceBlocks.length === 0 ? NODE_RESOURCE_NEEDS_REFRESH_TEXT : NODE_RESOURCE_NEEDS_REFRESH_BLOCKED_TEXT
      }}</NoticeBox>
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
