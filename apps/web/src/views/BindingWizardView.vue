<script setup lang="ts">
// 场景关联向导：环境记录不等于 Safari 场景。每个待关联环境逐步完成：在 Safari 设置中创建同名场景、
// 在该场景启用扩展、允许访问 www.amazon.com、打开扩展弹窗选择该环境。前三步是用户确认的进度
// （bindingStage），最后一步由扩展经原生桥完成绑定。新场景默认关闭扩展（Apple：“By default, extensions are
// turned off for each new profile.”），不能替用户自动启用；网站授权自 Safari 17 起对所有场景共用（“across all
// profiles, private browsing, and browsing without a profile”），只需授权一次。默认场景可能没有场景 ID，只用已命名场景。
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { SITES, type EnvironmentView } from '@sfe/contract';
import { Badge, DataTable, EmptyState, Icon, PageHeader, ProgressBar, type TableColumn } from '@sfe/easyquick';
import NoticeBox from '../components/NoticeBox.vue';
import { useConsole } from '../store/context';
import { newRequestId } from '../lib/request-id';
import { envLabel } from '../lib/environments';
import { formatCount } from '../lib/format';
import type { BindingStage } from '../lib/environment-form';

const { api, store, toasts } = useConsole();
const router = useRouter();

const pending = computed(() => store.unbound.value);
const selectedId = ref<string | null>(null);
watch(
  pending,
  (list) => {
    if (!list.some((e) => e.id === selectedId.value)) selectedId.value = list[0]?.id ?? null;
  },
  { immediate: true },
);
const selected = computed(() => pending.value.find((e) => e.id === selectedId.value) ?? null);

interface Step {
  key: string;
  title: string;
  detail: string;
}

function stepsFor(env: EnvironmentView): Step[] {
  const host = SITES[env.site]?.host ?? 'www.amazon.com';
  return [
    {
      key: 'profile',
      title: `在 Safari 中创建名为「${env.displayName}」的场景`,
      detail:
        'Safari → 设置 →「描述文件」（Profiles），新建一个场景。名称建议与环境名称一致，便于核对；绑定以场景 ID 为准，不按名称匹配。不要使用默认场景：它可能没有场景 ID，无法关联。',
    },
    {
      key: 'extension',
      title: '在该场景中启用「Safari 场景出口」扩展',
      detail: 'Safari → 设置 →「描述文件」→ 选择这个场景 →「扩展」，勾选扩展。新场景的扩展默认关闭，每个场景都要单独启用。',
    },
    {
      key: 'site',
      title: `允许扩展访问 ${host}`,
      detail:
        '在扩展设置中把网站访问设为允许，或首次打开弹窗时按提示授权。Safari 17 起网站授权对所有场景共用，已在其他场景授权过就不必重复。扩展只申请站点与出口检测服务的主机，不申请所有网站。',
    },
    { key: 'associate', title: '打开扩展弹窗并选择此环境', detail: `在该场景的窗口中点击扩展图标，在「关联已有环境」中选择 ${envLabel(env)}。完成后此环境会从本列表移除。` },
  ];
}

/** 已完成的步骤数（0–3）：前三步来自用户确认的 bindingStage；第 4 步由扩展完成绑定。 */
function doneCount(env: EnvironmentView): number {
  switch (env.binding.stage) {
    case 'awaiting_extension':
      return 1;
    case 'awaiting_association':
      return 3;
    default:
      return 0;
  }
}

function stepState(env: EnvironmentView, index: number): 'done' | 'current' | 'upcoming' {
  const done = doneCount(env);
  if (index < done) return 'done';
  // 启用扩展与授权站点属于同一阶段，一起进行。
  if (index === done || (done === 1 && index === 2)) return 'current';
  return 'upcoming';
}

const NEXT_STAGE: Record<number, BindingStage> = { 0: 'awaiting_extension', 1: 'awaiting_association' };
const saving = ref(false);

async function markDone(env: EnvironmentView) {
  const next = NEXT_STAGE[doneCount(env)];
  if (!next) return;
  saving.value = true;
  try {
    await api.updateEnvironment(env.id, { request_id: newRequestId(), expected_revision: env.revision, changes: { bindingStage: next } });
    toasts.success('已记录关联进度');
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '保存进度失败');
  } finally {
    saving.value = false;
  }
}

