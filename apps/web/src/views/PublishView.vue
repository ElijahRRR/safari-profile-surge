<script setup lang="ts">
// 发布与 Surge：固定工作配置身份与配置代数、待部署与发布（受能力门槛约束）、前置代理、
// 初始化向导（尚无工作配置时）与重新合并。初始化成功后向导随 settings.updated 卸载，
// 「在 Surge 中手动切换一次」由固定工作配置卡片持续提示，直到读回 Surge 正在使用工作配置。
// 本机资源服务（D10）只显示服务给出的状态码与两个标志，从不显示地址、端口或读取令牌。
import { computed } from 'vue';
import { WORKING_PROFILE_NAME } from '@sfe/contract';
import { Badge, PageHeader } from '@sfe/easyquick';
import KeyValueList from '../components/KeyValueList.vue';
import NoticeBox from '../components/NoticeBox.vue';
import PendingDeployCard from '../components/PendingDeployCard.vue';
import FrontProxiesCard from '../components/FrontProxiesCard.vue';
import InitWizardCard from '../components/InitWizardCard.vue';
import RemergeCard from '../components/RemergeCard.vue';
import { useConsole } from '../store/context';
import { nodeResourcePublishBlocks } from '../lib/gates';
import {
  NODE_RESOURCE_NEEDS_REFRESH_BLOCKED_TEXT,
  NODE_RESOURCE_NEEDS_REFRESH_TEXT,
  NODE_RESOURCE_STATE_DETAILS,
  NODE_RESOURCE_STATE_LABELS,
  NODE_RESOURCE_TOKEN_SUSPECT_TEXT,
  boolLabel,
} from '../lib/labels';
import { formatNumber, formatRelative } from '../lib/format';

const { store } = useConsole();
const settings = computed(() => store.settings.value);
const surge = computed(() => store.surge.value);
const initialized = computed(() => !!settings.value?.workingProfilePath);
/** 已有工作配置但没有确认 Surge 正在使用它（初始化后 Surge 事实可能尚未重新读取，为 null）。 */
const needsManualSwitch = computed(() => initialized.value && surge.value?.onWorkingProfile !== true);
/** 本机资源服务的状态：旧版服务不带这一项（undefined）时不显示这一行；尚未初始化时为 null。 */
const nodeResource = computed(() => surge.value?.nodeResource);
/** 需要说明的状态（不是正在提供，或令牌可疑、待重新同步）。 */
const nodeResourceNotes = computed(() => {
  const nr = nodeResource.value;
  if (!nr) return [];
  const notes: Array<{ key: string; text: string }> = [];
  if (nr.state !== 'serving') notes.push({ key: 'state', text: NODE_RESOURCE_STATE_DETAILS[nr.state] ?? '本机资源服务状态未知。' });
  if (nr.tokenSuspect) notes.push({ key: 'tokenSuspect', text: NODE_RESOURCE_TOKEN_SUSPECT_TEXT });
  // “下一次发布会单 key 更新”只在资源服务满足发布前提时成立（仍引用本地节点文件时每次发布都停泊，服务也不自动同步）
  if (nr.needsRefresh) notes.push({ key: 'needsRefresh', text: nodeResourcePublishBlocks(nr).length === 0 ? NODE_RESOURCE_NEEDS_REFRESH_TEXT : NODE_RESOURCE_NEEDS_REFRESH_BLOCKED_TEXT });
  return notes;
});
const nodeResourceTone = computed<'info' | 'warning' | 'danger'>(() => {
  const nr = nodeResource.value;
  if (!nr) return 'info';
  return nr.tokenSuspect || NODE_RESOURCE_STATE_LABELS[nr.state]?.variant === 'danger' ? 'danger' : 'warning';
});
const profileItems = computed(() => [
  { key: 'path', label: '工作配置路径' },
  { key: 'current', label: 'Surge 当前配置', value: surge.value?.currentProfileName ?? '无法读取' },
  { key: 'managed', label: '受管理段' },
  ...(nodeResource.value !== undefined ? [{ key: 'nodeResource', label: '本机资源服务' }] : []),
  { key: 'generation', label: '配置代数', value: formatNumber(surge.value?.configurationGeneration) },
  { key: 'autoReload', label: '自动重载', value: boolLabel(surge.value?.autoReload) },
  { key: 'checked', label: '最近检查', value: formatRelative(surge.value?.lastCheckedAt, store.state.now) },
]);

