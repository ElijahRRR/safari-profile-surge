<script setup lang="ts">
// 设置：只有可编辑的设置可以修改——检测服务（只在普通模式下）、默认前置与超时。
// 入口策略与 Safari 进程路径来自已确认的能力证据，Surge CLI 路径来自安装配置，工作配置路径来自
// 维护初始化，这里只读显示。
import { computed, reactive, ref, watch } from 'vue';
import { VERIFY_ENDPOINTS, type FrontProxyId, type UpdateSettingsRequest } from '@sfe/contract';
import { ConfirmDialog, PageHeader, SelectField, Spinner, TextField, type SelectOption } from '@sfe/easyquick';
import KeyValueList from '../components/KeyValueList.vue';
import NoticeBox from '../components/NoticeBox.vue';
import { useConsole } from '../store/context';
import { isApiError } from '../api/client';
import { ENTRY_STRATEGY_LABELS } from '../lib/labels';
import { formatSeconds } from '../lib/format';
import { newRequestId } from '../lib/request-id';

const { api, store, toasts } = useConsole();
const settings = computed(() => store.settings.value);
const entryNormal = computed(() => store.route.value?.entryMode === 'NORMAL');

const TIMEOUTS = [
  { key: 'profileArrivalTimeoutSec', label: '等待场景打开', hint: '激活后等待目标场景点击扩展图标的最长时间；超时会恢复原节点并保持阻断。' },
  { key: 'safariVerifyTimeoutSec', label: 'Safari 实测超时', hint: '准备页开始检测后等待提交结果的最长时间。' },
  { key: 'probeTtlSec', label: '实测有效期', hint: '超过后实测显示为「上次结果」，需要重新检测。' },
  { key: 'reconcileIntervalSec', label: '对账间隔', hint: '路由不空闲时只读核对 Surge 状态的间隔。默认 30 秒。' },
] as const;
type TimeoutKey = (typeof TIMEOUTS)[number]['key'];

const form = reactive({
  verifyEndpointId: '',
  defaultFrontProxyId: null as FrontProxyId | null,
  profileArrivalTimeoutSec: '',
  safariVerifyTimeoutSec: '',
  probeTtlSec: '',
  reconcileIntervalSec: '',
});
const errors = ref<Record<string, string>>({});
const saving = ref(false);
const confirmEndpoint = ref(false);

function reset() {
  const s = settings.value;
  if (!s) return;
  Object.assign(form, {
    verifyEndpointId: s.verifyEndpointId,
    defaultFrontProxyId: s.defaultFrontProxyId,
    profileArrivalTimeoutSec: String(s.profileArrivalTimeoutSec),
    safariVerifyTimeoutSec: String(s.safariVerifyTimeoutSec),
    probeTtlSec: String(s.probeTtlSec),
    reconcileIntervalSec: String(s.reconcileIntervalSec),
  });
  errors.value = {};
}
watch(settings, reset, { immediate: true });

const description = computed(() => {
  const s = settings.value;
  if (!s) return '正在读取设置';
  const ep = VERIFY_ENDPOINTS.find((e) => e.id === s.verifyEndpointId);
  return `检测服务：${ep?.label ?? s.verifyEndpointId}，实测有效期 ${formatSeconds(s.probeTtlSec)}`;
});

const endpointOptions = computed<SelectOption<string>[]>(() => VERIFY_ENDPOINTS.map((e) => ({ value: e.id, label: e.label, description: e.host })));
const frontOptions = computed<SelectOption<FrontProxyId | null>[]>(() => [
  { value: null, label: '不设置' },
  ...store.frontProxies.value.filter((f) => !f.retired).map((f) => ({ value: f.id, label: f.surgeName })),
]);

function buildRequest(): UpdateSettingsRequest | null {
  const s = settings.value;
  if (!s) return null;
  const req: UpdateSettingsRequest = { request_id: newRequestId() };
  const errs: Record<string, string> = {};
  if (form.verifyEndpointId !== s.verifyEndpointId) req.verifyEndpointId = form.verifyEndpointId;
  if (form.defaultFrontProxyId !== s.defaultFrontProxyId) req.defaultFrontProxyId = form.defaultFrontProxyId;
  for (const t of TIMEOUTS) {
    const text = form[t.key].trim();
    if (!/^\d{1,6}$/.test(text) || Number(text) < 1) {
      errs[t.key] = '请输入大于 0 的整数秒数';
      continue;
    }
    const n = Number(text);
    if (n !== s[t.key]) req[t.key as TimeoutKey] = n;
  }
  errors.value = errs;
  if (Object.keys(errs).length) return null;
  return req;
}

const dirty = computed(() => {
  const s = settings.value;
  if (!s) return false;
  return (
    form.verifyEndpointId !== s.verifyEndpointId ||
    form.defaultFrontProxyId !== s.defaultFrontProxyId ||
    TIMEOUTS.some((t) => form[t.key].trim() !== String(s[t.key]))
  );
});

