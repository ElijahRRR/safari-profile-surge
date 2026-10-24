<script setup lang="ts">
// 秘密字段（代理用户名/密码、账号密码）：从不预填、从不显示已保存的值，只显示“已配置/未配置”。
// 编辑时明确选择「保持不变 / 替换 / 清除」，默认保持不变；新建时留空即不设置。
// 输入值只在组件内存中，由父组件在提交或关闭时清除。
import { computed, useId } from 'vue';
import type { SecretAction } from '../lib/environment-form';

const props = withDefaults(
  defineProps<{
    label: string;
    mode: 'create' | 'edit';
    configured: boolean;
    action: SecretAction;
    value: string;
    inputType?: 'text' | 'password';
    error?: string | null;
    hint?: string | null;
  }>(),
  { inputType: 'password', error: null, hint: null },
);
const emit = defineEmits<{ 'update:action': [action: SecretAction]; 'update:value': [value: string] }>();

const id = `secret-${useId()}`;
const showInput = computed(() => props.mode === 'create' || props.action === 'replace');
const OPTIONS: Array<{ value: SecretAction; label: string }> = [
  { value: 'keep', label: '保持不变' },
  { value: 'replace', label: '替换' },
  { value: 'clear', label: '清除' },
];

function choose(action: SecretAction) {
  if (action === 'clear' && !props.configured) return;
  emit('update:action', action);
  if (action !== 'replace') emit('update:value', '');
}
</script>

<template>
  <div :data-secret="label">
    <div class="mb-1.5 flex items-center justify-between gap-2">
      <label class="input-label mb-0" :for="showInput ? id : undefined" :id="`${id}-label`">{{ label }}</label>
      <span v-if="mode === 'edit'" class="text-xs" :class="configured ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-500 dark:text-dark-400'">
        {{ configured ? '已配置' : '未配置' }}
      </span>
    </div>
    <div v-if="mode === 'edit'" class="tabs mb-2 w-fit" role="radiogroup" :aria-labelledby="`${id}-label`">
      <button
        v-for="opt in OPTIONS"
        :key="opt.value"
        type="button"
        role="radio"
        class="tab"
        :class="{ 'tab-active': action === opt.value }"
        :aria-checked="action === opt.value ? 'true' : 'false'"
        :disabled="opt.value === 'clear' && !configured"
        :data-action="opt.value"
        @click="choose(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>
    <input
      v-if="showInput"
      :id="id"
      class="input"
      :class="error ? 'input-error ring-2 ring-red-500/20' : ''"
      :type="inputType"
      :value="value"
      autocomplete="new-password"
      spellcheck="false"
      :placeholder="mode === 'create' ? '留空表示不设置' : '输入新的值'"
      :aria-invalid="error ? 'true' : undefined"
      @input="emit('update:value', ($event.target as HTMLInputElement).value)"
    />
    <p v-if="error" class="input-error-text mt-1.5">{{ error }}</p>
    <p v-else-if="mode === 'edit' && action === 'clear'" class="input-hint mt-1.5">保存后清除已保存的值。</p>
    <p v-else-if="hint" class="input-hint mt-1.5">{{ hint }}</p>
  </div>
</template>