const description = computed(() =>
  initialized.value ? `工作配置「${WORKING_PROFILE_NAME}」，配置代数 ${formatNumber(surge.value?.configurationGeneration)}` : '尚未初始化固定工作配置',
);
</script>

<template>
  <div>
    <PageHeader title="发布与 Surge" :description="description" />
    <div class="space-y-6">
      <div class="card" data-test="working-profile">
        <div class="card-header flex items-center justify-between gap-3">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">固定工作配置</h3>
          <Badge v-if="surge?.onWorkingProfile === true" variant="success">Surge 正在使用</Badge>
          <Badge v-else-if="surge?.onWorkingProfile === false" variant="danger">Surge 未使用工作配置</Badge>
        </div>
        <div class="card-body">
          <NoticeBox
            v-if="needsManualSwitch"
            :tone="surge?.onWorkingProfile === false ? 'warning' : 'info'"
            title="下一步：在 Surge 中手动切换一次"
            class="mb-4"
            data-test="manual-switch"
          >
            <p v-if="surge?.onWorkingProfile === false">
              Surge 当前配置是「{{ surge?.currentProfileName ?? '无法读取' }}」，不是「{{ WORKING_PROFILE_NAME }}」。请在 Surge 中把当前配置手动切换到「{{ WORKING_PROFILE_NAME }}」一次。
            </p>
            <p v-else>还没有确认 Surge 正在使用「{{ WORKING_PROFILE_NAME }}」。如果初始化后还没有切换，请在 Surge 中把当前配置手动切换到「{{ WORKING_PROFILE_NAME }}」一次。</p>
            <p>只需要这一次；本应用从不切换配置，也不会替你切换。读回 Surge 正在使用它之前，发布和激活环境都会被拒绝。</p>
          </NoticeBox>
          <KeyValueList :items="profileItems">
            <template #v-path>
              <span v-if="settings?.workingProfilePath" class="font-mono text-xs">{{ settings.workingProfilePath }}</span>
              <span v-else>未初始化</span>
            </template>
            <template #v-managed>
              <Badge v-if="surge?.managedSectionsIntact === true" variant="success">完整</Badge>
              <Badge v-else-if="surge?.managedSectionsIntact === false" variant="danger">被修改或缺失，已停止同步</Badge>
              <span v-else>无法读取</span>
            </template>
            <template #v-nodeResource>
              <span class="inline-flex flex-wrap items-center justify-end gap-2" data-test="node-resource-state">
                <template v-if="nodeResource">
                  <Badge :variant="NODE_RESOURCE_STATE_LABELS[nodeResource.state]?.variant ?? 'danger'">{{ NODE_RESOURCE_STATE_LABELS[nodeResource.state]?.label ?? '状态未知' }}</Badge>
                  <Badge v-if="nodeResource.tokenSuspect" variant="danger">令牌可能已泄露</Badge>
                  <Badge v-if="nodeResource.needsRefresh" variant="warning">待重新同步</Badge>
                </template>
                <span v-else>未初始化</span>
              </span>
            </template>
          </KeyValueList>
          <NoticeBox v-if="nodeResourceNotes.length" :tone="nodeResourceTone" title="本机资源服务" class="mt-4" data-test="node-resource-notes">
            <p v-for="n in nodeResourceNotes" :key="n.key">{{ n.text }}</p>
          </NoticeBox>
          <p class="mt-3 text-xs text-gray-500 dark:text-dark-400">日常只使用这一份配置：本应用从不切换配置、不重载全部、不更新全部外部资源；发布节点时只对本应用的这一项节点资源执行单 key 更新。</p>
        </div>
      </div>

      <InitWizardCard v-if="store.state.snapshot && !initialized" />
      <PendingDeployCard />
      <FrontProxiesCard />
      <RemergeCard v-if="initialized" />
    </div>
  </div>
</template>
