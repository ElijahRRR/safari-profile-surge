import { afterEach, describe, expect, it } from 'vitest';
import type { ImportPreview } from '@sfe/contract';
import ImportView from '../src/views/ImportView.vue';
import App from '../src/App.vue';
import { bytesToBase64, importFormatOf, parseJsonRecords } from '../src/lib/files';
import { createMemoryTokenStore } from '../src/api/session-token';
import { createConsoleContext } from '../src/store/context';
import { byText, click, fakeFetch, flush, manualTimers, mountWith, snapshot, testContext, TOKEN, type Call } from './fixtures';

afterEach(() => {
  document.body.innerHTML = '';
});

const NOT_FOUND = { status: 404, body: { error: { code: 'NOT_FOUND', message: '找不到' } } };

function preview(): ImportPreview {
  return {
    preview_digest: 'hmac:preview-1',
    rows: [
      { row: 2, status: 'create', environment_id: null, current_revision: null, displayName: 'US-买家05', diff: [{ field: 'proxy.host', before: null, after: '203.0.113.50' }], errors: [], conflictCandidates: [] },
      {
        row: 3,
        status: 'conflict',
        environment_id: null,
        current_revision: null,
        displayName: 'US-买家01',
        diff: [{ field: 'proxy.password', before: '已配置', after: '已修改' }],
        errors: [],
        conflictCandidates: [{ environment_id: 'env_1', label: 'US-买家01 · E0001', revision: 3 }],
      },
      { row: 4, status: 'invalid', environment_id: null, current_revision: null, displayName: null, diff: [], errors: [{ field: 'proxy_port', message: '端口必须是 1–65535 的整数' }], conflictCandidates: [] },
    ],
    totals: { create: 1, update: 0, unchanged: 0, conflict: 1, invalid: 1 },
    fileErrors: [],
  };
}

async function chooseFile(name: string, content: string) {
  const input = document.body.querySelector<HTMLInputElement>('[data-test="import-file"]')!;
  const file = new File([content], name, { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await flush(10);
}

describe('import page', () => {
  it('reads the file in the browser, previews, requires a decision for conflicts and commits with the digest', async () => {
    const { ctx, calls } = testContext((c: Call) => {
      if (c.url === '/api/imports/preview') return { status: 200, body: preview() };
      if (c.url === '/api/imports/commit') return { status: 200, body: { batch_id: 'batch_1', operation_id: 'op_b', items: [{ row: 2, environment_id: 'env_5', status: 'create', operation_id: 'op_c' }] } };
      return NOT_FOUND;
    }, snapshot());
    const m = await mountWith(ImportView, ctx, {}, '/import');
    await chooseFile('buyers.csv', 'display_name,proxy_host\nUS-买家05,203.0.113.50\n');
    click(document.body.querySelector('[data-test="import-preview"]'));
    await flush();
    const previewCall = calls.find((c) => c.url === '/api/imports/preview')!;
    expect(previewCall.body).toEqual({
      format: 'csv',
      content_base64: bytesToBase64(new TextEncoder().encode('display_name,proxy_host\nUS-买家05,203.0.113.50\n')),
      default_front_proxy_id: null,
      default_site: null,
    });

    const result = document.body.querySelector('[data-test="import-preview-result"]')!;
    expect(result.textContent).toContain('同名冲突');
    expect(result.textContent).toContain('端口必须是 1–65535 的整数');
    const commit = document.body.querySelector<HTMLButtonElement>('[data-test="import-commit"]')!;
    expect(commit.disabled).toBe(true);
    expect(result.textContent).toContain('还有 1 行需要选择处理方式');

    const trigger = document.body.querySelector<HTMLButtonElement>('button[aria-label="第 3 行的处理方式"]')!;
    click(trigger);
    await flush();
    const options = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => o.textContent?.trim());
    expect(options).toEqual(['新建', '更新到 US-买家01 · E0001', '跳过']);
    click(byText('[role="option"]', '更新到 US-买家01 · E0001'));
    await flush();
    expect(commit.disabled).toBe(false);
    click(commit);
    await flush();
    const commitCall = calls.find((c) => c.url === '/api/imports/commit')!;
    expect(commitCall.body).toMatchObject({
      format: 'csv',
      preview_digest: 'hmac:preview-1',
      decisions: [
        { row: 2, action: 'create' },
        { row: 3, action: 'update', environment_id: 'env_1', expected_revision: 3 },
      ],
    });
    expect(document.body.querySelector('[data-test="import-result"]')?.textContent).toContain('新建');
    m.unmount();
  });

  it('asks to re-run the preview on 409 PREVIEW_STALE', async () => {
    let previews = 0;
    const { ctx, calls } = testContext((c: Call) => {
      if (c.url === '/api/imports/preview') {
        previews++;
        return { status: 200, body: { ...preview(), rows: [preview().rows[0]!], totals: { create: 1, update: 0, unchanged: 0, conflict: 0, invalid: 0 } } };
      }
      if (c.url === '/api/imports/commit') return { status: 409, body: { error: { code: 'PREVIEW_STALE', message: '导入失败：预览已过期' } } };
      return NOT_FOUND;
    }, snapshot());
    const m = await mountWith(ImportView, ctx, {}, '/import');
    await chooseFile('buyers.csv', 'a,b\n');
    click(document.body.querySelector('[data-test="import-preview"]'));
    await flush();
    click(document.body.querySelector('[data-test="import-commit"]'));
    await flush();
    expect(document.body.querySelector('.modal-title')?.textContent).toBe('预览已过期');
    expect(document.body.textContent).toContain('没有写入任何数据');
    click(byText('.modal-footer button', '重新预览'));
    await flush();
    expect(previews).toBe(2);
    expect(calls.filter((c) => c.url === '/api/imports/commit')).toHaveLength(1);
    m.unmount();
  });

  it('rejects unsupported file types without reading them', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot());
    const m = await mountWith(ImportView, ctx, {}, '/import');
    await chooseFile('buyers.numbers', 'x');
    expect(document.body.textContent).toContain('只支持 .csv、.xlsx 与 .json');
    expect(document.body.querySelector<HTMLButtonElement>('[data-test="import-preview"]')!.disabled).toBe(true);
    m.unmount();
  });
});

