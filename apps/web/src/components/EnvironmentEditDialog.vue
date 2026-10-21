<script setup lang="ts">
// 环境新建/编辑弹窗：所有字段；秘密按 SecretChange 语义（保持不变 / 替换 / 清除），从不预填或显示；
// 提交后由父组件调用接口。秘密只在本组件内存中，关闭或提交成功即清除，不保存草稿。
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import {
  SITES,
  SITE_CODES,
  type AccountDetail,
  type EnvironmentView,
  type FieldError,
  type FrontProxyId,
  type FrontProxyView,
  type SiteCode,
} from '@sfe/contract';
import { BaseDialog, SelectField, Spinner, TextField, type SelectOption } from '@sfe/easyquick';
import SecretField from './SecretField.vue';
import NoticeBox from './NoticeBox.vue';
import {
  buildChanges,
  buildCreateInput,
  clearSecrets,
  initialForm,
  normalizeFieldPath,
  validateForm,
  type BindingStage,
  type EnvironmentFormState,
  type EnvironmentSubmit,
} from '../lib/environment-form';
import { BINDING_STAGE_LABELS, FRONT_STATE_LABELS } from '../lib/labels';
import { envLabel, proxyAddress } from '../lib/environments';

const props = withDefaults(
  defineProps<{
    show: boolean;
    mode: 'create' | 'edit';
    environment?: EnvironmentView | null;
    account?: AccountDetail | null;
    frontProxies: FrontProxyView[];
    defaultFrontProxyId: FrontProxyId | null;
    requestId: string;
    submitting?: boolean;
    serverErrors?: FieldError[];
    formError?: string | null;
  }>(),
  { environment: null, account: null, submitting: false, serverErrors: () => [], formError: null },
);
const emit = defineEmits<{ submit: [payload: EnvironmentSubmit]; close: [] }>();

const form = reactive<EnvironmentFormState>(initialForm(null, null));
const localErrors = ref<FieldError[]>([]);

function reset() {
  Object.assign(form, initialForm(props.mode === 'edit' ? props.environment : null, props.account));
  localErrors.value = [];
}

