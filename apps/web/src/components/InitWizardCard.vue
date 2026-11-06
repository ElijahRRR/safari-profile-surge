<script setup lang="ts">
// 一次性初始化固定工作配置：只读预览（备份、引用文件、受管理差异、检查、冲突、目录风险、托管头、
// 自动重载、接管）→ 带 preview_digest 提交 → 由你在 Surge 中手动切换到「日常-Safari环境」一次。
// 本应用之后从不切换配置。202 只代表已受理：进行中即说明成功后要手动切换一次；失败时显示原因并恢复预览与提交。
// 成功后服务端紧接着发出 settings.updated，发布页随即卸载本卡片，手动切换提示由「固定工作配置」卡片持续给出。
import { computed, ref, watch } from 'vue';
import { WORKING_PROFILE_NAME, type InitPreviewResponse, type OperationStatus } from '@sfe/contract';
import { ConfirmDialog, Icon, Spinner, TextField } from '@sfe/easyquick';
import MaintenancePreview from './MaintenancePreview.vue';
import NoticeBox from './NoticeBox.vue';
import { useConsole } from '../store/context';
import { isApiError } from '../api/client';
import { OPERATION_STATUS_LABELS } from '../lib/labels';
import { newRequestId } from '../lib/request-id';

const { api, store, toasts, viewer, accepted } = useConsole();

const targetDirectory = ref('');
const preview = ref<InitPreviewResponse | null>(null);
const loading = ref(false);
const committing = ref(false);
const stale = ref(false);
/** 已受理的初始化操作；结果以操作状态为准。 */
const opId = ref<string | null>(null);
const op = computed(() => store.operationById(opId.value));
const done = computed(() => op.value?.status === 'succeeded');
const failure = ref<{ message: string; operationId: string } | null>(null);

const IN_PROGRESS: ReadonlySet<OperationStatus> = new Set(['queued', 'running', 'waiting']);

// 操作没有成功结束（失败、需要处理等）：显示原因，恢复目录、预览与提交，让你处理后重新预览。
watch(
  () => op.value?.status,
  (status) => {
    const o = op.value;
    if (!o || !status || status === 'succeeded' || IN_PROGRESS.has(status)) return;
    failure.value = { message: o.error?.message ?? `初始化没有完成（${OPERATION_STATUS_LABELS[status].label}）`, operationId: o.id };
    opId.value = null;
  },
);

const failedChecks = computed(() => (preview.value?.checks ?? []).filter((c) => !c.ok));
const blockedReason = computed(() => {
  const p = preview.value;
  if (!p) return null;
  if (failedChecks.value.length) return `有 ${failedChecks.value.length} 项检查未通过`;
  if (p.nameCollisions.length) return '存在名称或文件冲突';
  if (p.profileDirectoryRisk !== 'none') return '配置目录位于同步或受保护位置';
  return null;
});

async function runPreview() {
  loading.value = true;
  stale.value = false;
  try {
    preview.value = await api.initPreview({ targetDirectory: targetDirectory.value.trim() === '' ? null : targetDirectory.value.trim() });
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '预览失败');
  } finally {
    loading.value = false;
  }
}

async function commit() {
  const p = preview.value;
  if (!p || blockedReason.value) return;
  committing.value = true;
  try {
    const acc = await api.initCommit({ request_id: newRequestId(), preview_digest: p.preview_digest });
    accepted(acc, '已受理：正在创建工作配置');
    failure.value = null;
    preview.value = null;
    opId.value = acc.operation_id;
    // 事件流断开时也拿到一次当前状态（较旧的结果不会覆盖事件带来的新状态）。
    api.getOperation(acc.operation_id).then(
      (view) => store.upsertOperation(view),
      () => {
        // 读取失败时等事件流；「查看进度」会继续读取。
      },
    );
  } catch (e) {
    if (isApiError(e) && e.code === 'PREVIEW_STALE') stale.value = true;
    else toasts.error(e instanceof Error ? e.message : '初始化失败');
  } finally {
    committing.value = false;
  }
}

async function rerun() {
  stale.value = false;
  preview.value = null;
  await runPreview();
}
</script>

<template>
  <div class="card" data-test="init-wizard">
    <div class="card-header">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">初始化固定工作配置</h3>
      <p class="text-xs text-gray-500 dark:text-dark-400">一次性：以当前配置为基础建立「{{ WORKING_PROFILE_NAME }}」，之后日常不再切换配置</p>
    </div>
    <div class="card-body space-y-5">
      <NoticeBox v-if="done" tone="success" title="下一步：在 Surge 中手动切换一次" data-test="init-done">
        工作配置已创建，请在 Surge 中把当前配置切换到「{{ WORKING_PROFILE_NAME }}」。只需要这一次；之后本应用从不切换配置，也不会替你切换。
      </NoticeBox>
      <NoticeBox v-else-if="opId" tone="info" title="正在创建工作配置" data-test="init-running">
        <p>已受理：正在备份当前配置并创建「{{ WORKING_PROFILE_NAME }}」。</p>
        <p>成功后请在 Surge 中手动切换到「{{ WORKING_PROFILE_NAME }}」一次（「固定工作配置」中会一直提示，直到确认已切换）；失败时这里会显示原因，可重新预览后再提交。</p>
        <div class="mt-2">
          <button type="button" class="btn btn-secondary btn-sm" @click="viewer.open(opId)">查看进度</button>
        </div>
      </NoticeBox>
      <template v-else>
        <NoticeBox v-if="failure" tone="danger" title="初始化失败" data-test="init-failed">
          <p>{{ failure.message }}</p>
          <p>处理后重新预览再提交。</p>
          <div class="mt-2">
            <button type="button" class="btn btn-secondary btn-sm" @click="viewer.open(failure.operationId)">查看操作</button>
          </div>
        </NoticeBox>
        <TextField v-model="targetDirectory" label="工作配置目录" mono placeholder="留空使用当前活动配置所在目录" hint="工作配置必须与源配置同目录，才能保留相对引用。" />
        <MaintenancePreview v-if="preview" :preview="preview" />
        <NoticeBox v-if="blockedReason" tone="danger">不能初始化：{{ blockedReason }}。处理后重新预览。</NoticeBox>
      </template>
    </div>
    <div v-if="!opId" class="card-footer flex justify-end gap-3">
      <button type="button" class="btn btn-secondary" :disabled="loading" @click="runPreview">
        <Spinner v-if="loading" decorative /><Icon v-else name="eye" />{{ preview ? '重新预览' : '生成预览' }}
      </button>
      <button type="button" class="btn btn-primary" :disabled="!preview || blockedReason !== null || committing" data-test="init-commit" @click="commit">
        <Spinner v-if="committing" color="white" decorative />初始化
      </button>
    </div>
    <ConfirmDialog :show="stale" title="预览已过期" message="确定要重新预览吗？" confirm-text="重新预览" @confirm="rerun" @cancel="stale = false">
      <p>源配置、引用文件或目标路径在预览后发生了变化，提交已被拒绝，没有写入任何文件。</p>
    </ConfirmDialog>
  </div>
</template>
