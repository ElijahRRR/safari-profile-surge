<script setup lang="ts">
// 导入：选择文件（CSV/XLSX/JSON，只在浏览器内读取）→ 预览差异与冲突 → 逐行决定 → 提交。
// 同名冲突必须逐行选择（新建 / 更新到某个环境 / 跳过），从不按名称自动更新。
// 文件内容含秘密，只保存在本页内存，提交成功或离开页面即清除。
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import {
  SITES,
  SITE_CODES,
  type FrontProxyId,
  type ImportCommitResult,
  type ImportFormat,
  type ImportPreview,
  type ImportPreviewRequest,
  type ImportRowDecision,
  type ImportRowPreview,
  type SiteCode,
} from '@sfe/contract';
import { Badge, ConfirmDialog, DataTable, Icon, PageHeader, SelectField, Spinner, Toggle, type SelectOption, type TableColumn } from '@sfe/easyquick';
import NoticeBox from '../components/NoticeBox.vue';
import { useConsole } from '../store/context';
import { isApiError } from '../api/client';
import { newRequestId } from '../lib/request-id';
import { IMPORT_STATUS_LABELS } from '../lib/labels';
import { MAX_IMPORT_BYTES, bytesToBase64, formatBytes, importFormatOf, parseJsonRecords, saveText } from '../lib/files';
import { formatCount } from '../lib/format';

const { api, store, toasts, viewer } = useConsole();

const file = reactive({ name: '', size: 0, format: null as ImportFormat | null, contentBase64: null as string | null, records: null as unknown[] | null, error: null as string | null });
const defaultSite = ref<SiteCode | null>(null);
const defaultFront = ref<FrontProxyId | null>(null);
const previewing = ref(false);
const committing = ref(false);
const preview = ref<ImportPreview | null>(null);
const decisions = reactive<Record<number, string>>({});
const result = ref<ImportCommitResult | null>(null);
const onlyActionable = ref(false);
const staleDialog = ref(false);
const commitRequestId = ref<string | null>(null);
// 提交必须与预览用同一份请求（摘要覆盖文件内容与默认选项）；修改默认选项后需要重新预览。
const previewRequest = ref<ImportPreviewRequest | null>(null);

function clearContent() {
  file.contentBase64 = null;
  file.records = null;
  previewRequest.value = null;
}
onBeforeUnmount(clearContent);

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  preview.value = null;
  result.value = null;
  clearContent();
  Object.assign(file, { name: '', size: 0, format: null, error: null });
  if (!f) return;
  const format = importFormatOf(f.name);
  Object.assign(file, { name: f.name, size: f.size, format });
  if (!format) {
    file.error = '读取文件失败：只支持 .csv、.xlsx 与 .json';
    return;
  }
  if (f.size > MAX_IMPORT_BYTES) {
    file.error = `读取文件失败：文件超过 ${formatBytes(MAX_IMPORT_BYTES)}`;
    return;
  }
  try {
    if (format === 'json') file.records = parseJsonRecords(await f.text());
    else file.contentBase64 = bytesToBase64(new Uint8Array(await f.arrayBuffer()));
  } catch (e) {
    file.error = e instanceof Error ? e.message : '读取文件失败';
  }
}

function baseRequest(): ImportPreviewRequest | null {
  if (!file.format) return null;
  const req: ImportPreviewRequest = { format: file.format, default_front_proxy_id: defaultFront.value, default_site: defaultSite.value };
  if (file.format === 'json') {
    if (!file.records) return null;
    req.records = file.records;
  } else {
    if (!file.contentBase64) return null;
    req.content_base64 = file.contentBase64;
  }
  return req;
}

const canPreview = computed(() => !file.error && (file.contentBase64 !== null || file.records !== null) && !previewing.value);

function defaultDecision(row: ImportRowPreview): string | null {
  if (row.status === 'create') return 'create';
  if (row.status === 'update') return 'update';
  return null;
}

async function runPreview() {
  const req = baseRequest();
  if (!req) return;
  previewing.value = true;
  result.value = null;
  try {
    const p = await api.importPreview(req);
    preview.value = p;
    previewRequest.value = req;
    for (const k of Object.keys(decisions)) delete decisions[Number(k)];
    for (const row of p.rows) {
      const d = defaultDecision(row);
      if (d) decisions[row.row] = d;
    }
    commitRequestId.value = newRequestId();
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '预览失败');
  } finally {
    previewing.value = false;
  }
}

