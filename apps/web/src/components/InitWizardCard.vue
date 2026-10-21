<script setup lang="ts">
// 一次性初始化固定工作配置：只读预览（备份、引用文件、受管理差异、检查、冲突、目录风险、托管头、
// 自动重载、接管）→ 带 preview_digest 提交 → 由你在 Surge 中手动切换到「日常-Safari环境」一次。
// 本应用之后从不切换配置。
import { computed, ref } from 'vue';
import { WORKING_PROFILE_NAME, type InitPreviewResponse } from '@sfe/contract';
import { ConfirmDialog, Icon, Spinner, TextField } from '@sfe/easyquick';
import MaintenancePreview from './MaintenancePreview.vue';
import NoticeBox from './NoticeBox.vue';
import { useConsole } from '../store/context';
import { isApiError } from '../api/client';
import { newRequestId } from '../lib/request-id';

const { api, toasts, accepted } = useConsole();

const targetDirectory = ref('');
const preview = ref<InitPreviewResponse | null>(null);
const loading = ref(false);
const committing = ref(false);
const done = ref(false);
const stale = ref(false);

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
    accepted(await api.initCommit({ request_id: newRequestId(), preview_digest: p.preview_digest }), '已受理：正在创建工作配置');
    done.value = true;
    preview.value = null;
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
        工作配置创建完成后，请在 Surge 中把当前配置切换到「{{ WORKING_PROFILE_NAME }}」。只需要这一次；之后本应用从不切换配置，也不会替你切换。
      </NoticeBox>
      <template v-else>
        <TextField v-model="targetDirectory" label="工作配置目录" mono placeholder="留空使用当前活动配置所在目录" hint="工作配置必须与源配置同目录，才能保留相对引用。" />
        <MaintenancePreview v-if="preview" :preview="preview" />
        <NoticeBox v-if="blockedReason" tone="danger">不能初始化：{{ blockedReason }}。处理后重新预览。</NoticeBox>
      </template>
    </div>
    <div v-if="!done" class="card-footer flex justify-end gap-3">
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
