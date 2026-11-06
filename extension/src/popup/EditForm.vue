<script setup lang="ts">
// 编辑当前环境：只发送修改了的字段（PATCH 语义），秘密字段按 SecretChange 的
// 保留 / 替换 / 清除发送；秘密只在本组件内存中，提交或关闭时清空，从不写入存储。
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import {
  SITES,
  SITE_CODES,
  type AccountInput,
  type EnvironmentChanges,
  type EnvironmentView,
  type FieldError,
  type ProxyInput,
  type SiteCode,
} from '@sfe/contract';
import SecretField from '../ui/SecretField.vue';
import { draftToChange, keepDraft, wipeDraft } from '../ui/secret';
import { fieldError, parsePort } from '../ui/fields';
import type { PopupController } from './controller';

const props = defineProps<{ controller: PopupController; environment: EnvironmentView }>();
const emit = defineEmits<{ close: []; saved: [] }>();

// 表单基于打开时的快照；保存时带上这个版本，期间被其他界面修改会得到冲突而不是覆盖。
const env = props.environment;
const baseRevision = env.revision;
const base = env.proxy.desired ?? env.proxy.deployed ?? env.proxy.active;

const form = reactive({
  displayName: env.displayName,
  site: env.site as SiteCode,
  host: base?.host ?? '',
  port: base ? String(base.port) : '',
  expectedExitIp: env.expectedExitIp ?? '',
  accountLabel: env.account.label ?? '',
  autoOpenOrders: env.autoOpenOrders,
  autoFillLogin: env.autoFillLogin,
});
const drafts = reactive({
  proxyUsername: keepDraft(),
  proxyPassword: keepDraft(),
  loginIdentifier: keepDraft(),
  accountPassword: keepDraft(),
});

const errors = ref<FieldError[]>([]);
const formError = ref<string | null>(null);
const saving = ref(false);

const identifierHint = computed(() =>
  env.account.loginIdentifierMasked ? `已配置：${env.account.loginIdentifierMasked}，保持不变` : null,
);

function wipeAll() {
  wipeDraft(drafts.proxyUsername);
  wipeDraft(drafts.proxyPassword);
  wipeDraft(drafts.loginIdentifier);
  wipeDraft(drafts.accountPassword);
}

/** 按当前视图计算修改；无法解析的输入返回字段错误。 */
function buildChanges(): { changes: EnvironmentChanges; errors: FieldError[] } {
  const out: FieldError[] = [];
  const changes: EnvironmentChanges = {};
  const name = form.displayName.trim();
  if (!name) out.push({ field: 'displayName', message: '环境名称必填' });
  else if (name !== env.displayName) changes.displayName = name;
  if (form.site !== env.site) changes.site = form.site;
  if (form.autoOpenOrders !== env.autoOpenOrders) changes.autoOpenOrders = form.autoOpenOrders;
  if (form.autoFillLogin !== env.autoFillLogin) changes.autoFillLogin = form.autoFillLogin;

  const proxy: Partial<ProxyInput> = {};
  const host = form.host.trim();
  if (!host) out.push({ field: 'proxy.host', message: '代理地址必填' });
  else if (host !== base?.host) proxy.host = host;
  const port = parsePort(form.port);
  if (port === null) out.push({ field: 'proxy.port', message: '端口必须是 1–65535 的整数' });
  else if (port !== base?.port) proxy.port = port;
  const usernameChange = draftToChange(drafts.proxyUsername);
  const passwordChange = draftToChange(drafts.proxyPassword);
  Object.assign(proxy, usernameChange && { username: usernameChange }, passwordChange && { password: passwordChange });
  const exitIp = form.expectedExitIp.trim() || null;
  if (exitIp !== (env.expectedExitIp ?? null)) proxy.expectedExitIp = exitIp;
  if (Object.keys(proxy).length) changes.proxy = proxy;

  const account: AccountInput = {};
  const label = form.accountLabel.trim() || null;
  if (label !== (env.account.label ?? null)) account.label = label;
  const identifier = draftToChange(drafts.loginIdentifier);
  if (identifier?.action === 'replace' && identifier.value.trim()) account.loginIdentifier = identifier.value.trim();
  else if (identifier?.action === 'clear') account.loginIdentifier = null;
  const accountPasswordChange = draftToChange(drafts.accountPassword);
  Object.assign(account, accountPasswordChange && { password: accountPasswordChange });
  if (Object.keys(account).length) changes.account = account;

  if (!out.length && Object.keys(changes).length === 0) out.push({ field: 'changes', message: '没有需要保存的修改' });
  return { changes, errors: out };
}

