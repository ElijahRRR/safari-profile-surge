<script setup lang="ts">
// 重新合并受管理段：恢复被改动的受管理段或本应用文件、接入新结构。写入工作配置受维护写门槛约束且
// 入口必须是普通模式；门槛不满足时提交按钮禁用并列出原因，不提供绕过。被修改的内容从不被采纳为基线。
import { computed, ref } from 'vue';
import type { RemergePreviewResponse } from '@sfe/contract';
import { ConfirmDialog, Icon, Spinner } from '@sfe/easyquick';
import MaintenancePreview from './MaintenancePreview.vue';
import MissingCapabilities from './MissingCapabilities.vue';
import NoticeBox from './NoticeBox.vue';
import { useConsole } from '../store/context';
import { isApiError } from '../api/client';
import { evaluateGate } from '../lib/gates';
import { newRequestId } from '../lib/request-id';

const { api, store, toasts, accepted } = useConsole();

const preview = ref<RemergePreviewResponse | null>(null);
const loading = ref(false);
const committing = ref(false);
const stale = ref(false);

const gate = computed(() => evaluateGate(store.capabilities.value, 'maintenanceWrite'));
const entryNormal = computed(() => store.route.value?.entryMode === 'NORMAL');
const writesProfile = computed(() => !!preview.value && (preview.value.managedDiff.trim() !== '' || preview.value.requiresReload));
const blockedReason = computed(() => {
  if (!preview.value) return null;
  if ((preview.value.checks ?? []).some((c) => !c.ok)) return '有检查未通过';
  if (preview.value.nameCollisions.length) return '存在名称或文件冲突';
  if (!writesProfile.value) return null;
  if (!entryNormal.value) return '写入工作配置时入口必须是普通模式，请先进入普通模式';
  if (!gate.value.met) return '维护写入所需能力尚未通过实测';
  return null;
});

async function runPreview() {
  loading.value = true;
  stale.value = false;
  try {
    preview.value = await api.remergePreview();
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
    accepted(await api.remergeCommit({ request_id: newRequestId(), preview_digest: p.preview_digest }), '已受理：正在重新合并，结果以读回为准');
    preview.value = null;
  } catch (e) {
    if (isApiError(e) && e.code === 'PREVIEW_STALE') stale.value = true;
    else toasts.error(e instanceof Error ? e.message : '重新合并失败');
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
  <div class="card" data-test="remerge">
    <div class="card-header">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">重新合并受管理段</h3>
      <p class="text-xs text-gray-500 dark:text-dark-400">用于恢复被改动的受管理段与本应用文件，或接入新的入口结构；不覆盖你在受管理段之外的修改</p>
    </div>
    <div class="card-body space-y-5">
      <template v-if="preview">
        <MaintenancePreview :preview="preview" />
        <NoticeBox v-if="preview.requiresReload" tone="warning" title="需要重载同一配置">
          写入后需要重载工作配置才能生效。{{ preview.measuredReloadImpact ? `P0 测得的影响：${preview.measuredReloadImpact}` : '重载影响尚未测量。' }}请选择对其他应用影响最小的时间提交。
        </NoticeBox>
        <NoticeBox v-if="blockedReason" tone="danger">不能提交：{{ blockedReason }}。</NoticeBox>
        <MissingCapabilities v-if="writesProfile && !gate.met" :missing="gate.missing" />
      </template>
      <p v-else class="text-sm text-gray-500 dark:text-dark-400">生成预览只读取文件与 Surge 状态，不写入任何内容。</p>
    </div>
    <div class="card-footer flex justify-end gap-3">
      <button type="button" class="btn btn-secondary" :disabled="loading" @click="runPreview">
        <Spinner v-if="loading" decorative /><Icon v-else name="eye" />{{ preview ? '重新预览' : '生成预览' }}
      </button>
      <button type="button" class="btn btn-primary" :disabled="!preview || blockedReason !== null || committing" @click="commit">
        <Spinner v-if="committing" color="white" decorative />重新合并
      </button>
    </div>
    <ConfirmDialog :show="stale" title="预览已过期" message="确定要重新预览吗？" confirm-text="重新预览" @confirm="rerun" @cancel="stale = false">
      <p>工作配置或本应用文件在预览后发生了变化，提交已被拒绝，没有写入任何文件。</p>
    </ConfirmDialog>
  </div>
</template>
