<script setup lang="ts">
// 环境列表：筛选、DataTable、编辑弹窗、打开环境（受控入口）、检测、解除绑定与删除确认。
// 202 只代表已保存并创建任务；表格中的状态始终以服务端推导的汇总状态为准。
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { readinessAllowsActivation, type AccountDetail, type EnvironmentView, type FieldError } from '@sfe/contract';
import {
  Badge,
  ConfirmDialog,
  DataTable,
  DropdownMenu,
  EmptyState,
  Icon,
  PageHeader,
  Pagination,
  SearchInput,
  StatusBadge,
  Tabs,
  type MenuItem,
  type TableColumn,
} from '@sfe/easyquick';
import EnvironmentEditDialog from '../components/EnvironmentEditDialog.vue';
import NoticeBox from '../components/NoticeBox.vue';
import { useConsole } from '../store/context';
import { isApiError } from '../api/client';
import { newRequestId } from '../lib/request-id';
import { BINDING_LABELS, PROBE_OUTCOME_LABELS, READINESS_LABELS } from '../lib/labels';
import { envLabel, isEnvironmentInUse, matchesFilter, matchesSearch, probeDisplay, proxyAddress, siteLabel, type EnvironmentFilter } from '../lib/environments';
import { formatCount, formatDateTime, formatRevision } from '../lib/format';
import type { EnvironmentSubmit } from '../lib/environment-form';

const { api, store, toasts, routeActions, accepted } = useConsole();
const router = useRouter();

const search = ref('');
const filter = ref<EnvironmentFilter>('all');
const page = ref(1);
const pageSize = ref(20);

const all = computed(() => store.environments.value);
const filterOptions = computed(() => [
  { value: 'all' as const, label: '全部' },
  { value: 'using' as const, label: '使用中', count: all.value.filter((e) => matchesFilter(e, 'using')).length },
  { value: 'pending' as const, label: '待部署', count: all.value.filter((e) => matchesFilter(e, 'pending')).length },
  { value: 'unbound' as const, label: '待关联', count: all.value.filter((e) => matchesFilter(e, 'unbound')).length },
  { value: 'attention' as const, label: '需要处理', count: all.value.filter((e) => matchesFilter(e, 'attention')).length },
]);
const filtered = computed(() => all.value.filter((e) => matchesFilter(e, filter.value) && matchesSearch(e, search.value)));
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch([search, filter, pageSize], () => {
  page.value = 1;
});

const description = computed(() => {
  if (!store.state.snapshot) return '正在读取环境';
  const s = store.stats.value;
  return `共 ${formatCount(s.total)}环境，${formatCount(s.using)}使用中，${formatCount(s.pending)}待部署`;
});

const columns: TableColumn[] = [
  { key: 'env', label: '环境' },
  { key: 'binding', label: '绑定场景' },
  { key: 'site', label: '站点' },
  { key: 'proxy', label: '代理连接地址' },
  { key: 'front', label: '前置' },
  { key: 'revisions', label: '版本（期望/已部署/活动）' },
  { key: 'exit', label: '实际出口' },
  { key: 'status', label: '状态' },
  { key: 'actions', label: '操作' },
];

// ---------- 编辑 ----------
const editor = reactive({
  show: false,
  mode: 'create' as 'create' | 'edit',
  env: null as EnvironmentView | null,
  account: null as AccountDetail | null,
  requestId: '',
  submitting: false,
  fieldErrors: [] as FieldError[],
  formError: null as string | null,
});

function openCreate() {
  Object.assign(editor, { show: true, mode: 'create', env: null, account: null, requestId: newRequestId(), submitting: false, fieldErrors: [], formError: null });
}

async function openEdit(env: EnvironmentView) {
  let account: AccountDetail | null = null;
  if (env.account.hasLoginIdentifier) {
    try {
      account = await api.accountDetail(env.id);
    } catch (e) {
      toasts.warning(e instanceof Error ? `读取登录账号失败：${e.message}` : '读取登录账号失败');
    }
  }
  Object.assign(editor, { show: true, mode: 'edit', env, account, requestId: newRequestId(), submitting: false, fieldErrors: [], formError: null });
}

function closeEditor() {
  if (editor.submitting) return;
  editor.show = false;
  editor.account = null;
}

