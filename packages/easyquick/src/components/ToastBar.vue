<script setup lang="ts">
// Toast 底部 4px 倒计时进度条：挂载后下一帧把宽度从 100% 线性收缩到 0（经 CSSOM 设置，符合 CSP）。
import { onMounted, ref } from 'vue';

const props = defineProps<{ duration: number; barClass: string }>();
const shrink = ref(false);
onMounted(() => {
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16);
  raf(() => {
    shrink.value = true;
  });
});
</script>

<template>
  <div class="h-1 bg-gray-100 dark:bg-dark-700" aria-hidden="true">
    <div class="h-full" :class="barClass" :style="{ width: shrink ? '0%' : '100%', transition: shrink ? `width ${props.duration}ms linear` : 'none' }" />
  </div>
</template>
