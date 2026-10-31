<script setup lang="ts">
// 前置代理：只登记用户已有、经核对的 Surge 代理节点（不接受组、内置策略或 SFE- 节点）。
// 默认、核验、停用（有依赖环境时不能停用）、为选中的依赖环境更换前置（预览 → 提交）。
import { computed, reactive, ref } from 'vue';
import type { FrontProxyId, FrontProxyView, ReplaceFrontPreview } from '@sfe/contract';
import { Badge, BaseDialog, ConfirmDialog, DataTable, DropdownMenu, Icon, SelectField, Spinner, type MenuItem, type SelectOption, type TableColumn } from '@sfe/easyquick';
import NoticeBox from './NoticeBox.vue';
import { useConsole } from '../store/context';
import { isApiError, type SurgePolicyCandidates } from '../api/client';
import { newRequestId } from '../lib/request-id';
import { FRONT_STATE_LABELS } from '../lib/labels';
import { envLabel } from '../lib/environments';
import { formatCount, formatRelative } from '../lib/format';

const { api, store, toasts, accepted } = useConsole();
const fronts = computed(() => store.frontProxies.value);

const columns: TableColumn[] = [
  { key: 'name', label: 'Surge 节点' },
  { key: 'state', label: '状态' },
  { key: 'deps', label: '依赖环境' },
  { key: 'checked', label: '最近核验' },
  { key: 'actions', label: '操作' },
];

// ---------- 登记 ----------
const reg = reactive({ show: false, loading: false, candidates: null as SurgePolicyCandidates | null, choice: null as string | null, makeDefault: false, submitting: false, error: null as string | null });

async function openRegister() {
  Object.assign(reg, { show: true, loading: true, candidates: null, choice: null, makeDefault: fronts.value.length === 0, submitting: false, error: null });
  try {
    reg.candidates = await api.surgeCandidates();
  } catch (e) {
    reg.error = e instanceof Error ? e.message : '读取 Surge 节点失败';
  } finally {
    reg.loading = false;
  }
}

const candidateOptions = computed<SelectOption<string | null>[]>(() => {
  const taken = new Set(fronts.value.filter((f) => !f.retired).map((f) => f.surgeName));
  return (reg.candidates?.proxies ?? []).filter((n) => !taken.has(n)).map((n) => ({ value: n, label: n }));
});

async function submitRegister() {
  if (!reg.choice) return;
  reg.submitting = true;
  reg.error = null;
  try {
    const fp = await api.registerFrontProxy({ request_id: newRequestId(), surgeName: reg.choice, makeDefault: reg.makeDefault });
    store.setFrontProxy(fp);
    reg.show = false;
    toasts.success(`已登记前置 ${fp.surgeName}`);
  } catch (e) {
    reg.error = e instanceof Error ? e.message : '登记失败';
  } finally {
    reg.submitting = false;
  }
}

// ---------- 行内操作 ----------
function menuItems(f: FrontProxyView): MenuItem[] {
  const items: MenuItem[] = [];
  if (!f.isDefault && !f.retired) items.push({ key: 'default', label: '设为默认' });
  if (!f.retired) items.push({ key: 'verify', label: '核验' });
  if (f.dependentEnvironmentIds.length > 0) items.push({ key: 'replace', label: '为依赖环境更换前置' });
  if (!f.retired) items.push({ key: 'retire', label: f.dependentEnvironmentIds.length ? '停用（先更换依赖环境的前置）' : '停用', danger: true, disabled: f.dependentEnvironmentIds.length > 0 });
  return items;
}

const retire = reactive({ show: false, front: null as FrontProxyView | null, submitting: false });

async function onMenu(f: FrontProxyView, key: string) {
  if (key === 'default') {
    try {
      store.setFrontProxy(await api.updateFrontProxy(f.id, { request_id: newRequestId(), makeDefault: true }));
      toasts.success(`已把 ${f.surgeName} 设为默认前置`);
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : '设置失败');
    }
  } else if (key === 'verify') {
    try {
      accepted(await api.verifyFrontProxy(f.id, { request_id: newRequestId() }), '已受理：正在核验前置');
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : '核验失败');
    }
  } else if (key === 'replace') {
    openReplace(f);
  } else if (key === 'retire') {
    Object.assign(retire, { show: true, front: f, submitting: false });
  }
}

async function confirmRetire() {
  const f = retire.front;
  if (!f) return;
  retire.submitting = true;
  try {
    store.setFrontProxy(await api.updateFrontProxy(f.id, { request_id: newRequestId(), retire: true }));
    toasts.success(`已停用前置 ${f.surgeName}`);
    retire.show = false;
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '停用失败');
  } finally {
    retire.submitting = false;
  }
}