async function submit() {
  formError.value = null;
  const built = buildChanges();
  errors.value = built.errors;
  if (built.errors.length) {
    const general = built.errors.find((e) => e.field === 'changes');
    if (general) formError.value = general.message;
    return;
  }
  // 载荷已交给提交流程；表单里的秘密立即清空，失败时需要重新输入。
  wipeAll();
  saving.value = true;
  try {
    const result = await props.controller.updateEnvironment(built.changes, baseRevision);
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
  wipeAll();
  emit('close');
}

onBeforeUnmount(wipeAll);
</script>

<template>
  <form class="card" data-test="edit-form" autocomplete="off" @submit.prevent="submit">
    <div class="card-header px-4 py-3">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">编辑环境</h3>
      <p class="mt-0.5 text-xs text-gray-500 dark:text-dark-400">修改代理会生成新版本；当前使用的环境需要重新切换并检测后才生效。</p>
    </div>
    <div class="card-body space-y-3 p-4">
      <p v-if="formError" role="alert" class="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" data-test="form-error">{{ formError }}</p>
      <div>
        <label class="input-label">环境名称 <span class="text-red-500">*</span></label>
        <input v-model="form.displayName" class="input" :class="{ 'input-error': fieldError(errors, 'displayName') }" maxlength="64" data-test="edit-name" />
        <p v-if="fieldError(errors, 'displayName')" class="input-error-text mt-1.5">{{ fieldError(errors, 'displayName') }}</p>
      </div>
      <div>
        <label class="input-label">站点</label>
        <select v-model="form.site" class="input" data-test="edit-site">
          <option v-for="code in SITE_CODES" :key="code" :value="code">{{ SITES[code].label }}</option>
        </select>
      </div>
      <div class="grid grid-cols-3 gap-2">
        <div class="col-span-2">
          <label class="input-label">SOCKS5 地址</label>
          <input v-model="form.host" class="input" :class="{ 'input-error': fieldError(errors, 'proxy.host') }" spellcheck="false" data-test="edit-host" />
        </div>
        <div>
          <label class="input-label">端口</label>
          <input v-model="form.port" class="input" :class="{ 'input-error': fieldError(errors, 'proxy.port') }" inputmode="numeric" data-test="edit-port" />
        </div>
      </div>
      <p v-if="fieldError(errors, 'proxy.host') || fieldError(errors, 'proxy.port')" class="input-error-text">
        {{ fieldError(errors, 'proxy.host') ?? fieldError(errors, 'proxy.port') }}
      </p>
      <SecretField
        v-model="drafts.proxyUsername"
        name="proxy-username"
        label="代理用户名"
        input-type="text"
        :configured="!!base?.hasUsername"
        :error="fieldError(errors, 'proxy.username')"
      />
      <SecretField
        v-model="drafts.proxyPassword"
        name="proxy-password"
        label="代理密码"
        :configured="!!base?.hasPassword"
        :error="fieldError(errors, 'proxy.password')"
      />
      <div>
        <label class="input-label">预期出口 IP</label>
        <input v-model="form.expectedExitIp" class="input" spellcheck="false" data-test="edit-exit-ip" />
        <p v-if="fieldError(errors, 'proxy.expectedExitIp')" class="input-error-text mt-1.5">{{ fieldError(errors, 'proxy.expectedExitIp') }}</p>
        <p v-else class="input-hint mt-1.5">只改预期出口不会生成新版本；与最近一次实测不符时停止自动打开与填充。</p>
      </div>
      <div>
        <label class="input-label">买家号备注</label>
        <input v-model="form.accountLabel" class="input" maxlength="64" data-test="edit-account-label" />
      </div>
      <SecretField
        v-model="drafts.loginIdentifier"
        name="login-identifier"
        label="登录邮箱或手机号"
        input-type="text"
        :configured="env.account.hasLoginIdentifier"
        :configured-hint="identifierHint"
        :error="fieldError(errors, 'account.loginIdentifier')"
      />
      <SecretField
        v-model="drafts.accountPassword"
        name="account-password"
        label="登录密码"
        :configured="env.account.hasPassword"
        :error="fieldError(errors, 'account.password')"
      />
      <p class="input-hint">修改买家号不会登出已登录的网页，也不改变代理规则。</p>
      <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input v-model="form.autoOpenOrders" type="checkbox" class="h-4 w-4 rounded" data-test="edit-auto-open" />
        出口检测通过后自动打开订单页
      </label>
      <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input v-model="form.autoFillLogin" type="checkbox" class="h-4 w-4 rounded" data-test="edit-auto-fill" />
        登录页出现时自动填充账号（不自动提交）
      </label>
    </div>
    <div class="card-footer flex justify-end gap-2 px-4 py-3">
      <button type="button" class="btn btn-secondary btn-sm" :disabled="saving" data-test="edit-cancel" @click="close">取消</button>
      <button type="submit" class="btn btn-primary btn-sm" :disabled="saving" data-test="edit-submit">
        <span v-if="saving" class="spinner h-4 w-4 text-white" role="status" aria-label="加载中"></span>
        保存
      </button>
    </div>
  </form>
</template>
