<script setup lang="ts">
// 在当前场景创建环境并关联。代理与账号秘密只在本组件内存中，提交或关闭时清空，不存草稿。
import { onBeforeUnmount, reactive, ref } from 'vue';
import { SITES, SITE_CODES, type EnvironmentInput, type FieldError, type SiteCode } from '@sfe/contract';
import { fieldError, parsePort } from '../ui/fields';
import type { PopupController } from './controller';

const props = defineProps<{ controller: PopupController }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const form = reactive({
  displayName: '',
  site: '' as SiteCode | '',
  host: '',
  port: '',
  expectedExitIp: '',
  accountLabel: '',
  autoOpenOrders: true,
  autoFillLogin: false,
});
// 秘密与登录账号：只在内存中。
const secrets = reactive({ proxyUsername: '', proxyPassword: '', loginIdentifier: '', accountPassword: '' });

const errors = ref<FieldError[]>([]);
const formError = ref<string | null>(null);
const saving = ref(false);

function wipeSecrets() {
  secrets.proxyUsername = '';
  secrets.proxyPassword = '';
  secrets.loginIdentifier = '';
  secrets.accountPassword = '';
}

function localValidate(): FieldError[] {
  const out: FieldError[] = [];
  if (!form.displayName.trim()) out.push({ field: 'displayName', message: '环境名称必填' });
  if (!form.site) out.push({ field: 'site', message: '站点必须明确选择' });
  if (!form.host.trim()) out.push({ field: 'proxy.host', message: '代理地址必填' });
  if (parsePort(form.port) === null) out.push({ field: 'proxy.port', message: '端口必须是 1–65535 的整数' });
  return out;
}

function buildInput(): EnvironmentInput {
  const input: EnvironmentInput = {
    displayName: form.displayName.trim(),
    site: form.site as SiteCode,
    autoOpenOrders: form.autoOpenOrders,
    autoFillLogin: form.autoFillLogin,
    proxy: {
      protocol: 'socks5',
      host: form.host.trim(),
      port: parsePort(form.port) ?? 0,
      frontProxyId: null,
      expectedExitIp: form.expectedExitIp.trim() || null,
    },
  };
  if (secrets.proxyUsername) input.proxy.username = { action: 'replace', value: secrets.proxyUsername };
  if (secrets.proxyPassword) input.proxy.password = { action: 'replace', value: secrets.proxyPassword };
  const label = form.accountLabel.trim();
  if (label || secrets.loginIdentifier || secrets.accountPassword) {
    input.account = {
      label: label || null,
      loginIdentifier: secrets.loginIdentifier.trim() || null,
    };
    if (secrets.accountPassword) input.account.password = { action: 'replace', value: secrets.accountPassword };
  }
  return input;
}

async function submit() {
  formError.value = null;
  errors.value = localValidate();
  if (errors.value.length) return;
  const input = buildInput();
  // 载荷已交给提交流程；表单里的秘密立即清空，失败时需要重新输入。
  wipeSecrets();
  saving.value = true;
  try {
    const result = await props.controller.createEnvironment(input);
    if (result.ok) {
      emit('saved');
      return;
    }
    formError.value = result.error.message;
    errors.value = result.error.fieldErrors ?? [];
  } finally {
    saving.value = false;
  }
}

function close() {
  wipeSecrets();
  emit('close');
}

onBeforeUnmount(wipeSecrets);
</script>

