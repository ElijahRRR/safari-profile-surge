<script setup lang="ts">
// Surge 状态卡：版本、工作配置、接管与出站、自动重载、HTTP API、配置目录风险、本机资源服务（只有状态，不含地址、端口或令牌）、
// 优先级问题。
import { computed } from 'vue';
import { Badge, StatusBadge } from '@sfe/easyquick';
import KeyValueList from './KeyValueList.vue';
import NoticeBox from './NoticeBox.vue';
import { useConsole } from '../store/context';
import { DIRECTORY_RISK_LABELS, NODE_RESOURCE_STATE_LABELS, TAKEOVER_OUTBOUND_LABELS, boolLabel } from '../lib/labels';
import { formatNumber, formatRelative } from '../lib/format';
import { WORKING_PROFILE_NAME } from '@sfe/contract';

const { store } = useConsole();
const surge = computed(() => store.surge.value);

const items = computed(() => {
  const s = surge.value;
  return [
    { key: 'version', label: '版本', value: s?.version ? `${s.version}${s.build ? `（${s.build}）` : ''}` : '无法读取' },
    { key: 'profile', label: '当前配置' },
    { key: 'managed', label: '受管理段' },
    { key: 'generation', label: '配置代数', value: s ? formatNumber(s.configurationGeneration) : '—' },
    { key: 'takeover', label: '接管' },
    { key: 'outbound', label: '出站模式' },
    { key: 'autoReload', label: '自动重载', value: boolLabel(s?.autoReload) },
    { key: 'httpApi', label: 'HTTP API' },
    { key: 'dirRisk', label: '配置目录' },
    // 旧版服务不带本机资源服务的状态：不显示这一行
    ...(s?.nodeResource !== undefined ? [{ key: 'nodeResource', label: '本机资源服务' }] : []),
  ];
});

const takeoverText = computed(() => {
  const t = surge.value?.takeover;
  if (!t) return '无法读取';
  const parts = [`增强模式${boolLabel(t.enhancedMode)}`, `系统代理${boolLabel(t.systemProxy)}`];
  return parts.join('，');
});
</script>

<template>
  <div class="card" data-test="surge-card">
    <div class="card-header flex items-center justify-between gap-3">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">Surge</h3>
      <StatusBadge v-if="surge" :status="surge.reachable ? 'success' : 'danger'" :label="surge.reachable ? '可连接' : '无法连接'" />
    </div>
    <div v-if="surge" class="card-body space-y-4">
      <KeyValueList :items="items">
        <template #v-profile>
          <span class="inline-flex flex-wrap items-center justify-end gap-2">
            <span>{{ surge.currentProfileName ?? '无法读取' }}</span>
            <Badge v-if="surge.onWorkingProfile === true" variant="success">工作配置</Badge>
            <Badge v-else-if="surge.onWorkingProfile === false" variant="danger">不是{{ WORKING_PROFILE_NAME }}</Badge>
          </span>
        </template>
        <template #v-managed>
          <Badge v-if="surge.managedSectionsIntact === true" variant="success">完整</Badge>
          <Badge v-else-if="surge.managedSectionsIntact === false" variant="danger">被修改或缺失</Badge>
          <span v-else>无法读取</span>
        </template>
        <template #v-takeover>{{ takeoverText }}</template>
        <template #v-outbound>
          <Badge v-if="surge.takeover.outboundMode" :variant="surge.takeover.outboundMode === 'rule' ? 'success' : 'danger'">{{ TAKEOVER_OUTBOUND_LABELS[surge.takeover.outboundMode] }}</Badge>
          <span v-else>无法读取</span>
        </template>
        <template #v-httpApi>
          <span v-if="!surge.httpApi.configured">未配置</span>
          <Badge v-else-if="surge.httpApi.loopbackOnly === true" variant="success">只监听本机</Badge>
          <Badge v-else-if="surge.httpApi.loopbackOnly === false" variant="danger">绑定到非本机地址，已停用</Badge>
          <span v-else>已配置，绑定地址无法读取</span>
        </template>
        <template #v-dirRisk>
          <Badge v-if="surge.profileDirectoryRisk" :variant="DIRECTORY_RISK_LABELS[surge.profileDirectoryRisk].variant">{{ DIRECTORY_RISK_LABELS[surge.profileDirectoryRisk].label }}</Badge>
          <span v-else>无法读取</span>
        </template>
        <template #v-nodeResource>
          <span class="inline-flex flex-wrap items-center justify-end gap-2">
            <template v-if="surge.nodeResource">
              <Badge :variant="NODE_RESOURCE_STATE_LABELS[surge.nodeResource.state]?.variant ?? 'danger'">{{ NODE_RESOURCE_STATE_LABELS[surge.nodeResource.state]?.label ?? '状态未知' }}</Badge>
              <Badge v-if="surge.nodeResource.tokenSuspect" variant="danger">令牌可能已泄露</Badge>
              <Badge v-if="surge.nodeResource.needsRefresh" variant="warning">待重新同步</Badge>
            </template>
            <span v-else>未初始化</span>
          </span>
        </template>
      </KeyValueList>
      <div v-if="surge.precedenceIssues.length" class="space-y-2">
        <h4 class="text-sm font-semibold text-gray-900 dark:text-white">排在本应用入口之前的规则</h4>
        <ul class="space-y-2">
          <li v-for="(issue, i) in surge.precedenceIssues" :key="i" class="flex flex-wrap items-center gap-2 text-sm">
            <Badge :variant="issue.severity === 'blocking' ? 'danger' : 'warning'">{{ issue.severity === 'blocking' ? '阻止激活' : '提示' }}</Badge>
            <span class="code">{{ issue.rule }}</span>
            <span class="text-gray-500 dark:text-dark-400">{{ { module: '模块', temp_rule: '临时规则', profile: '配置', unknown: '来源未知' }[issue.source] }}</span>
          </li>
        </ul>
      </div>
      <NoticeBox v-if="surge.message" tone="warning">{{ surge.message }}</NoticeBox>
      <p class="text-xs text-gray-500 dark:text-dark-400">最近检查 {{ formatRelative(surge.lastCheckedAt, store.state.now) }}</p>
    </div>
  </div>
</template>
