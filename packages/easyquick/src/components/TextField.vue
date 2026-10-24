<script setup lang="ts">
// 设计系统 Input：input-label → input → input-hint / input-error-text。不要省略标签只留占位符。
import { computed, useId } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    type?: 'text' | 'password' | 'number' | 'email' | 'search';
    placeholder?: string;
    hint?: string | null;
    error?: string | null;
    required?: boolean;
    disabled?: boolean;
    readonly?: boolean;
    autocomplete?: string;
    inputmode?: 'text' | 'numeric' | 'decimal' | 'email' | 'url' | 'none';
    id?: string;
    mono?: boolean;
  }>(),
  {
    type: 'text',
    placeholder: undefined,
    hint: null,
    error: null,
    required: false,
    disabled: false,
    readonly: false,
    autocomplete: 'off',
    inputmode: undefined,
    id: undefined,
    mono: false,
  },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const autoId = useId();
const inputId = computed(() => props.id ?? `field-${autoId}`);
const describedBy = computed(() => (props.error || props.hint ? `${inputId.value}-desc` : undefined));
</script>

<template>
  <div>
    <label class="input-label" :for="inputId">
      {{ label }}<template v-if="required"> <span class="text-red-500" aria-hidden="true">*</span></template>
    </label>
    <div :class="{ relative: $slots.prefix || $slots.suffix }">
      <div v-if="$slots.prefix" class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-gray-400 dark:text-dark-400">
        <slot name="prefix" />
      </div>
      <input
        :id="inputId"
        class="input"
        :class="[
          error ? 'input-error ring-2 ring-red-500/20' : '',
          disabled ? 'cursor-not-allowed bg-gray-100 opacity-60 dark:bg-dark-900' : '',
          $slots.prefix ? 'pl-11' : '',
          $slots.suffix ? 'pr-11' : '',
          mono ? 'font-mono' : '',
        ]"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :required="required"
        :disabled="disabled"
        :readonly="readonly"
        :autocomplete="autocomplete"
        :inputmode="inputmode"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        spellcheck="false"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <div v-if="$slots.suffix" class="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 dark:text-dark-400">
        <slot name="suffix" />
      </div>
    </div>
    <p v-if="error" :id="`${inputId}-desc`" class="input-error-text mt-1.5">{{ error }}</p>
    <p v-else-if="hint" :id="`${inputId}-desc`" class="input-hint mt-1.5">{{ hint }}</p>
  </div>
</template>
