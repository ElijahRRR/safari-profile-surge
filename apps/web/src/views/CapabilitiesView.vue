<script setup lang="ts">
// 能力门槛：每项能力的通过条件、记录结论、有效结论（上下文不一致即待验证）、过期原因、上下文与说明；
// 待确认的提议只能在这里「确认」，也可「重置为待验证」。结论来自测试 Mac 上的 P0 工具，网页只确认不提议。
import { computed, reactive } from 'vue';
import { CAPABILITY_CRITERIA, CAPABILITY_LABELS, type CapabilityProposalView, type CapabilityView } from '@sfe/contract';
import { Badge, BaseDialog, ConfirmDialog, DataTable, Icon, PageHeader, TextField, type TableColumn } from '@sfe/easyquick';
import CapabilityContextList from '../components/CapabilityContextList.vue';
import NoticeBox from '../components/NoticeBox.vue';
import ProtocolCoverageTable from '../components/ProtocolCoverageTable.vue';
import { useConsole } from '../store/context';
import { COVERAGE_REQUIRED_KEYS, allCapabilities, capabilityCounts, coverageBlockReason, staleReasonText, versionBlockReason } from '../lib/gates';
import { CAPABILITY_STATUS_LABELS, ENTRY_STRATEGY_LABELS } from '../lib/labels';
import { formatCount, formatDateTime } from '../lib/format';
import { newRequestId } from '../lib/request-id';

const { api, store, toasts } = useConsole();

const caps = computed(() => allCapabilities(store.capabilities.value));
const proposals = computed(() => store.proposals.value);
const counts = computed(() => capabilityCounts(store.capabilities.value));
const description = computed(
  () => `已通过 ${formatCount(counts.value.supported, '项')}，待验证 ${formatCount(counts.value.unverified, '项')}，待确认提议 ${formatCount(proposals.value.length)}`,
);

const columns: TableColumn[] = [
  { key: 'label', label: '能力与通过条件', wrap: true, class: 'min-w-[18rem] max-w-md' },
  { key: 'status', label: '记录结论' },
  { key: 'effective', label: '有效结论' },
  { key: 'stale', label: '过期原因', wrap: true },
  { key: 'context', label: '验证上下文', wrap: true, class: 'min-w-[12rem]' },
  { key: 'verifiedAt', label: '验证时间' },
  { key: 'note', label: '说明', wrap: true, class: 'min-w-[12rem]' },
  { key: 'actions', label: '操作' },
];

function contextSummary(ctx: CapabilityView['context']): string {
  if (!ctx) return '—';
  const parts = [
    ctx.surgeVersion ? `Surge ${ctx.surgeVersion}${ctx.surgeBuild ? `（${ctx.surgeBuild}）` : ''}` : null,
    ctx.macosBuild ? `macOS ${ctx.macosBuild}` : null,
    ctx.safariVersion ? `Safari ${ctx.safariVersion}` : null,
    ctx.entryStrategy ? ENTRY_STRATEGY_LABELS[ctx.entryStrategy] : null,
  ].filter((x): x is string => x !== null);
  return parts.length ? parts.join(' · ') : '—';
}

function staleText(cap: CapabilityView): string {
  return staleReasonText(cap, store.surge.value);
}

function confirmBlock(p: CapabilityProposalView): string | null {
  if (store.demoMode.value) return '演示模式不能确认能力';
  return versionBlockReason(p) ?? coverageBlockReason(p);
}

// ---------- 详情 ----------
const detail = reactive({ show: false, cap: null as CapabilityView | null });

// ---------- 确认提议 ----------
const confirmState = reactive({ show: false, proposal: null as CapabilityProposalView | null, submitting: false });
const confirmDetail = computed(() => {
  const p = confirmState.proposal;
  if (!p) return '';
  const status = CAPABILITY_STATUS_LABELS[p.proposedStatus].label;
  return `确认后「${CAPABILITY_LABELS[p.key]}」记为${status}，并记录验证上下文；依赖它的动作随之开放或保持阻止。`;
});
const pathsNotice = computed(() => {
  const k = confirmState.proposal?.key;
  return k === 'safari_process_attribution' || k === 'runtime_entry_modes';
});

async function doConfirm() {
  const p = confirmState.proposal;
  if (!p) return;
  confirmState.submitting = true;
  try {
    store.setCapability(await api.confirmCapability({ request_id: newRequestId(), action: 'confirm', proposal_id: p.id }));
    toasts.success(`已确认：${CAPABILITY_LABELS[p.key]}`);
    confirmState.show = false;
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '确认失败');
  } finally {
    confirmState.submitting = false;
  }
}