function decisionOptions(row: ImportRowPreview): SelectOption<string>[] {
  if (row.status === 'create') return [{ value: 'create', label: '新建' }, { value: 'skip', label: '跳过' }];
  if (row.status === 'update') return [{ value: 'update', label: '更新' }, { value: 'skip', label: '跳过' }];
  if (row.status === 'conflict') {
    return [
      { value: 'create', label: '新建' },
      ...row.conflictCandidates.map((c) => ({ value: `update:${c.environment_id}`, label: `更新到 ${c.label}` })),
      { value: 'skip', label: '跳过' },
    ];
  }
  return [];
}

const needsDecision = (row: ImportRowPreview) => row.status === 'create' || row.status === 'update' || row.status === 'conflict';
const undecided = computed(() => (preview.value?.rows ?? []).filter((r) => needsDecision(r) && !decisions[r.row]).length);
const visibleRows = computed(() => (preview.value?.rows ?? []).filter((r) => !onlyActionable.value || r.status === 'conflict' || r.status === 'invalid' || r.errors.length > 0));

function buildDecisions(p: ImportPreview): ImportRowDecision[] {
  const out: ImportRowDecision[] = [];
  for (const row of p.rows) {
    if (!needsDecision(row)) continue;
    const d = decisions[row.row];
    if (!d || d === 'skip') {
      out.push({ row: row.row, action: 'skip' });
    } else if (d === 'create') {
      out.push({ row: row.row, action: 'create' });
    } else if (d === 'update' && row.environment_id && row.current_revision !== null) {
      out.push({ row: row.row, action: 'update', environment_id: row.environment_id, expected_revision: row.current_revision });
    } else if (d.startsWith('update:')) {
      const id = d.slice('update:'.length);
      const cand = row.conflictCandidates.find((c) => c.environment_id === id);
      if (cand) out.push({ row: row.row, action: 'update', environment_id: cand.environment_id, expected_revision: cand.revision });
      else out.push({ row: row.row, action: 'skip' });
    } else {
      out.push({ row: row.row, action: 'skip' });
    }
  }
  return out;
}

async function commit() {
  const p = preview.value;
  const req = previewRequest.value;
  if (!p || !req || undecided.value > 0) return;
  committing.value = true;
  try {
    const res = await api.importCommit({ ...req, request_id: commitRequestId.value ?? newRequestId(), preview_digest: p.preview_digest, decisions: buildDecisions(p) });
    result.value = res;
    preview.value = null;
    previewRequest.value = null;
    clearContent();
    toasts.info('已受理：导入的环境正在处理，结果见下方列表');
  } catch (e) {
    if (isApiError(e) && e.code === 'PREVIEW_STALE') staleDialog.value = true;
    else toasts.error(e instanceof Error ? e.message : '导入失败');
  } finally {
    committing.value = false;
  }
}

async function rerunPreview() {
  staleDialog.value = false;
  await runPreview();
}

async function downloadTemplate() {
  try {
    saveText(await api.importTemplate(), 'sfe-import-template.csv');
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '下载模板失败');
  }
}

watch([defaultSite, defaultFront], () => {
  preview.value = null;
  previewRequest.value = null;
});

function reset() {
  preview.value = null;
  previewRequest.value = null;
  result.value = null;
  clearContent();
  Object.assign(file, { name: '', size: 0, format: null, error: null });
}

const siteOptions = computed<SelectOption<SiteCode | null>[]>(() => [
  { value: null, label: '不设置', description: '每行必须自带站点，否则该行无效；不会默认美国站。' },
  ...SITE_CODES.map((c) => ({ value: c, label: SITES[c].label })),
]);
const frontOptions = computed<SelectOption<FrontProxyId | null>[]>(() => [
  { value: null, label: '使用全局默认前置' },
  ...store.frontProxies.value.filter((f) => !f.retired).map((f) => ({ value: f.id, label: f.surgeName })),
]);

