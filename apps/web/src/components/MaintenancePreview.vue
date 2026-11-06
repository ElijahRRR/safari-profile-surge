<script setup lang="ts">
// 初始化与重新合并共用的预览内容：路径、备份、引用文件、检查、名称冲突、目录风险、运行开关与受管理差异。
import type { InitPreviewResponse, RemergePreviewResponse } from '@sfe/contract';
import { Badge } from '@sfe/easyquick';
import KeyValueList from './KeyValueList.vue';
import NoticeBox from './NoticeBox.vue';
import { DIRECTORY_RISK_LABELS, TAKEOVER_OUTBOUND_LABELS, boolLabel } from '../lib/labels';

defineProps<{ preview: InitPreviewResponse | RemergePreviewResponse }>();
</script>

<template>
  <div class="space-y-5 text-sm" data-test="maintenance-preview">
    <KeyValueList
      :items="[
        ...('sourceProfileName' in preview ? [{ key: 'source', label: '源配置', value: `${preview.sourceProfileName}（${preview.sourceProfilePath}）` }] : []),
        { key: 'target', label: '工作配置', value: preview.workingProfilePath },
        { key: 'backup', label: '备份目录', value: preview.backupDirectory },
        { key: 'risk', label: '配置目录' },
        { key: 'autoReload', label: '自动重载', value: boolLabel(preview.autoReloadEnabled) },
        { key: 'takeover', label: '接管与出站' },
        { key: 'httpApi', label: 'HTTP API' },
      ]"
    >
      <template #v-target><span class="font-mono text-xs">{{ preview.workingProfilePath }}</span></template>
      <template #v-backup><span class="font-mono text-xs">{{ preview.backupDirectory }}</span></template>
      <template #v-risk>
        <Badge :variant="DIRECTORY_RISK_LABELS[preview.profileDirectoryRisk].variant">{{ DIRECTORY_RISK_LABELS[preview.profileDirectoryRisk].label }}</Badge>
      </template>
      <template #v-takeover>
        增强模式{{ boolLabel(preview.takeover.enhancedMode) }}，系统代理{{ boolLabel(preview.takeover.systemProxy) }}，{{
          preview.takeover.outboundMode ? TAKEOVER_OUTBOUND_LABELS[preview.takeover.outboundMode] : '出站模式无法读取'
        }}
      </template>
      <template #v-httpApi>
        {{ preview.httpApi.configured ? (preview.httpApi.loopbackOnly === false ? '已配置，绑定到非本机地址' : '已配置，只监听本机') : '未配置' }}
      </template>
    </KeyValueList>

    <NoticeBox v-if="'managedConfigDetected' in preview && preview.managedConfigDetected" tone="warning" title="检测到远端托管头">
      源配置带有 #!MANAGED-CONFIG。工作配置会移除它（见下方差异），之后远端更新不再自动应用，需要通过重新合并接入。
    </NoticeBox>
    <NoticeBox v-if="preview.remoteUpdatesNotice" tone="warning">
      {{ preview.remoteUpdatesNotice }}
      <template v-if="preview.remoteSources.length">远端来源：{{ preview.remoteSources.join('、') }}</template>
    </NoticeBox>
    <NoticeBox v-if="preview.nameCollisions.length" tone="danger" title="名称或文件冲突">
      {{ preview.nameCollisions.join('、') }}。这些对象不属于本应用，不会被接管或覆盖；请先在 Surge 中处理。
    </NoticeBox>

    <section>
      <h4 class="mb-2 font-semibold text-gray-900 dark:text-white">检查</h4>
      <ul class="space-y-1.5">
        <li v-for="c in preview.checks" :key="c.name" class="flex items-start gap-2">
          <Badge :variant="c.ok ? 'success' : 'danger'">{{ c.ok ? '通过' : '不通过' }}</Badge>
          <span class="text-gray-700 dark:text-gray-300">{{ c.message }}</span>
        </li>
      </ul>
    </section>

    <section v-if="preview.referencedFiles.length">
      <h4 class="mb-2 font-semibold text-gray-900 dark:text-white">引用的本地文件</h4>
      <ul class="space-y-1">
        <li v-for="f in preview.referencedFiles" :key="f.relativePath" class="flex items-center gap-2">
          <span class="font-mono text-xs">{{ f.relativePath }}</span>
          <Badge :variant="f.present ? 'success' : 'danger'">{{ f.present ? '存在' : '缺失' }}</Badge>
        </li>
      </ul>
    </section>

    <section>
      <h4 class="mb-2 font-semibold text-gray-900 dark:text-white">受管理段差异</h4>
      <pre class="code-block max-h-72 overflow-auto whitespace-pre text-xs" data-test="managed-diff">{{ preview.managedDiff || '（无变化）' }}</pre>
    </section>
    <section v-if="'managedFilesDiff' in preview">
      <h4 class="mb-2 font-semibold text-gray-900 dark:text-white">本应用文件差异</h4>
      <pre class="code-block max-h-72 overflow-auto whitespace-pre text-xs">{{ preview.managedFilesDiff || '（无变化）' }}</pre>
    </section>
  </div>
</template>