watch(
  () => [props.show, props.environment?.id, props.mode] as const,
  ([show]) => {
    if (show) reset();
    else clearSecrets(form);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearSecrets(form));

const env = computed(() => (props.mode === 'edit' ? props.environment : null));
const rev = computed(() => env.value?.proxy.desired ?? env.value?.proxy.deployed ?? null);
const title = computed(() => (env.value ? `编辑 ${envLabel(env.value)}` : '新建环境'));

const errors = computed(() => {
  const map = new Map<string, string>();
  for (const e of [...props.serverErrors, ...localErrors.value]) {
    const key = normalizeFieldPath(e.field);
    if (!map.has(key)) map.set(key, e.message);
  }
  return map;
});
const KNOWN_FIELDS = new Set([
  'displayName',
  'site',
  'proxy.host',
  'proxy.port',
  'proxy.username',
  'proxy.password',
  'proxy.frontProxyId',
  'proxy.expectedExitIp',
  'account.label',
  'account.loginIdentifier',
  'account.password',
]);
const otherErrors = computed(() => [...errors.value.entries()].filter(([k]) => !KNOWN_FIELDS.has(k)));
const err = (field: string) => errors.value.get(field) ?? null;

const siteOptions = computed<SelectOption<SiteCode>[]>(() => SITE_CODES.map((code) => ({ value: code, label: SITES[code].label })));

const frontOptions = computed<SelectOption<FrontProxyId | null>[]>(() => {
  const def = props.frontProxies.find((f) => f.id === props.defaultFrontProxyId) ?? null;
  const opts: SelectOption<FrontProxyId | null>[] = [
    {
      value: null,
      label: def ? `使用默认前置（${def.surgeName}）` : '使用默认前置（尚未设置）',
      description: '保存时记录为当时的默认前置，之后修改默认值不影响此环境。',
    },
  ];
  for (const f of props.frontProxies) {
    if (f.retired && f.id !== form.frontProxyId) continue;
    opts.push({ value: f.id, label: f.surgeName, description: `${FRONT_STATE_LABELS[f.state].label}${f.isDefault ? ' · 默认' : ''}`, disabled: f.retired });
  }
  return opts;
});

const stageOptions = computed<SelectOption<BindingStage | null>[]>(() => [
  { value: null, label: '未开始' },
  ...(Object.keys(BINDING_STAGE_LABELS) as BindingStage[]).map((k) => ({ value: k, label: BINDING_STAGE_LABELS[k] })),
]);

function submit() {
  const local = validateForm(form, props.mode);
  if (props.mode === 'edit' && env.value && local.length === 0) {
    const changes = buildChanges(form, env.value, props.account ? (props.account.loginIdentifier ?? '') : null);
    if (Object.keys(changes).length === 0) local.push({ field: 'form', message: '没有需要保存的修改' });
    localErrors.value = local;
    if (local.length) return;
    emit('submit', { kind: 'update', environmentId: env.value.id, request: { request_id: props.requestId, expected_revision: env.value.revision, changes } });
    return;
  }
  localErrors.value = local;
  if (local.length) return;
  emit('submit', { kind: 'create', request: { request_id: props.requestId, environment: buildCreateInput(form) } });
}
</script>

<template>
  <BaseDialog :show="show" :title="title" width="wide" @close="emit('close')">
    <form class="space-y-6" novalidate data-test="env-form" @submit.prevent="submit">
      <NoticeBox v-if="formError" tone="danger">{{ formError }}</NoticeBox>
      <NoticeBox v-for="[field, message] in otherErrors" :key="field" tone="danger">{{ message }}</NoticeBox>

      <section class="space-y-4">
        <h4 class="text-sm font-semibold text-gray-900 dark:text-white">基本信息</h4>
        <div class="grid gap-4 sm:grid-cols-2">
          <TextField
            v-model="form.displayName"
            label="环境名称"
            required
            :error="err('displayName')"
            hint="建议与 Safari 场景名称一致；改名不影响绑定。"
            data-field="displayName"
          />
          <SelectField v-model="form.site" label="站点" required :options="siteOptions" :error="err('site')" hint="首版只支持 Amazon 美国站。" />
        </div>
      </section>

      <section class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <h4 class="text-sm font-semibold text-gray-900 dark:text-white">代理出口</h4>
          <span v-if="env?.proxy.active" class="text-xs text-gray-500 dark:text-dark-400">当前使用：{{ proxyAddress(env.proxy.active) }}</span>
        </div>
        <div class="grid gap-4 sm:grid-cols-3">
          <div class="sm:col-span-2">
            <TextField v-model="form.host" label="代理地址" required mono :error="err('proxy.host')" placeholder="203.0.113.10" data-field="host" />
          </div>
          <TextField v-model="form.port" label="端口" required inputmode="numeric" :error="err('proxy.port')" placeholder="1080" data-field="port" />
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <TextField model-value="SOCKS5" label="协议" disabled hint="首版只支持 SOCKS5。" />
          <SelectField v-model="form.frontProxyId" label="前置代理" :options="frontOptions" :error="err('proxy.frontProxyId')" hint="链路：本机 → 前置 → 环境 SOCKS5 → 网站；前置不可用时连接失败，不会直连。" />
          <SecretField
            v-model:action="form.proxyUsername.action"
            v-model:value="form.proxyUsername.value"
            label="代理用户名"
            input-type="text"
            :mode="mode"
            :configured="rev?.hasUsername ?? false"
            :error="err('proxy.username')"
          />
          <SecretField
            v-model:action="form.proxyPassword.action"
            v-model:value="form.proxyPassword.value"
            label="代理密码"
            :mode="mode"
            :configured="rev?.hasPassword ?? false"
            :error="err('proxy.password')"
            hint="只能包含字母、数字和 . _ ~ -。"
          />
        </div>
        <TextField
          v-model="form.expectedExitIp"
          label="预期出口 IP"
          mono
          :error="err('proxy.expectedExitIp')"
          hint="可选。用于核对 Safari 实测出口；代理连接地址不会被当作预期出口。只改它不会产生新节点版本。"
          data-field="expectedExitIp"
        />
      </section>

      <section class="space-y-4">
        <h4 class="text-sm font-semibold text-gray-900 dark:text-white">买家账号</h4>
        <div class="grid gap-4 sm:grid-cols-2">
          <TextField v-model="form.accountLabel" label="买家号备注" :error="err('account.label')" />
          <TextField
            v-model="form.loginIdentifier"
            label="登录账号"
            type="email"
            :error="err('account.loginIdentifier')"
            :placeholder="mode === 'edit' && !account && env?.account.loginIdentifierMasked ? env.account.loginIdentifierMasked : undefined"
            :hint="mode === 'edit' && !account && env?.account.hasLoginIdentifier ? '没能读取完整账号：留空表示不修改。' : '修改账号不会改变网页已登录的身份。'"
          />
          <SecretField
            v-model:action="form.accountPassword.action"
            v-model:value="form.accountPassword.value"
            label="账号密码"
            :mode="mode"
            :configured="env?.account.hasPassword ?? false"
            :error="err('account.password')"
            hint="保存到钥匙串；网页与日志从不显示。"
          />
        </div>
      </section>

      <section class="space-y-3">
        <h4 class="text-sm font-semibold text-gray-900 dark:text-white">选项</h4>
        <label class="flex cursor-pointer items-start gap-3">
          <input v-model="form.autoOpenOrders" type="checkbox" class="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-600 dark:bg-dark-800" data-field="autoOpenOrders" />
          <span>
            <span class="block text-sm font-medium text-gray-900 dark:text-white">自动打开订单</span>
            <span class="block text-xs text-gray-500 dark:text-dark-400">出口经 Safari 实测后打开或定位订单页；已登录不进入登录流程。默认开启。</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-3">
          <input v-model="form.autoFillLogin" type="checkbox" class="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-600 dark:bg-dark-800" data-field="autoFillLogin" />
          <span>
            <span class="block text-sm font-medium text-gray-900 dark:text-white">登录页自动填充</span>
            <span class="block text-xs text-gray-500 dark:text-dark-400">只在 Amazon 登录页实际出现对应字段时填充，从不自动提交。默认关闭。</span>
          </span>
        </label>
      </section>

      <section v-if="mode === 'edit' && env?.binding.state === 'unbound'" class="space-y-3">
        <h4 class="text-sm font-semibold text-gray-900 dark:text-white">首次关联</h4>
        <SelectField v-model="form.bindingStage" label="关联进度" :options="stageOptions" hint="你已完成的步骤；不是系统检测结果。" />
      </section>
    </form>
    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="submitting" @click="emit('close')">取消</button>
      <button type="button" class="btn btn-primary" :disabled="submitting" data-test="env-save" @click="submit">
        <Spinner v-if="submitting" color="white" decorative />
        保存
      </button>
    </template>
  </BaseDialog>
</template>
