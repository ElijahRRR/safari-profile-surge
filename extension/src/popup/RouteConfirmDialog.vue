<script setup lang="ts">
// 旧窗口确认：激活或进入普通模式收到 NEEDS_CONFIRMATION 时显示，两种选择逐次显式确认，
// 不作为默认值；选择后用同一个 request_id 重发。
import type { OldSessionPolicy } from '@sfe/contract';
import BaseDialog from '../ui/BaseDialog.vue';
import type { ConfirmState } from './controller';
import { POLICY_BUTTON, confirmationReason, confirmationTitle, policyConsequence } from '../shared/text';

const props = defineProps<{ confirm: ConfirmState; busy: boolean }>();
const emit = defineEmits<{ choose: [OldSessionPolicy]; cancel: [] }>();
</script>

<template>
  <BaseDialog :title="confirmationTitle(props.confirm.kind)" width="narrow" @close="emit('cancel')">
    <p data-test="confirm-reason">{{ confirmationReason(props.confirm.kind, props.confirm.details) }}</p>
    <div v-if="props.confirm.details.otherProfilesOpen.length">
      <p class="font-medium text-gray-900 dark:text-white">有打开窗口的其他场景</p>
      <ul class="mt-1 space-y-0.5">
        <li v-for="p in props.confirm.details.otherProfilesOpen" :key="p.profileIdShort">
          场景 <span class="code">{{ p.profileIdShort }}</span><template v-if="p.environmentLabel">（{{ p.environmentLabel }}）</template>
        </li>
      </ul>
      <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">只包含已启用扩展并上报过的场景。</p>
    </div>
    <p
      v-for="option in props.confirm.details.options"
      :key="option"
      class="rounded-xl bg-gray-50 px-3 py-2 dark:bg-dark-900/40"
      :data-test="`consequence-${option}`"
    >
      {{ policyConsequence(props.confirm.kind, option) }}
    </p>
    <p v-if="props.confirm.details.limitation" class="rounded-xl bg-warning-soft px-3 py-2 text-warning" data-test="confirm-limitation">
      {{ props.confirm.details.limitation }}
    </p>
    <template #footer>
      <button type="button" class="btn btn-secondary btn-sm" :disabled="props.busy" @click="emit('cancel')">取消</button>
      <button
        v-if="props.confirm.details.options.includes('keep_open_acknowledged')"
        type="button"
        class="btn btn-warning btn-sm"
        :disabled="props.busy"
        data-test="choose-keep_open_acknowledged"
        @click="emit('choose', 'keep_open_acknowledged')"
      >
        {{ POLICY_BUTTON.keep_open_acknowledged }}
      </button>
      <button
        v-if="props.confirm.details.options.includes('closed_confirmed')"
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="props.busy"
        data-test="choose-closed_confirmed"
        @click="emit('choose', 'closed_confirmed')"
      >
        {{ POLICY_BUTTON.closed_confirmed }}
      </button>
    </template>
  </BaseDialog>
</template>
