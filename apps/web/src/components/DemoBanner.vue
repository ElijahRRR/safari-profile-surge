<script setup lang="ts">
// 演示模式常驻标识：FakeSurge + 合成数据，任何“已生效”都不代表网络事实。
import { Icon } from '@sfe/easyquick';
</script>

<template>
  <div class="sticky top-16 z-20 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300 md:px-6 lg:px-8" role="status" data-test="demo-banner">
    <div class="flex items-center gap-2">
      <Icon name="beaker" size="sm" />
      <span class="badge badge-warning">DEMO</span>
      <span>演示模式：使用模拟的 Surge 与合成数据，界面上的“已生效”不代表任何网络事实。</span>
    </div>
  </div>
</template>