async function onSubmit(payload: EnvironmentSubmit) {
  editor.submitting = true;
  editor.fieldErrors = [];
  editor.formError = null;
  try {
    const acc = payload.kind === 'create' ? await api.createEnvironment(payload.request) : await api.updateEnvironment(payload.environmentId, payload.request);
    editor.submitting = false;
    editor.show = false;
    editor.account = null;
    accepted(acc, payload.kind === 'create' ? '环境已保存，正在处理；结果见状态列' : '修改已保存，正在处理；结果见状态列');
  } catch (e) {
    editor.submitting = false;
    if (!isApiError(e)) {
      editor.formError = '保存失败：未知错误';
      return;
    }
    editor.fieldErrors = e.fieldErrors ?? [];
    if (e.code === 'REVISION_CONFLICT') {
      const current = typeof e.details?.currentRevision === 'number' ? `（当前版本 ${e.details.currentRevision}）` : '';
      editor.formError = `保存失败：环境已在其他界面被修改${current}。请关闭后重新打开再修改，你的输入不会自动覆盖对方的修改。`;
    } else if (!e.fieldErrors?.length) {
      editor.formError = e.message;
    }
  }
}

// ---------- 确认弹窗：删除、解除绑定、核对账号、正在使用 ----------
type ConfirmKind = 'delete' | 'unbind' | 'ack_account' | 'in_use';
const confirm = reactive({ show: false, kind: 'delete' as ConfirmKind, env: null as EnvironmentView | null, submitting: false, requestId: '', action: '' });

const confirmText = computed(() => {
  const label = confirm.env ? envLabel(confirm.env) : '';
  switch (confirm.kind) {
    case 'delete':
      return {
        title: '删除环境',
        message: `确定要删除环境 ${label} 吗？`,
        detail: '删除后其节点在下次发布时移除，账号密码从钥匙串删除；Safari 场景、Cookie 与登录资料保留。',
        button: '删除',
        variant: 'danger' as const,
      };
    case 'unbind':
      return {
        title: '解除绑定',
        message: `确定要解除 ${label} 与 Safari 场景的绑定吗？`,
        detail: '只删除对应关系，不删除 Safari 场景、Cookie 或登录资料。之后可以在扩展中重新关联。',
        button: '解除绑定',
        variant: 'danger' as const,
      };
    case 'ack_account':
      return {
        title: '确认网页登录状态',
        message: '确定已核对网页中登录的买家账号吗？',
        detail: '配置账号已更换，但网页登录身份不会自动改变。确认后清除提示。',
        button: '确认',
        variant: 'primary' as const,
      };
    case 'in_use':
      return {
        title: '环境正在使用',
        message: `${label} 正在使用或正在验证，不能${confirm.action}。`,
        detail: '请先进入普通模式，等 Safari 恢复原规则后再操作。进入普通模式会先请你确认旧环境窗口如何处理。',
        button: '进入普通模式',
        variant: 'primary' as const,
      };
  }
});

function askConfirm(kind: Exclude<ConfirmKind, 'in_use'>, env: EnvironmentView) {
  if ((kind === 'delete' || kind === 'unbind') && isEnvironmentInUse(env, store.route.value)) {
    Object.assign(confirm, { show: true, kind: 'in_use', env, submitting: false, action: kind === 'delete' ? '删除' : '解除绑定' });
    return;
  }
  Object.assign(confirm, { show: true, kind, env, submitting: false, requestId: newRequestId(), action: '' });
}

async function onConfirm() {
  const env = confirm.env;
  if (!env) return;
  if (confirm.kind === 'in_use') {
    confirm.show = false;
    void routeActions.start({ kind: 'normal' });
    return;
  }
  confirm.submitting = true;
  const req = { request_id: confirm.requestId, expected_revision: env.revision };
  try {
    if (confirm.kind === 'delete') accepted(await api.deleteEnvironment(env.id, req), '已受理：正在删除环境');
    else if (confirm.kind === 'unbind') accepted(await api.unbind(env.id, req), '已受理：正在解除绑定');
    else accepted(await api.acknowledgeAccount(env.id, req), '已记录：网页登录状态已核对');
    confirm.show = false;
  } catch (e) {
    if (isApiError(e) && e.code === 'ENVIRONMENT_ACTIVE') {
      Object.assign(confirm, { kind: 'in_use', action: confirm.kind === 'delete' ? '删除' : '解除绑定' });
    } else {
      toasts.error(e instanceof Error ? e.message : '操作失败');
      confirm.show = false;
    }
  } finally {
    confirm.submitting = false;
  }
}