// ---------- 重置 ----------
const resetState = reactive({ show: false, cap: null as CapabilityView | null, note: '', submitting: false });

async function doReset() {
  const c = resetState.cap;
  if (!c) return;
  resetState.submitting = true;
  try {
    store.setCapability(await api.confirmCapability({ request_id: newRequestId(), action: 'reset', key: c.key, note: resetState.note.trim() === '' ? null : resetState.note.trim() }));
    toasts.success(`已重置为待验证：${c.label}`);
    resetState.show = false;
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '重置失败');
  } finally {
    resetState.submitting = false;
  }
}
</script>

<template>
  <div>
    <PageHeader title="能力门槛" :description="description" />
    <NoticeBox tone="info" class="mb-6">
      这些结论来自测试 Mac 上的 P0 工具：工具提交证据摘要作为提议，由你在这里确认后才生效。Surge、macOS、Safari、入口策略、进程路径、工作配置等上下文变化时，相关能力自动回到待验证；读不到运行中 Surge 的版本时，依赖版本的能力一律按待验证处理。离线测试通过不代表能力通过。
    </NoticeBox>

    <section v-if="proposals.length" class="mb-6 space-y-4" data-test="proposals">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">待确认的提议</h3>
      <div v-for="p in proposals" :key="p.id" class="card" :data-proposal="p.key">
        <div class="card-header flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-gray-900 dark:text-white">{{ CAPABILITY_LABELS[p.key] }}</span>
            <Badge :variant="CAPABILITY_STATUS_LABELS[p.proposedStatus].variant">提议：{{ CAPABILITY_STATUS_LABELS[p.proposedStatus].label }}</Badge>
          </div>
          <span class="text-xs text-gray-500 dark:text-dark-400">{{ p.submittedBy === 'agent' ? 'P0 工具' : '维护通道' }} · {{ formatDateTime(p.submittedAt) }}</span>
        </div>
        <div class="card-body space-y-4 text-sm">
          <p class="text-gray-700 dark:text-gray-300">{{ p.summary }}</p>
          <p class="text-xs text-gray-500 dark:text-dark-400">通过条件：{{ CAPABILITY_CRITERIA[p.key] }}</p>
          <p class="text-xs text-gray-500 dark:text-dark-400">证据摘要 <span class="code">{{ p.evidenceDigest }}</span></p>
          <CapabilityContextList :context="p.context" />
          <ProtocolCoverageTable v-if="p.protocolCoverage || COVERAGE_REQUIRED_KEYS.includes(p.key)" :coverage="p.protocolCoverage" />
          <NoticeBox v-if="confirmBlock(p)" tone="warning" data-test="confirm-block">{{ confirmBlock(p) }}</NoticeBox>
        </div>
        <div class="card-footer flex justify-end">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="confirmBlock(p) !== null"
            :title="confirmBlock(p) ?? undefined"
            data-test="confirm-proposal"
            @click="Object.assign(confirmState, { show: true, proposal: p, submitting: false })"
          >
            确认
          </button>
        </div>
      </div>
    </section>

    <DataTable :columns="columns" :rows="caps" :row-key="(c) => c.key" :loading="!store.state.snapshot" caption="能力列表" data-test="capability-table">
      <template #cell-label="{ row }">
        <div class="space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium text-gray-900 dark:text-white">{{ row.label || CAPABILITY_LABELS[row.key] }}</span>
            <span class="code text-xs">{{ row.key }}</span>
          </div>
          <p class="text-xs leading-relaxed text-gray-500 dark:text-dark-400" data-test="criteria">{{ CAPABILITY_CRITERIA[row.key] }}</p>
        </div>
      </template>
      <template #cell-status="{ row }"><Badge :variant="CAPABILITY_STATUS_LABELS[row.status].variant">{{ CAPABILITY_STATUS_LABELS[row.status].label }}</Badge></template>
      <template #cell-effective="{ row }"><Badge :variant="CAPABILITY_STATUS_LABELS[row.effectiveStatus].variant">{{ CAPABILITY_STATUS_LABELS[row.effectiveStatus].label }}</Badge></template>
      <template #cell-stale="{ row }">
        <span v-if="row.staleReasons.length" class="text-xs text-red-600 dark:text-red-400" data-test="stale-reason">{{ staleText(row) }}</span>
        <span v-else class="text-gray-500 dark:text-dark-400">—</span>
      </template>
      <template #cell-context="{ row }"><span class="text-xs text-gray-700 dark:text-gray-300">{{ contextSummary(row.context) }}</span></template>
      <template #cell-verifiedAt="{ row }">{{ row.verifiedAt ? formatDateTime(row.verifiedAt) : '未验证' }}</template>
      <template #cell-note="{ row }"><span class="text-xs text-gray-700 dark:text-gray-300">{{ row.note ?? '—' }}</span></template>
      <template #cell-actions="{ row }">
        <div class="flex items-center gap-1">
          <button type="button" class="btn btn-ghost btn-sm" :aria-label="`查看 ${row.label} 的详情`" title="详情" @click="Object.assign(detail, { show: true, cap: row })">
            <Icon name="eye" size="sm" />
          </button>
          <button
            v-if="row.status !== 'unverified'"
            type="button"
            class="btn btn-ghost btn-sm"
            :aria-label="`把 ${row.label} 重置为待验证`"
            title="重置为待验证"
            data-test="reset-capability"
            @click="Object.assign(resetState, { show: true, cap: row, note: '', submitting: false })"
          >
            <Icon name="refresh" size="sm" />
          </button>
        </div>
      </template>
    </DataTable>

    <BaseDialog :show="detail.show" :title="detail.cap?.label ?? '能力详情'" width="wide" @close="detail.show = false">
      <div v-if="detail.cap" class="space-y-5 text-sm">
        <p class="text-gray-700 dark:text-gray-300">{{ CAPABILITY_CRITERIA[detail.cap.key] }}</p>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-gray-500 dark:text-dark-400">记录</span>
          <Badge :variant="CAPABILITY_STATUS_LABELS[detail.cap.status].variant">{{ CAPABILITY_STATUS_LABELS[detail.cap.status].label }}</Badge>
          <span class="text-gray-500 dark:text-dark-400">有效</span>
          <Badge :variant="CAPABILITY_STATUS_LABELS[detail.cap.effectiveStatus].variant">{{ CAPABILITY_STATUS_LABELS[detail.cap.effectiveStatus].label }}</Badge>
        </div>
        <section>
          <h4 class="mb-2 font-semibold text-gray-900 dark:text-white">验证上下文</h4>
          <CapabilityContextList :context="detail.cap.context" :stale="detail.cap.staleReasons" />
          <p v-if="detail.cap.staleReasons.length" class="mt-2 text-xs text-red-600 dark:text-red-400" data-test="detail-stale-reason">过期原因：{{ staleText(detail.cap) }}</p>
        </section>
        <section v-if="detail.cap.protocolCoverage || COVERAGE_REQUIRED_KEYS.includes(detail.cap.key)">
          <h4 class="mb-2 font-semibold text-gray-900 dark:text-white">逐协议覆盖</h4>
          <ProtocolCoverageTable :coverage="detail.cap.protocolCoverage" />
        </section>
        <p v-if="detail.cap.note" class="text-gray-700 dark:text-gray-300">说明：{{ detail.cap.note }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="detail.show = false">关闭</button>
      </template>
    </BaseDialog>

    <ConfirmDialog
      :show="confirmState.show"
      title="确认提议"
      message="确定要确认此提议吗？"
      confirm-text="确认"
      :loading="confirmState.submitting"
      @confirm="doConfirm"
      @cancel="confirmState.show = false"
    >
      <p>{{ confirmDetail }}</p>
      <NoticeBox v-if="pathsNotice" tone="warning">确认新的进程路径或入口策略会让依赖它们的能力回到待验证；入口不是普通模式时服务会拒绝确认。</NoticeBox>
    </ConfirmDialog>

    <ConfirmDialog
      :show="resetState.show"
      title="重置为待验证"
      :message="`确定要把「${resetState.cap?.label ?? ''}」重置为待验证吗？`"
      confirm-text="重置"
      variant="warning"
      :loading="resetState.submitting"
      @confirm="doReset"
      @cancel="resetState.show = false"
    >
      <p>依赖这项能力的动作会立即被阻止，直到新的实测提议经你确认。</p>
      <TextField v-model="resetState.note" label="原因（可选）" placeholder="例如：Surge 升级后需要重测" />
    </ConfirmDialog>
  </div>
</template>
