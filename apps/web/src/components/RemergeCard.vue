<script setup lang="ts">
// 重新合并受管理段：恢复被改动的受管理段或本应用文件、接入新结构。写入工作配置受维护写门槛约束且
// 入口必须是普通模式；门槛不满足时提交按钮禁用并列出原因，不提供绕过。被修改的内容从不被采纳为基线。
// 选项「更换本机资源地址」（D10 rotateResourceUrl）：是清除“读取令牌可能已泄露”的唯一方式。选项属于预览——改变选项后
// 原预览作废、需要重新预览；提交带上生成该预览时的选项，并先经确认对话框。页面从不显示地址、端口或令牌。
import { computed, ref, watch } from 'vue';
import type { RemergePreviewResponse } from '@sfe/contract';
import { ConfirmDialog, Icon, Spinner } from '@sfe/easyquick';
import MaintenancePreview from './MaintenancePreview.vue';
import MissingCapabilities from './MissingCapabilities.vue';
import NoticeBox from './NoticeBox.vue';
import { useConsole } from '../store/context';
import { isApiError } from '../api/client';
import { GATE_LABELS, evaluateGate } from '../lib/gates';
import { NODE_RESOURCE_TOKEN_SUSPECT_TEXT } from '../lib/labels';
import { newRequestId } from '../lib/request-id';

const { api, store, toasts, accepted } = useConsole();

/**
 * 与服务端 RELOAD_FULL_RESTART_NOTICE（service/src/engine/maintenance.ts）同一段说明：surge-cli 6.10 的 reload 说明
 * “Automatically performs a full engine restart if a change requires one.”，完整重启关闭全部连接并清空临时规则。
 */
const RELOAD_FULL_RESTART_NOTICE =
  'Surge 6.9 起重载只应用变化的部分，但在修改需要时会自动执行完整的引擎重启（文档：“Automatically performs a full engine restart if a change requires one.”）：完整重启会关闭全部连接并清空临时规则与缓存，哪些修改会触发它没有写入文档';

/** 更换本机资源地址的说明（选项与确认对话框共用）。 */
const ROTATE_TEXT = '更换本机资源地址：生成新的读取令牌与端口，重新载入工作配置；旧地址立即失效';

const preview = ref<RemergePreviewResponse | null>(null);
/** 生成当前预览时的选项：提交必须带同样的选项（预览摘要包含它）。 */
const previewRotate = ref(false);
const loading = ref(false);
const committing = ref(false);
const stale = ref(false);
/** 勾选的「更换本机资源地址」。 */
const rotate = ref(false);
const confirmRotate = ref(false);

/** 本机资源服务的状态（旧版服务不带这一项时为 undefined，此时不提供更换地址的选项）。 */
const nodeResource = computed(() => store.surge.value?.nodeResource);
const rotateOffered = computed(() => !!nodeResource.value);
/** 仍引用旧版本地节点文件：本机资源服务提供节点的门槛（resourceServe）满足之前，重新合并保持原有引用。 */
const legacyLine = computed(() => nodeResource.value?.state === 'legacy_line');
const resourceServeGate = computed(() => evaluateGate(store.capabilities.value, 'resourceServe'));
// 选项改变：原预览不再对应提交时的选项，作废
watch(rotate, () => {
  preview.value = null;
  stale.value = false;
});

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
  const withRotate = rotateOffered.value && rotate.value;
  try {
    const p = await api.remergePreview(withRotate ? { rotateResourceUrl: true } : {});
    // 等待期间选项又被改变：这份预览不对应当前选项，不采用
    if (withRotate !== (rotateOffered.value && rotate.value)) return;
    preview.value = p;
    previewRotate.value = withRotate;
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '预览失败');
  } finally {
    loading.value = false;
  }
}

/** 提交：更换本机资源地址的预览先经确认对话框。 */
function requestCommit() {
  if (!preview.value || blockedReason.value) return;
  if (previewRotate.value) confirmRotate.value = true;
  else void commit();
}