describe('file helpers', () => {
  it('detects formats and parses JSON records', () => {
    expect(importFormatOf('A.CSV')).toBe('csv');
    expect(importFormatOf('a.xlsx')).toBe('xlsx');
    expect(importFormatOf('a.xls')).toBeNull();
    expect(parseJsonRecords('[{"display_name":"x"}]')).toHaveLength(1);
    expect(parseJsonRecords('{"records":[1,2]}')).toEqual([1, 2]);
    expect(() => parseJsonRecords('{"x":1}')).toThrow('records');
    expect(() => parseJsonRecords('nope')).toThrow('不是有效的 JSON');
  });

  it('base64-encodes large inputs in chunks', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(atob(bytesToBase64(bytes)).length).toBe(100_000);
  });
});

describe('app shell', () => {
  it('shows the login explanation (no form) when there is no session token', async () => {
    const { fetch, calls } = fakeFetch(() => NOT_FOUND);
    const ctx = createConsoleContext({ tokens: createMemoryTokenStore(null), fetch, timers: manualTimers() });
    await ctx.bootstrap();
    const m = await mountWith(App, ctx);
    const view = document.body.querySelector('[data-test="login-view"]')!;
    expect(view.textContent).toContain('sfe open');
    expect(view.textContent).toContain('打开管理后台');
    expect(view.querySelectorAll('input, form')).toHaveLength(0);
    expect(calls).toHaveLength(0);
    m.unmount();
  });

  it('a 401 during bootstrap clears the token and shows the expired state', async () => {
    const tokens = createMemoryTokenStore(TOKEN);
    const { fetch } = fakeFetch(() => ({ status: 401 }));
    const ctx = createConsoleContext({ tokens, fetch, timers: manualTimers() });
    await ctx.bootstrap();
    expect(ctx.store.state.session.status).toBe('expired');
    expect(tokens.get()).toBeNull();
    const m = await mountWith(App, ctx);
    expect(document.body.textContent).toContain('会话已过期');
    m.unmount();
  });

  it('bootstraps session → snapshot → event stream and shows the DEMO banner in demo mode', async () => {
    const { fetch, calls } = fakeFetch((c: Call) => {
      if (c.url === '/api/session') return { status: 200, body: { authenticated: true, serviceVersion: '0.1.0', demoMode: true, expiresAt: '2026-10-21T20:00:00.000Z' } };
      if (c.url === '/api/snapshot') return { status: 200, body: snapshot({ demoMode: true, sequence: 42 }) };
      if (c.url.startsWith('/api/operations')) return { status: 200, body: [] };
      return NOT_FOUND;
    });
    const ctx = createConsoleContext({ tokens: createMemoryTokenStore(TOKEN), fetch, timers: manualTimers() });
    await ctx.bootstrap();
    await flush();
    expect(ctx.store.state.session.status).toBe('authenticated');
    const events = calls.find((c) => c.url === '/api/events')!;
    expect(events.headers['Last-Event-ID']).toBe('42');
    expect(events.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const m = await mountWith(App, ctx);
    expect(document.body.querySelector('[data-test="demo-banner"]')?.textContent).toContain('DEMO');
    expect(document.body.querySelector('aside.sidebar')).not.toBeNull();
    expect(document.body.querySelector('header.glass.sticky.h-16, header.glass .h-16')).not.toBeNull();
    ctx.dispose();
    m.unmount();
  });

  it('logout clears the token and returns to the login explanation', async () => {
    const tokens = createMemoryTokenStore(TOKEN);
    const { fetch, calls } = fakeFetch(() => ({ status: 204 }));
    const ctx = createConsoleContext({ tokens, fetch, timers: manualTimers() });
    ctx.store.setSnapshot(snapshot());
    ctx.store.state.session.status = 'authenticated';
    await ctx.logout();
    expect(calls[0]?.url).toBe('/api/session/logout');
    expect(tokens.get()).toBeNull();
    expect(ctx.store.state.session.status).toBe('none');
    expect(ctx.store.state.snapshot).toBeNull();
  });
});