const previewColumns: TableColumn[] = [
  { key: 'row', label: '行' },
  { key: 'status', label: '状态' },
  { key: 'env', label: '环境' },
  { key: 'diff', label: '差异', wrap: true },
  { key: 'errors', label: '错误', wrap: true },
  { key: 'decision', label: '处理' },
];
const resultColumns: TableColumn[] = [
  { key: 'row', label: '行' },
  { key: 'status', label: '结果' },
  { key: 'env', label: '环境' },
  { key: 'detail', label: '说明', wrap: true },
  { key: 'op', label: '操作' },
];

function envName(id: string | null): string {
  if (!id) return '—';
  const env = store.environmentsById.value.get(id);
  return env ? `${env.displayName} · ${env.code}` : id;
}
</script>

<template>
  <div>
    <PageHeader title="导入" description="CSV、XLSX 或 JSON；文件只在本机读取，不会上传到其他地方">
      <template #actions>
        <button type="button" class="btn btn-secondary" @click="downloadTemplate"><Icon name="download" />下载模板</button>
      </template>
    </PageHeader>

    <div class="card">
      <div class="card-header"><h3 class="text-base font-semibold text-gray-900 dark:text-white">选择文件</h3></div>
      <div class="card-body space-y-5">
        <div class="flex flex-wrap items-center gap-3">
          <input id="import-file" type="file" class="sr-only" accept=".csv,.xlsx,.json" data-test="import-file" @change="onFileChange" />
          <label for="import-file" class="btn btn-secondary cursor-pointer"><Icon name="document" />选择文件</label>
          <span v-if="file.name" class="text-sm text-gray-700 dark:text-gray-300">{{ file.name }} · {{ formatBytes(file.size) }}</span>
          <span v-else class="text-sm text-gray-500 dark:text-dark-400">尚未选择文件</span>
        </div>
        <NoticeBox v-if="file.error" tone="danger">{{ file.error }}</NoticeBox>
        <div class="grid gap-4 sm:grid-cols-2">
          <SelectField v-model="defaultSite" label="默认站点" :options="siteOptions" hint="行内缺站点时使用。" />
          <SelectField v-model="defaultFront" label="默认前置" :options="frontOptions" hint="行内缺前置时使用；未登记的前置名会让该行无效，不会自动登记。" />
        </div>
        <p class="text-xs text-gray-500 dark:text-dark-400">表格只解析数据：不执行公式、宏或外部链接。更新时空的秘密字段表示保留，导入从不清除秘密。</p>
      </div>
      <div class="card-footer flex justify-end gap-3">
        <button v-if="file.name" type="button" class="btn btn-secondary" @click="reset">清除</button>
        <button type="button" class="btn btn-primary" :disabled="!canPreview" data-test="import-preview" @click="runPreview">
          <Spinner v-if="previewing" color="white" decorative />预览
        </button>
      </div>
    </div>

    <div v-if="preview" class="mt-6 space-y-4" data-test="import-preview-result">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="text-gray-700 dark:text-gray-300">共 {{ formatCount(preview.rows.length, '行') }}：</span>
          <Badge v-for="(n, status) in preview.totals" :key="status" :variant="IMPORT_STATUS_LABELS[status].variant">{{ IMPORT_STATUS_LABELS[status].label }} {{ n }}</Badge>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-sm text-gray-700 dark:text-gray-300">只看冲突与错误</span>
          <Toggle v-model="onlyActionable" label="只看冲突与错误" />
        </div>
      </div>
      <NoticeBox v-for="(fe, i) in preview.fileErrors" :key="i" tone="danger">{{ fe.field }}：{{ fe.message }}</NoticeBox>
      <DataTable :columns="previewColumns" :rows="visibleRows" :row-key="(r) => String(r.row)" caption="导入预览">
        <template #cell-row="{ row }"><span class="font-mono">{{ row.row }}</span></template>
        <template #cell-status="{ row }"><Badge :variant="IMPORT_STATUS_LABELS[row.status].variant">{{ IMPORT_STATUS_LABELS[row.status].label }}</Badge></template>
        <template #cell-env="{ row }">
          <div class="flex flex-col">
            <span class="font-medium">{{ row.displayName ?? '—' }}</span>
            <span v-if="row.environment_id" class="code mt-0.5 w-fit">{{ envName(row.environment_id) }}</span>
          </div>
        </template>
        <template #cell-diff="{ row }">
          <ul v-if="row.diff.length" class="min-w-[14rem] space-y-1 text-xs">
            <li v-for="d in row.diff" :key="d.field">
              <span class="text-gray-500 dark:text-dark-400">{{ d.field }}：</span>
              <span class="font-mono">{{ d.before ?? '空' }}</span> → <span class="font-mono">{{ d.after ?? '空' }}</span>
            </li>
          </ul>
          <span v-else class="text-gray-500 dark:text-dark-400">—</span>
        </template>
        <template #cell-errors="{ row }">
          <ul v-if="row.errors.length" class="min-w-[12rem] space-y-1 text-xs text-red-600 dark:text-red-400">
            <li v-for="(er, i) in row.errors" :key="i">{{ er.field }}：{{ er.message }}</li>
          </ul>
          <span v-else class="text-gray-500 dark:text-dark-400">—</span>
        </template>
        <template #cell-decision="{ row }">
          <div v-if="needsDecision(row)" class="w-56">
            <SelectField
              :model-value="decisions[row.row] ?? null"
              :options="decisionOptions(row)"
              :accessible-label="`第 ${row.row} 行的处理方式`"
              placeholder="请选择"
              :error="row.status === 'conflict' && !decisions[row.row] ? '请选择' : null"
              @update:model-value="(v) => (decisions[row.row] = String(v))"
            />
          </div>
          <span v-else class="text-gray-500 dark:text-dark-400">{{ row.status === 'unchanged' ? '无需处理' : '跳过' }}</span>
        </template>
      </DataTable>
      <div class="flex flex-wrap items-center justify-end gap-3">
        <span v-if="undecided > 0" class="text-sm text-amber-700 dark:text-amber-400">还有 {{ undecided }} 行需要选择处理方式</span>
        <button type="button" class="btn btn-primary" :disabled="committing || undecided > 0" data-test="import-commit" @click="commit">
          <Spinner v-if="committing" color="white" decorative />提交导入
        </button>
      </div>
    </div>

    <div v-if="result" class="mt-6 space-y-4" data-test="import-result">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="text-base font-semibold text-gray-900 dark:text-white">导入结果</h3>
        <button type="button" class="btn btn-ghost btn-sm" @click="viewer.open(result.operation_id)">查看批次操作</button>
      </div>
      <DataTable :columns="resultColumns" :rows="result.items" :row-key="(r) => String(r.row)" caption="导入结果">
        <template #cell-row="{ row }"><span class="font-mono">{{ row.row }}</span></template>
        <template #cell-status="{ row }"><Badge :variant="IMPORT_STATUS_LABELS[row.status].variant">{{ IMPORT_STATUS_LABELS[row.status].label }}</Badge></template>
        <template #cell-env="{ row }">{{ envName(row.environment_id) }}</template>
        <template #cell-detail="{ row }">
          <span v-if="row.error" class="text-red-600 dark:text-red-400">{{ row.error.message }}</span>
          <ul v-else-if="row.diff?.length" class="space-y-1 text-xs">
            <li v-for="d in row.diff" :key="d.field">{{ d.field }}：{{ d.before ?? '空' }} → {{ d.after ?? '空' }}</li>
          </ul>
          <span v-else class="text-gray-500 dark:text-dark-400">—</span>
        </template>
        <template #cell-op="{ row }">
          <button v-if="row.operation_id" type="button" class="btn btn-ghost btn-sm" :aria-label="`查看第 ${row.row} 行的操作`" @click="viewer.open(row.operation_id!)">
            <Icon name="eye" size="sm" />
          </button>
          <span v-else class="text-gray-500 dark:text-dark-400">—</span>
        </template>
      </DataTable>
    </div>

    <ConfirmDialog
      :show="staleDialog"
      title="预览已过期"
      message="确定要重新预览吗？"
      confirm-text="重新预览"
      @confirm="rerunPreview"
      @cancel="staleDialog = false"
    >
      <p>文件内容或相关环境在预览之后发生了变化，提交已被拒绝，没有写入任何数据。重新预览后请再核对每一行的处理方式。</p>
    </ConfirmDialog>
  </div>
</template>
