<script setup lang="ts">
// 未登录：说明如何从菜单栏 App 或 sfe open 打开管理后台。没有登录表单——登录码是一次性链接。
import { computed } from 'vue';
import { Icon } from '@sfe/easyquick';
import NoticeBox from '../components/NoticeBox.vue';
import type { SessionStatus } from '../store/console';

const props = defineProps<{ status: SessionStatus; message: string | null }>();
const emit = defineEmits<{ retry: [] }>();

const heading = computed(() => {
  if (props.status === 'expired') return '会话已过期';
  if (props.status === 'error') return '无法连接本机服务';
  return '请从菜单栏打开管理后台';
});
</script>

<template>
  <div class="relative flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-dark-950" data-test="login-view">
    <div class="pointer-events-none fixed inset-0 bg-mesh-gradient" />
    <div class="card relative w-full max-w-lg">
      <div class="card-body space-y-5">
        <div class="flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-gradient-primary text-white shadow-glow" aria-hidden="true"><Icon name="cube" /></div>
          <span class="text-lg font-bold text-gray-900 dark:text-white">Safari 场景出口</span>
        </div>
        <div>
          <h1 class="page-title">{{ heading }}</h1>
          <p class="page-description">管理后台只接受一次性登录链接，本页没有登录表单。</p>
        </div>
        <NoticeBox v-if="status === 'error'" tone="danger">{{ message ?? '连接本机服务失败：服务未运行或已停止' }}</NoticeBox>
        <NoticeBox v-else-if="status === 'expired'" tone="warning">{{ message ?? '会话已过期，请重新打开管理后台。' }}</NoticeBox>
        <ol class="list-decimal space-y-2 pl-5 text-sm text-gray-700 dark:text-gray-300">
          <li>点击菜单栏中的「Safari 场景出口」图标，选择「打开管理后台」。</li>
          <li>或在终端运行 <span class="code">sfe open</span>。</li>
          <li>登录链接 60 秒内有效，只能使用一次；打开后地址栏不会保留登录码。</li>
        </ol>
        <p class="text-xs text-gray-500 dark:text-dark-400">会话最长 12 小时，空闲 2 小时后过期。</p>
      </div>
      <div v-if="status === 'error'" class="card-footer flex justify-end">
        <button type="button" class="btn btn-secondary" @click="emit('retry')"><Icon name="refresh" />重试</button>
      </div>
    </div>
  </div>
</template>