// ---------- 更换前置 ----------
const rep = reactive({
  show: false,
  source: null as FrontProxyView | null,
  target: null as FrontProxyId | null,
  envIds: [] as string[],
  preview: null as ReplaceFrontPreview | null,
  loading: false,
  submitting: false,
  stale: false,
  error: null as string | null,
});

function openReplace(f: FrontProxyView) {
  Object.assign(rep, { show: true, source: f, target: null, envIds: [...f.dependentEnvironmentIds], preview: null, loading: false, submitting: false, stale: false, error: null });
}

const targetOptions = computed<SelectOption<FrontProxyId | null>[]>(() =>
  fronts.value.filter((f) => !f.retired && f.id !== rep.source?.id).map((f) => ({ value: f.id, label: f.surgeName, description: FRONT_STATE_LABELS[f.state].label })),
);
const dependents = computed(() => (rep.source?.dependentEnvironmentIds ?? []).map((id) => store.environmentsById.value.get(id)).filter((e) => e !== undefined));

function toggleEnv(id: string) {
  rep.envIds = rep.envIds.includes(id) ? rep.envIds.filter((x) => x !== id) : [...rep.envIds, id];
  rep.preview = null;
}

function setTarget(id: FrontProxyId | null) {
  rep.target = id;
  rep.preview = null;
}

async function runReplacePreview() {
  if (!rep.source || !rep.target || rep.envIds.length === 0) return;
  rep.loading = true;
  rep.error = null;
  rep.stale = false;
  try {
    rep.preview = await api.replaceFrontPreview(rep.source.id, { to_front_id: rep.target, environment_ids: [...rep.envIds] });
  } catch (e) {
    rep.error = e instanceof Error ? e.message : '预览失败';
  } finally {
    rep.loading = false;
  }
}

async function commitReplace() {
  const p = rep.preview;
  if (!rep.source || !rep.target || !p) return;
  rep.submitting = true;
  rep.error = null;
  try {
    const envIds = p.items.map((i) => i.environment_id);
    const acc = await api.replaceFrontCommit(rep.source.id, {
      request_id: newRequestId(),
      to_front_id: rep.target,
      environment_ids: envIds,
      preview_digest: p.preview_digest,
      expected_revisions: Object.fromEntries(p.items.map((i) => [i.environment_id, i.revision])),
    });
    rep.show = false;
    accepted(acc, '已受理：正在为所选环境更换前置并发布；使用中的环境走受控切换');
  } catch (e) {
    if (isApiError(e) && e.code === 'PREVIEW_STALE') {
      rep.stale = true;
      rep.preview = null;
    } else {
      rep.error = e instanceof Error ? e.message : '提交失败';
    }
  } finally {
    rep.submitting = false;
  }
}
</script>

