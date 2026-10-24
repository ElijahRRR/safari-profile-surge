<script setup lang="ts">
// 秘密字段的三种修改语义：保留 / 替换 / 清除（EasyQuick Tabs 分段控件 + input）。
// 值只存在于父组件内存中，由父组件在提交或关闭时清空。
import { computed } from 'vue';
import type { SecretDraft } from './secret';

const props = withDefaults(
  defineProps<{
    label: string;
    modelValue: SecretDraft;
    configured: boolean;
    configuredHint?: string | null;
    inputType?: 'password' | 'text' | 'email';
    error?: string | null;
    name: string;
  }>(),
  { inputType: 'password', error: null, configuredHint: null },
);
const emit = defineEmits<{ 'update:modelValue': [SecretDraft] }>();

const OPTIONS = computed(() => {
  const opts: Array<{ action: SecretDraft['action']; label: string }> = [
    { action: 'keep', label: '保留' },
    { action: 'replace', label: '替换' },
  ];
  if (props.configured) opts.push({ action: 'clear', label: '清除' });
  return opts;
});

function select(action: SecretDraft['action']) {
  emit('update:modelValue', { action, value: action === 'replace' ? props.modelValue.value : '' });
}
function input(e: Event) {
  emit('update:modelValue', { action: 'replace', value: (e.target as HTMLInputElement).value });
}
</script>

<template>
  <div>
    <label class="input-label">{{ props.label }}</label>
    <div class="tabs" role="tablist" :aria-label="props.label">
      <button
        v-for="o in OPTIONS"
        :key="o.action"
        type="button"
        role="tab"
        class="tab"
        :class="{ 'tab-active': props.modelValue.action === o.action }"
        :aria-selected="props.modelValue.action === o.action"
        :data-test="`${props.name}-${o.action}`"
        @click="select(o.action)"
      >
        {{ o.label }}
      </button>
    </div>
    <input
      v-if="props.modelValue.action === 'replace'"
      class="input mt-2"
      :class="{ 'input-error ring-2 ring-red-500/20': props.error }"
      :type="props.inputType"
      :value="props.modelValue.value"
      :data-test="`${props.name}-input`"
      autocomplete="off"
      spellcheck="false"
      @input="input"
    />
    <p v-if="props.error" class="input-error-text mt-1.5">{{ props.error }}</p>
    <p v-else-if="props.modelValue.action === 'keep'" class="input-hint mt-1.5">
      {{ props.configured ? (props.configuredHint ?? '已配置，保持不变') : '未配置' }}
    </p>
    <p v-else-if="props.modelValue.action === 'clear'" class="input-hint mt-1.5">保存后清除</p>
  </div>
</template>