// ---------- 行内操作 ----------
function openEnvironment(env: EnvironmentView, proxyRevision?: number) {
  void routeActions.start({
    kind: 'activate',
    environmentId: env.id,
    label: envLabel(env),
    displayName: env.displayName,
    ...(proxyRevision !== undefined ? { proxyRevision } : {}),
  });
}

async function probe(env: EnvironmentView) {
  const isActive = store.route.value?.activeEnvironmentId === env.id;
  try {
    const acc = await api.probe(env.id, { request_id: newRequestId(), kind: isActive ? 'safari' : 'preflight' });
    accepted(acc, isActive ? '已受理：等待在 Safari 场景中完成检测' : '已受理：正在预检代理（只证明代理可用，不代表 Safari 出口）', isActive ? env.displayName : null);
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '检测失败');
  }
}

function moreItems(env: EnvironmentView): MenuItem[] {
  const items: MenuItem[] = [];
  const lv = env.proxy.lastVerified;
  const dep = env.proxy.deployed;
  if (lv && dep && lv.revision !== dep.revision) items.push({ key: 'last_verified', label: `使用已验证版本 ${formatRevision(lv.revision)}` });
  if (env.account.changedSincePageCheck) items.push({ key: 'ack_account', label: '确认网页登录状态' });
  if (env.binding.state !== 'unbound') items.push({ key: 'unbind', label: '解除绑定', danger: true });
  items.push({ key: 'delete', label: '删除', danger: true });
  return items;
}

function onMore(env: EnvironmentView, key: string) {
  if (key === 'last_verified' && env.proxy.lastVerified) openEnvironment(env, env.proxy.lastVerified.revision);
  else if (key === 'ack_account') askConfirm('ack_account', env);
  else if (key === 'unbind') askConfirm('unbind', env);
  else if (key === 'delete') askConfirm('delete', env);
}

function activationBlocked(env: EnvironmentView): string | null {
  if (readinessAllowsActivation(env.readiness)) return null;
  return env.nextActions[0]?.message ?? READINESS_LABELS[env.readiness].label;
}
</script>