<template>
  <form class="card" data-test="create-form" autocomplete="off" @submit.prevent="submit">
    <div class="card-header px-4 py-3">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">在此创建环境</h3>
      <p class="mt-0.5 text-xs text-gray-500 dark:text-dark-400">保存后关联当前 Safari 场景，并开始同步到 Surge。</p>
    </div>
    <div class="card-body space-y-3 p-4">
      <p v-if="formError" role="alert" class="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" data-test="form-error">{{ formError }}</p>
      <div>
        <label class="input-label">环境名称 <span class="text-red-500">*</span></label>
        <input v-model="form.displayName" class="input" :class="{ 'input-error': fieldError(errors, 'displayName') }" data-test="create-name" maxlength="64" />
        <p v-if="fieldError(errors, 'displayName')" class="input-error-text mt-1.5">{{ fieldError(errors, 'displayName') }}</p>
        <p v-else class="input-hint mt-1.5">建议与 Safari 场景名称一致</p>
      </div>
      <div>
        <label class="input-label">站点 <span class="text-red-500">*</span></label>
        <select v-model="form.site" class="input" :class="{ 'input-error': fieldError(errors, 'site') }" data-test="create-site">
          <option value="" disabled>请选择站点</option>
          <option v-for="code in SITE_CODES" :key="code" :value="code">{{ SITES[code].label }}</option>
        </select>
        <p v-if="fieldError(errors, 'site')" class="input-error-text mt-1.5">{{ fieldError(errors, 'site') }}</p>
      </div>
      <div class="grid grid-cols-3 gap-2">
        <div class="col-span-2">
          <label class="input-label">SOCKS5 地址 <span class="text-red-500">*</span></label>
          <input v-model="form.host" class="input" :class="{ 'input-error': fieldError(errors, 'proxy.host') }" data-test="create-host" spellcheck="false" />
        </div>
        <div>
          <label class="input-label">端口 <span class="text-red-500">*</span></label>
          <input v-model="form.port" class="input" :class="{ 'input-error': fieldError(errors, 'proxy.port') }" inputmode="numeric" data-test="create-port" />
        </div>
      </div>
      <p v-if="fieldError(errors, 'proxy.host') || fieldError(errors, 'proxy.port')" class="input-error-text">
        {{ fieldError(errors, 'proxy.host') ?? fieldError(errors, 'proxy.port') }}
      </p>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="input-label">代理用户名</label>
          <input v-model="secrets.proxyUsername" class="input" type="text" autocomplete="off" spellcheck="false" data-test="create-proxy-username" />
        </div>
        <div>
          <label class="input-label">代理密码</label>
          <input v-model="secrets.proxyPassword" class="input" type="password" autocomplete="off" data-test="create-proxy-password" />
        </div>
      </div>
      <p v-if="fieldError(errors, 'proxy.username') || fieldError(errors, 'proxy.password')" class="input-error-text">
        {{ fieldError(errors, 'proxy.username') ?? fieldError(errors, 'proxy.password') }}
      </p>
      <p class="input-hint">前置代理使用网页后台设置的默认前置。</p>
      <div>
        <label class="input-label">预期出口 IP</label>
        <input v-model="form.expectedExitIp" class="input" spellcheck="false" data-test="create-exit-ip" />
        <p v-if="fieldError(errors, 'proxy.expectedExitIp')" class="input-error-text mt-1.5">{{ fieldError(errors, 'proxy.expectedExitIp') }}</p>
        <p v-else class="input-hint mt-1.5">可选。代理地址不会被当作预期出口。</p>
      </div>
      <div>
        <label class="input-label">买家号备注</label>
        <input v-model="form.accountLabel" class="input" maxlength="64" data-test="create-account-label" />
      </div>
      <div>
        <label class="input-label">登录邮箱或手机号</label>
        <input v-model="secrets.loginIdentifier" class="input" type="text" autocomplete="off" spellcheck="false" data-test="create-login-identifier" />
      </div>
      <div>
        <label class="input-label">登录密码</label>
        <input v-model="secrets.accountPassword" class="input" type="password" autocomplete="off" data-test="create-account-password" />
        <p v-if="fieldError(errors, 'account.password')" class="input-error-text mt-1.5">{{ fieldError(errors, 'account.password') }}</p>
        <p v-else class="input-hint mt-1.5">保存到钥匙串，不在扩展中保存。</p>
      </div>
      <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input v-model="form.autoOpenOrders" type="checkbox" class="h-4 w-4 rounded" data-test="create-auto-open" />
        出口检测通过后自动打开订单页
      </label>
      <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input v-model="form.autoFillLogin" type="checkbox" class="h-4 w-4 rounded" data-test="create-auto-fill" />
        登录页出现时自动填充账号（不自动提交）
      </label>
    </div>
    <div class="card-footer flex justify-end gap-2 px-4 py-3">
      <button type="button" class="btn btn-secondary btn-sm" :disabled="saving" data-test="create-cancel" @click="close">取消</button>
      <button type="submit" class="btn btn-primary btn-sm" :disabled="saving" data-test="create-submit">
        <span v-if="saving" class="spinner h-4 w-4 text-white" role="status" aria-label="加载中"></span>
        保存
      </button>
    </div>
  </form>
</template>