const columns: TableColumn[] = [
  { key: 'env', label: '环境' },
  { key: 'progress', label: '进度' },
  { key: 'current', label: '当前步骤' },
  { key: 'actions', label: '操作', srOnly: true },
];

const batchUnsupported = computed(() => {
  const caps = store.capabilities.value;
  const status = (k: string) => caps.find((c) => c.key === k)?.effectiveStatus ?? 'unverified';
  return status('profile_batch_create') !== 'supported' || status('open_profile_by_id') !== 'supported';
});
</script>

<template>
  <div>
    <PageHeader title="场景关联" :description="`${formatCount(pending.length)}环境待关联 Safari 场景`" />
    <NoticeBox v-if="batchUnsupported" tone="info" class="mb-6">
      还没有经实测确认的公开方式能批量创建 Safari 场景或按 ID 打开场景，需要在 Safari 设置中逐个创建。进度会逐项保留，之后可以分批完成。
    </NoticeBox>

    <div v-if="store.state.snapshot && pending.length === 0" class="card">
      <EmptyState icon="checkCircle" title="没有待关联的环境" description="新建或导入的环境会出现在这里，按步骤完成 Safari 场景关联。" action-text="新建环境" @action="router.push('/environments')" />
    </div>

    <div v-else class="grid gap-6 xl:grid-cols-5">
      <div class="xl:col-span-3">
        <DataTable :columns="columns" :rows="pending" :row-key="(e) => e.id" :loading="!store.state.snapshot" caption="待关联环境">
          <template #cell-env="{ row }">
            <button type="button" class="text-left" :aria-pressed="row.id === selectedId ? 'true' : 'false'" @click="selectedId = row.id">
              <span class="block font-medium text-gray-900 hover:underline dark:text-white">{{ row.displayName }}</span>
              <span class="code">{{ row.code }}</span>
            </button>
          </template>
          <template #cell-progress="{ row }">
            <div class="w-40"><ProgressBar :value="(doneCount(row) / 4) * 100" label="已完成" :value-text="`${doneCount(row)} / 4 步`" /></div>
          </template>
          <template #cell-current="{ row }">{{ stepsFor(row)[doneCount(row)]?.title ?? '—' }}</template>
          <template #cell-actions="{ row }">
            <button type="button" class="btn btn-ghost btn-sm" :aria-label="`查看步骤：${envLabel(row)}`" @click="selectedId = row.id">
              <Icon name="chevronRight" size="sm" />
            </button>
          </template>
        </DataTable>
      </div>

      <div v-if="selected" class="card xl:col-span-2" data-test="binding-steps">
        <div class="card-header flex items-center justify-between gap-3">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ envLabel(selected) }}</h3>
          <Badge variant="warning">待关联</Badge>
        </div>
        <ol class="card-body space-y-4">
          <li v-for="(step, i) in stepsFor(selected)" :key="step.key" class="flex gap-3" :data-step-state="stepState(selected, i)">
            <span
              class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              :class="
                stepState(selected, i) === 'done'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  : stepState(selected, i) === 'current'
                    ? 'bg-primary-500 text-white'
                    : 'bg-gray-100 text-gray-500 dark:bg-dark-800 dark:text-dark-400'
              "
            >
              <Icon v-if="stepState(selected, i) === 'done'" name="check" size="sm" />
              <template v-else>{{ i + 1 }}</template>
            </span>
            <div class="min-w-0 space-y-1 text-sm">
              <p class="font-medium text-gray-900 dark:text-white">
                {{ step.title }}
                <span class="sr-only">（{{ stepState(selected, i) === 'done' ? '已完成' : stepState(selected, i) === 'current' ? '进行中' : '未开始' }}）</span>
              </p>
              <p class="text-gray-500 dark:text-dark-400">{{ step.detail }}</p>
              <p v-if="i === 3 && stepState(selected, i) === 'current'" class="text-gray-700 dark:text-gray-300">等待扩展完成关联：绑定成功后状态会自动更新。</p>
            </div>
          </li>
        </ol>
        <div v-if="doneCount(selected) < 3" class="card-footer flex justify-end">
          <button type="button" class="btn btn-primary btn-sm" :disabled="saving" data-test="mark-step" @click="markDone(selected)">
            {{ doneCount(selected) === 0 ? '完成此步' : '完成这两步' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