function save() {
  const req = buildRequest();
  if (!req) return;
  if (req.verifyEndpointId !== undefined) {
    confirmEndpoint.value = true;
    return;
  }
  void submit(req);
}

async function submit(req: UpdateSettingsRequest | null = buildRequest()) {
  confirmEndpoint.value = false;
  if (!req) return;
  saving.value = true;
  try {
    store.setSettings(await api.updateSettings(req));
    toasts.success('设置已保存');
  } catch (e) {
    if (isApiError(e) && e.fieldErrors?.length) {
      errors.value = Object.fromEntries(e.fieldErrors.map((f) => [f.field, f.message]));
    }
    toasts.error(e instanceof Error ? e.message : '保存设置失败');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <PageHeader title="设置" :description="description" />
    <div v-if="settings" class="space-y-6">
      <div class="card">
        <div class="card-header"><h3 class="text-base font-semibold text-gray-900 dark:text-white">可修改的设置</h3></div>
        <div class="card-body space-y-5">
          <SelectField
            v-model="form.verifyEndpointId"
            label="出口检测服务"
            :options="endpointOptions"
            :disabled="!entryNormal"
            :hint="entryNormal ? '只能从固定列表中选择；更换后已有的 Safari 实测全部视为过期。' : '只能在普通模式下修改：当前有托管环境或入口不是普通模式。'"
            data-test="verify-endpoint"
          />
          <SelectField v-model="form.defaultFrontProxyId" label="默认前置" :options="frontOptions" hint="新建环境未指定前置时使用；保存时记录为具体前置，之后修改默认值不影响已有环境。" />
          <div class="grid gap-4 sm:grid-cols-2">
            <TextField
              v-for="t in TIMEOUTS"
              :key="t.key"
              v-model="form[t.key]"
              :label="`${t.label}（秒）`"
              inputmode="numeric"
              :error="errors[t.key] ?? null"
              :hint="`${t.hint} 当前 ${formatSeconds(settings[t.key])}。`"
            />
          </div>
        </div>
        <div class="card-footer flex justify-end gap-3">
          <button type="button" class="btn btn-secondary" :disabled="!dirty || saving" @click="reset">还原</button>
          <button type="button" class="btn btn-primary" :disabled="!dirty || saving" data-test="settings-save" @click="save">
            <Spinner v-if="saving" color="white" decorative />保存
          </button>
        </div>
      </div>

      <div class="card" data-test="readonly-settings">
        <div class="card-header"><h3 class="text-base font-semibold text-gray-900 dark:text-white">只读信息</h3></div>
        <div class="card-body space-y-4">
          <KeyValueList
            :items="[
              { key: 'strategy', label: '入口策略' },
              { key: 'paths', label: 'Safari 进程路径' },
              { key: 'cli', label: 'Surge CLI 路径' },
              { key: 'profile', label: '工作配置路径' },
            ]"
          >
            <template #v-strategy>{{ settings.entryStrategy ? ENTRY_STRATEGY_LABELS[settings.entryStrategy] : '尚未确认' }}</template>
            <template #v-paths>
              <ul v-if="settings.safariProcessPaths.length" class="space-y-1">
                <li v-for="p in settings.safariProcessPaths" :key="p" class="font-mono text-xs">{{ p }}</li>
              </ul>
              <span v-else>尚未确认</span>
            </template>
            <template #v-cli><span class="font-mono text-xs">{{ settings.surgeCliPath ?? '未配置' }}</span></template>
            <template #v-profile><span class="font-mono text-xs">{{ settings.workingProfilePath ?? '未初始化' }}</span></template>
          </KeyValueList>
          <ul class="list-disc space-y-1.5 pl-5 text-xs text-gray-500 dark:text-dark-400">
            <li>入口策略与 Safari 进程路径只来自经你确认的 P0 实测证据，不能在这里修改。确认新的路径或策略会让依赖它们的能力回到待验证。</li>
            <li>Surge CLI 路径来自安装时写入的本机配置文件，并核对其签名。</li>
            <li>工作配置路径只能由「发布与 Surge」中的初始化设置；首版更换工作配置需要卸载并清空数据后重新初始化。</li>
          </ul>
        </div>
      </div>
    </div>
    <NoticeBox v-else tone="info">正在读取设置。</NoticeBox>

    <ConfirmDialog
      :show="confirmEndpoint"
      title="更换检测服务"
      message="确定要更换出口检测服务吗？"
      confirm-text="更换"
      @confirm="submit()"
      @cancel="confirmEndpoint = false"
    >
      <p>更换后已有的 Safari 实测全部视为过期，需要在各场景重新检测。</p>
    </ConfirmDialog>
  </div>
</template>