<template>
  <div>
    <PageHeader title="环境" :description="description">
      <template #actions>
        <button type="button" class="btn btn-secondary" @click="router.push('/import')"><Icon name="upload" />导入</button>
        <button type="button" class="btn btn-primary" data-test="create-env" @click="openCreate"><Icon name="plus" />新建环境</button>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap items-center gap-3">
      <SearchInput v-model="search" label="搜索环境" placeholder="搜索名称、编号、地址…" />
      <Tabs v-model="filter" :options="filterOptions" label="环境筛选" />
    </div>

    <DataTable :columns="columns" :rows="paged" :row-key="(e) => e.id" :loading="!store.state.snapshot" caption="环境列表" data-test="env-table">
      <template #cell-env="{ row }">
        <div class="flex flex-col">
          <span class="font-medium text-gray-900 dark:text-white">{{ row.displayName }}</span>
          <span class="mt-0.5"><span class="code">{{ row.code }}</span></span>
        </div>
      </template>
      <template #cell-binding="{ row }">
        <div class="flex flex-col gap-1">
          <Badge :variant="BINDING_LABELS[row.binding.state].variant">{{ BINDING_LABELS[row.binding.state].label }}</Badge>
          <span v-if="row.binding.profileIdShort" class="font-mono text-xs text-gray-500 dark:text-dark-400">{{ row.binding.profileIdShort }}</span>
          <span v-if="row.binding.sitePermissionGranted === false" class="text-xs text-amber-700 dark:text-amber-400">未授权站点访问</span>
        </div>
      </template>
      <template #cell-site="{ row }">{{ siteLabel(row) }}</template>
      <template #cell-proxy="{ row }">
        <div class="flex flex-col font-mono text-xs">
          <span>{{ proxyAddress(row.proxy.desired ?? row.proxy.deployed) }}</span>
          <span v-if="row.proxy.active && row.proxy.desired && row.proxy.active.revision !== row.proxy.desired.revision" class="text-gray-500 dark:text-dark-400">
            使用中：{{ proxyAddress(row.proxy.active) }}
          </span>
        </div>
      </template>
      <template #cell-front="{ row }">{{ (row.proxy.desired ?? row.proxy.deployed)?.frontProxyName ?? '—' }}</template>
      <template #cell-revisions="{ row }">
        <span class="font-mono text-xs">
          {{ formatRevision(row.proxy.desired?.revision) }} / {{ formatRevision(row.proxy.deployed?.revision) }} / {{ formatRevision(row.proxy.active?.revision) }}
        </span>
      </template>
      <template #cell-exit="{ row }">
        <template v-if="probeDisplay(row.probes.safari, store.state.now)">
          <div class="flex flex-col text-xs" :title="formatDateTime(row.probes.safari!.observedAt)">
            <span class="flex items-center gap-1.5">
              <span v-if="probeDisplay(row.probes.safari, store.state.now)!.expired" class="text-gray-500 dark:text-dark-400">上次结果</span>
              <span class="font-mono text-sm">{{ row.probes.safari!.exitIp ?? '—' }}</span>
              <Badge v-if="row.probes.safari!.outcome !== 'ok'" :variant="PROBE_OUTCOME_LABELS[row.probes.safari!.outcome].variant">{{ PROBE_OUTCOME_LABELS[row.probes.safari!.outcome].label }}</Badge>
            </span>
            <span class="text-gray-500 dark:text-dark-400">{{ probeDisplay(row.probes.safari, store.state.now)!.when }}</span>
          </div>
        </template>
        <span v-else class="text-gray-500 dark:text-dark-400">未检测</span>
      </template>
      <template #cell-status="{ row }">
        <div class="flex flex-col gap-1">
          <Badge :variant="READINESS_LABELS[row.readiness].variant" :data-readiness="row.readiness">{{ READINESS_LABELS[row.readiness].label }}</Badge>
          <span v-if="row.nextActions[0]" class="max-w-[14rem] truncate text-xs text-gray-500 dark:text-dark-400" :title="row.nextActions[0].message">{{ row.nextActions[0].message }}</span>
          <span v-if="row.lastError" class="max-w-[14rem] truncate text-xs text-red-600 dark:text-red-400" :title="row.lastError.message">{{ row.lastError.message }}</span>
        </div>
      </template>
      <template #cell-actions="{ row }">
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :aria-label="`打开环境 ${envLabel(row)}`"
            :title="activationBlocked(row) ?? '打开环境'"
            :disabled="activationBlocked(row) !== null"
            data-test="open-env"
            @click="openEnvironment(row)"
          >
            <Icon name="play" size="sm" />
          </button>
          <button type="button" class="btn btn-ghost btn-sm" :aria-label="`编辑 ${envLabel(row)}`" title="编辑" data-test="edit-env" @click="openEdit(row)">
            <Icon name="edit" size="sm" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :aria-label="`检测 ${envLabel(row)}`"
            title="检测"
            :disabled="!row.proxy.deployed"
            @click="probe(row)"
          >
            <Icon name="beaker" size="sm" />
          </button>
          <DropdownMenu :items="moreItems(row)" :label="`更多操作：${envLabel(row)}`" @select="(k) => onMore(row, k)" />
        </div>
      </template>
      <template #empty>
        <EmptyState
          v-if="all.length === 0"
          title="还没有环境"
          description="导入表格批量建立环境，或手动新建第一个环境。"
          action-text="新建环境"
          @action="openCreate"
        />
        <EmptyState v-else icon="filter" title="没有符合条件的环境" description="换个关键词或筛选条件再试。" />
      </template>
      <template #footer>
        <Pagination v-if="filtered.length > pageSize" v-model:page="page" v-model:page-size="pageSize" :total="filtered.length" />
      </template>
    </DataTable>

    <EnvironmentEditDialog
      :show="editor.show"
      :mode="editor.mode"
      :environment="editor.env"
      :account="editor.account"
      :front-proxies="store.frontProxies.value"
      :default-front-proxy-id="store.settings.value?.defaultFrontProxyId ?? null"
      :request-id="editor.requestId"
      :submitting="editor.submitting"
      :server-errors="editor.fieldErrors"
      :form-error="editor.formError"
      @submit="onSubmit"
      @close="closeEditor"
    />

    <ConfirmDialog
      :show="confirm.show"
      :title="confirmText.title"
      :message="confirmText.message"
      :confirm-text="confirmText.button"
      :variant="confirmText.variant"
      :loading="confirm.submitting"
      @confirm="onConfirm"
      @cancel="confirm.show = false"
    >
      <NoticeBox v-if="confirm.kind === 'in_use'" tone="warning">{{ confirmText.detail }}</NoticeBox>
      <p v-else>{{ confirmText.detail }}</p>
    </ConfirmDialog>
  </div>
</template>
