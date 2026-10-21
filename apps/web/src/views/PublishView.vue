<script setup lang="ts">
// 发布与 Surge：固定工作配置身份与配置代数、待部署与发布（受能力门槛约束）、前置代理、
// 初始化向导（尚无工作配置时）与重新合并。
import { computed } from 'vue';
import { WORKING_PROFILE_NAME } from '@sfe/contract';
import { Badge, PageHeader } from '@sfe/easyquick';
import KeyValueList from '../components/KeyValueList.vue';
import PendingDeployCard from '../components/PendingDeployCard.vue';
import FrontProxiesCard from '../components/FrontProxiesCard.vue';
import InitWizardCard from '../components/InitWizardCard.vue';
import RemergeCard from '../components/RemergeCard.vue';
import { useConsole } from '../store/context';
import { boolLabel } from '../lib/labels';
import { formatNumber, formatRelative } from '../lib/format';

const { store } = useConsole();
const settings = computed(() => store.settings.value);
const surge = computed(() => store.surge.value);
const initialized = computed(() => !!settings.value?.workingProfilePath);

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
          <KeyValueList
            :items="[
              { key: 'path', label: '工作配置路径' },
              { key: 'current', label: 'Surge 当前配置', value: surge?.currentProfileName ?? '无法读取' },
              { key: 'managed', label: '受管理段' },
              { key: 'generation', label: '配置代数', value: formatNumber(surge?.configurationGeneration) },
              { key: 'autoReload', label: '自动重载', value: boolLabel(surge?.autoReload) },
              { key: 'checked', label: '最近检查', value: formatRelative(surge?.lastCheckedAt, store.state.now) },
            ]"
          >
            <template #v-path>
              <span v-if="settings?.workingProfilePath" class="font-mono text-xs">{{ settings.workingProfilePath }}</span>
              <span v-else>未初始化</span>
            </template>
            <template #v-managed>
              <Badge v-if="surge?.managedSectionsIntact === true" variant="success">完整</Badge>
              <Badge v-else-if="surge?.managedSectionsIntact === false" variant="danger">被修改或缺失，已停止同步</Badge>
              <span v-else>无法读取</span>
            </template>
          </KeyValueList>
          <p class="mt-3 text-xs text-gray-500 dark:text-dark-400">日常只使用这一份配置：本应用从不切换配置、不重载全部、不更新全部外部资源。</p>
        </div>
      </div>

      <InitWizardCard v-if="store.state.snapshot && !initialized" />
      <PendingDeployCard />
      <FrontProxiesCard />
      <RemergeCard v-if="initialized" />
    </div>
  </div>
</template>