async function commit() {
  const p = preview.value;
  if (!p || blockedReason.value) return;
  const withRotate = previewRotate.value;
  committing.value = true;
  try {
    accepted(
      await api.remergeCommit({ request_id: newRequestId(), preview_digest: p.preview_digest, ...(withRotate ? { rotateResourceUrl: true } : {}) }),
      withRotate ? '已受理：正在重新合并并更换本机资源地址，结果以读回为准' : '已受理：正在重新合并，结果以读回为准',
    );
    preview.value = null;
    confirmRotate.value = false;
    rotate.value = false;
  } catch (e) {
    confirmRotate.value = false;
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
      <p class="text-xs text-gray-500 dark:text-dark-400">用于恢复被改动的受管理段（含 SFE-ROUTE 的节点资源地址）与本应用文件，或接入新的结构（例如改用本机资源服务）；不覆盖你在受管理段之外的修改</p>
    </div>
    <div class="card-body space-y-5">
      <NoticeBox v-if="nodeResource?.tokenSuspect" tone="danger" title="读取令牌可能已泄露" data-test="remerge-token-suspect">{{ NODE_RESOURCE_TOKEN_SUSPECT_TEXT }}</NoticeBox>
      <NoticeBox v-if="legacyLine" tone="warning" title="工作配置仍引用本地节点文件" data-test="remerge-legacy-line">
        <p>SFE-ROUTE 仍引用旧版的本地节点文件 sfe-nodes.list，新版本只能经本机资源服务发布。</p>
        <p v-if="resourceServeGate.met">重新合并会把它改为指向本机资源服务，需要重载同一配置一次；之后由本机资源服务提供已提交的节点。</p>
        <template v-else>
          <p>本机资源服务补测通过后才能改用本机资源服务；在此之前重新合并保持原有本地节点文件引用，新版本保持“已保存，待部署”。</p>
          <MissingCapabilities :missing="resourceServeGate.missing" :intro="`「${GATE_LABELS.resourceServe}」需要以下能力在测试 Mac 上通过实测并经你确认：`" />
        </template>
      </NoticeBox>
      <label v-if="rotateOffered" class="flex cursor-pointer items-start gap-3">
        <input
          v-model="rotate"
          type="checkbox"
          class="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-600 dark:bg-dark-800"
          :disabled="loading || committing"
          data-test="rotate-resource-url"
        />
        <span>
          <span class="block text-sm font-medium text-gray-900 dark:text-white">更换本机资源地址</span>
          <span class="block text-xs text-gray-500 dark:text-dark-400">{{ ROTATE_TEXT }}。读取令牌可能已泄露时只能这样清除；改变这一项后需要重新预览。</span>
        </span>
      </label>
      <template v-if="preview">
        <MaintenancePreview :preview="preview" />
        <NoticeBox v-if="preview.requiresReload" tone="warning" title="需要重载同一配置" data-test="reload-notice">
          写入后需要重载工作配置才能生效。{{ preview.measuredReloadImpact ? `P0 测得的影响：${preview.measuredReloadImpact}` : '重载影响尚未测量。' }}{{ RELOAD_FULL_RESTART_NOTICE }}。请选择对其他应用影响最小的时间提交。
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
      <button type="button" class="btn btn-primary" :disabled="!preview || blockedReason !== null || committing" data-test="remerge-commit" @click="requestCommit">
        <Spinner v-if="committing" color="white" decorative />{{ preview && previewRotate ? '重新合并并更换地址' : '重新合并' }}
      </button>
    </div>
    <ConfirmDialog
      :show="confirmRotate"
      title="更换本机资源地址"
      message="确定要更换本机资源地址吗？"
      confirm-text="更换并重新合并"
      variant="warning"
      :loading="committing"
      @confirm="commit"
      @cancel="confirmRotate = false"
    >
      <p data-test="rotate-confirm-text">{{ ROTATE_TEXT }}。</p>
      <p>Surge 从新地址载入的节点要经一次单 key 更新与读回确认（受发布门槛约束，门槛未满足时停在待部署）。</p>
    </ConfirmDialog>
    <ConfirmDialog :show="stale" title="预览已过期" message="确定要重新预览吗？" confirm-text="重新预览" @confirm="rerun" @cancel="stale = false">
      <p>工作配置或本应用文件在预览后发生了变化，提交已被拒绝，没有写入任何文件。</p>
    </ConfirmDialog>
  </div>
</template>