<template>
  <div class="card" data-test="front-proxies">
    <div class="card-header flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold text-gray-900 dark:text-white">前置代理</h3>
        <p class="text-xs text-gray-500 dark:text-dark-400">已登记 {{ formatCount(fronts.filter((f) => !f.retired).length) }}；只允许你已有的固定节点</p>
      </div>
      <button type="button" class="btn btn-secondary" @click="openRegister"><Icon name="plus" />登记前置</button>
    </div>
    <div class="card-body">
      <DataTable :columns="columns" :rows="fronts" :row-key="(f) => f.id" flat caption="前置代理">
        <template #cell-name="{ row }">
          <span class="flex items-center gap-2">
            <span class="code">{{ row.surgeName }}</span>
            <Badge v-if="row.isDefault" variant="primary">默认</Badge>
            <Badge v-if="row.retired" variant="gray">已停用</Badge>
          </span>
        </template>
        <template #cell-state="{ row }"><Badge :variant="FRONT_STATE_LABELS[row.state].variant">{{ FRONT_STATE_LABELS[row.state].label }}</Badge></template>
        <template #cell-deps="{ row }">{{ formatCount(row.dependentEnvironmentIds.length) }}</template>
        <template #cell-checked="{ row }">{{ row.lastCheckedAt ? formatRelative(row.lastCheckedAt, store.state.now) : '未核验' }}</template>
        <template #cell-actions="{ row }">
          <DropdownMenu :items="menuItems(row)" :label="`前置 ${row.surgeName} 的操作`" @select="(k) => onMenu(row, k)" />
        </template>
        <template #empty>
          <p class="px-6 py-8 text-center text-sm text-gray-500 dark:text-dark-400">还没有登记前置代理。所有环境都必须经前置连接，先登记一个你已有的固定节点。</p>
        </template>
      </DataTable>
    </div>

    <BaseDialog :show="reg.show" title="登记前置代理" @close="reg.show = false">
      <div class="space-y-4 text-sm">
        <p class="text-gray-500 dark:text-dark-400">从 Surge 当前配置中选择你已有的代理节点。组、DIRECT/REJECT 等内置策略和 SFE- 节点不能作为前置。</p>
        <div v-if="reg.loading" class="flex items-center gap-2 text-gray-500 dark:text-dark-400"><Spinner />正在读取 Surge 节点</div>
        <template v-else-if="reg.candidates">
          <SelectField v-model="reg.choice" label="Surge 节点" :options="candidateOptions" placeholder="选择节点" :hint="candidateOptions.length ? null : '没有可登记的节点'" />
          <label class="flex items-center gap-3">
            <input v-model="reg.makeDefault" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-600 dark:bg-dark-800" />
            <span class="text-gray-900 dark:text-white">设为默认前置</span>
          </label>
          <p v-if="reg.candidates.groups.length" class="text-xs text-gray-500 dark:text-dark-400">以下是组，不能作为前置：{{ reg.candidates.groups.join('、') }}</p>
        </template>
        <NoticeBox v-if="reg.error" tone="danger">{{ reg.error }}</NoticeBox>
      </div>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="reg.submitting" @click="reg.show = false">取消</button>
        <button type="button" class="btn btn-primary" :disabled="!reg.choice || reg.submitting" @click="submitRegister">
          <Spinner v-if="reg.submitting" color="white" decorative />登记
        </button>
      </template>
    </BaseDialog>

    <ConfirmDialog
      :show="retire.show"
      title="停用前置"
      :message="`确定要停用前置 ${retire.front?.surgeName ?? ''} 吗？`"
      confirm-text="停用"
      variant="danger"
      :loading="retire.submitting"
      @confirm="confirmRetire"
      @cancel="retire.show = false"
    >
      <p>停用后不能再被新环境选择；Surge 中的节点本身不受影响。</p>
    </ConfirmDialog>

    <BaseDialog :show="rep.show" :title="`更换前置：${rep.source?.surgeName ?? ''}`" width="wide" @close="rep.show = false">
      <div class="space-y-5 text-sm" data-test="replace-front">
        <fieldset>
          <legend class="mb-2 font-medium text-gray-900 dark:text-white">依赖此前置的环境</legend>
          <ul class="space-y-2">
            <li v-for="e in dependents" :key="e!.id">
              <label class="flex items-center gap-3">
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-600 dark:bg-dark-800"
                  :checked="rep.envIds.includes(e!.id)"
                  @change="toggleEnv(e!.id)"
                />
                <span class="text-gray-900 dark:text-gray-100">{{ envLabel(e!) }}</span>
                <Badge v-if="store.route.value?.activeEnvironmentId === e!.id" variant="success">使用中</Badge>
              </label>
            </li>
          </ul>
        </fieldset>
        <SelectField :model-value="rep.target" label="更换为" :options="targetOptions" placeholder="选择新的前置" @update:model-value="setTarget" />
        <NoticeBox v-if="rep.stale" tone="warning" title="预览已过期">依赖环境在预览后发生了变化，提交已被拒绝。请重新预览后再提交。</NoticeBox>
        <NoticeBox v-if="rep.error" tone="danger">{{ rep.error }}</NoticeBox>
        <div v-if="rep.preview" class="space-y-2">
          <h4 class="font-semibold text-gray-900 dark:text-white">预览</h4>
          <ul class="divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-dark-700 dark:border-dark-700">
            <li v-for="item in rep.preview.items" :key="item.environment_id" class="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <span>{{ item.label }} · <span class="font-mono">v{{ item.revision }}</span></span>
              <span class="flex items-center gap-2 text-gray-500 dark:text-dark-400">
                {{ item.currentFrontName }} → {{ fronts.find((f) => f.id === rep.target)?.surgeName ?? '—' }}
                <Badge v-if="item.isActive" variant="warning">使用中：将走受控切换</Badge>
              </span>
            </li>
          </ul>
          <p class="text-xs text-gray-500 dark:text-dark-400">每个环境会生成新版本并一次发布（受发布门槛约束）；冲突的环境单独报告，不影响其他环境。</p>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="rep.submitting" @click="rep.show = false">取消</button>
        <button v-if="!rep.preview" type="button" class="btn btn-primary" :disabled="!rep.target || rep.envIds.length === 0 || rep.loading" @click="runReplacePreview">
          <Spinner v-if="rep.loading" color="white" decorative />{{ rep.stale ? '重新预览' : '预览' }}
        </button>
        <button v-else type="button" class="btn btn-primary" :disabled="rep.submitting" @click="commitReplace">
          <Spinner v-if="rep.submitting" color="white" decorative />提交
        </button>
      </template>
    </BaseDialog>
  </div>
</template>
