<script setup lang="ts">
// 激活或进入普通模式前的旧窗口确认（服务端 409 NEEDS_CONFIRMATION 的内容）。两个选项必须由用户
// 显式选择，没有默认值；「不关闭」写明后果，之后状态会持续带警告。
import { computed } from 'vue';
import type { NeedsConfirmationDetails, OldSessionPolicy } from '@sfe/contract';
import { Badge, BaseDialog, Spinner } from '@sfe/easyquick';
import NoticeBox from './NoticeBox.vue';
import type { RouteActionTarget } from '../store/route-actions';

const props = defineProps<{
  show: boolean;
  target: RouteActionTarget | null;
  details: NeedsConfirmationDetails | null;
  policy: OldSessionPolicy | null;
  sending: boolean;
  error: string | null;
}>();
const emit = defineEmits<{ 'update:policy': [policy: OldSessionPolicy]; confirm: []; cancel: [] }>();

const isActivate = computed(() => props.target?.kind === 'activate');
const title = computed(() => (props.target?.kind === 'activate' ? `切换到 ${props.target.label}` : '进入普通模式'));
const question = computed(() => (props.target?.kind === 'activate' ? `确定要切换到环境 ${props.target.label} 吗？` : '确定要进入普通模式吗？'));

const REASON_TEXT: Record<NeedsConfirmationDetails['reason'], string> = {
  other_environment_active: '另一个环境正在使用 Safari 的出口。',
  managed_environment_active: '有托管环境正在使用 Safari 的出口。',
  other_profiles_open: '其他 Safari 场景有打开的窗口。',
};

const OPTION_TEXT = computed<Record<OldSessionPolicy, { title: string; description: string; recommended: boolean }>>(() => ({
  closed_confirmed: {
    title: '我已关闭旧环境窗口',
    description: '已保存工作并关闭其他场景的 Safari 窗口。切换时会结束属于 Safari 的旧连接。',
    recommended: true,
  },
  keep_open_acknowledged: isActivate.value
    ? {
        title: '不关闭，直接切换',
        description: '旧环境窗口之后发出的请求会经过新环境的出口。状态会持续显示警告，直到你确认已关闭。',
        recommended: false,
      }
    : {
        title: '不关闭，直接进入普通模式',
        description: '旧环境窗口之后发出的请求会按 Surge 原规则发出（可能直连）。状态会持续显示警告，直到你确认已关闭。',
        recommended: false,
      },
}));

const confirmText = computed(() => (isActivate.value ? '继续切换' : '进入普通模式'));
</script>

<template>
  <BaseDialog :show="show" :title="title" width="normal" @close="emit('cancel')">
    <div v-if="details" class="space-y-4 text-sm" data-test="route-confirm">
      <p class="text-gray-500 dark:text-dark-400">{{ question }}</p>
      <p class="text-gray-700 dark:text-gray-300">{{ REASON_TEXT[details.reason] }}</p>
      <dl class="space-y-2 rounded-xl bg-gray-50 p-4 dark:bg-dark-900/40">
        <div class="flex justify-between gap-4">
          <dt class="text-gray-500 dark:text-dark-400">当前使用环境</dt>
          <dd class="text-gray-900 dark:text-gray-100" data-test="current-env">{{ details.currentEnvironmentLabel ?? '无' }}</dd>
        </div>
        <div v-if="details.otherProfilesOpen.length">
          <dt class="text-gray-500 dark:text-dark-400">有打开窗口的其他场景</dt>
          <dd>
            <ul class="mt-1 space-y-1">
              <li v-for="p in details.otherProfilesOpen" :key="p.unidentified ? '~unidentified' : p.profileIdShort" class="flex items-center gap-2 text-gray-900 dark:text-gray-100">
                <template v-if="p.unidentified">
                  <span data-test="unidentified-profile">未识别场景（可能是默认场景）</span>
                </template>
                <template v-else>
                  <span class="code">{{ p.profileIdShort }}</span>
                  <span>{{ p.environmentLabel ?? '未绑定场景' }}</span>
                </template>
              </li>
            </ul>
            <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">只包含已启用扩展并上报过的场景。</p>
          </dd>
        </div>
      </dl>

      <fieldset class="space-y-3">
        <legend class="mb-2 font-medium text-gray-900 dark:text-white">旧环境窗口如何处理</legend>
        <label
          v-for="opt in details.options"
          :key="opt"
          class="flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors"
          :class="policy === opt ? 'border-primary-500 bg-primary-50/40 dark:bg-primary-900/10' : 'border-gray-200 hover:bg-gray-50 dark:border-dark-700 dark:hover:bg-dark-800'"
          :data-option="opt"
        >
          <input
            type="radio"
            name="old-session-policy"
            class="mt-0.5 h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-600 dark:bg-dark-800"
            :value="opt"
            :checked="policy === opt"
            @change="emit('update:policy', opt)"
          />
          <span class="min-w-0 space-y-1">
            <span class="flex items-center gap-2 font-medium text-gray-900 dark:text-white">
              {{ OPTION_TEXT[opt].title }}
              <Badge v-if="OPTION_TEXT[opt].recommended" variant="primary">推荐</Badge>
            </span>
            <span class="block text-gray-500 dark:text-dark-400">{{ OPTION_TEXT[opt].description }}</span>
          </span>
        </label>
      </fieldset>

      <NoticeBox v-if="details.limitation" tone="warning" title="限制" data-test="limitation">{{ details.limitation }}</NoticeBox>
      <NoticeBox v-if="error" tone="danger">{{ error }}</NoticeBox>
    </div>
    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="sending" @click="emit('cancel')">取消</button>
      <button type="button" class="btn btn-primary" :disabled="sending || policy === null" data-test="route-confirm-submit" @click="emit('confirm')">
        <Spinner v-if="sending" color="white" decorative />
        {{ confirmText }}
      </button>
    </template>
  </BaseDialog>
</template>
