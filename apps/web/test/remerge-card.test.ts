// 重新合并预览：需要重载同一配置时说明 Surge 6.9+ 的重载可能自动升级为完整引擎重启（关闭全部连接、清空临时规则）。
// 本机资源服务（D10）：更换本机资源地址的选项属于预览、提交前确认；令牌可疑与仍引用本地节点文件时的说明。
// 只用合成数据。
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeResourceStatusView, RemergePreviewResponse, Snapshot } from '@sfe/contract';
import RemergeCard from '../src/components/RemergeCard.vue';
import { allSupported, byText, capabilities, click, flush, mountWith, nodeResource, snapshot, snapshotWithNodeResource, testContext, type Call } from './fixtures';

afterEach(() => {
  document.body.innerHTML = '';
});

function preview(over: Partial<RemergePreviewResponse> = {}): RemergePreviewResponse {
  return {
    preview_digest: 'digest-0001',
    workingProfilePath: '/Users/test/Library/Application Support/Surge/Profiles/日常-Safari环境.conf',
    backupDirectory: '/Users/test/Library/Application Support/SFE/backups/remerge',
    managedDiff: '- SFE-ROUTE = select, REJECT, DIRECT\n+ SFE-ROUTE = select, REJECT\n',
    referencedFiles: [],
    profileDirectoryRisk: 'none',
    autoReloadEnabled: false,
    takeover: { enhancedMode: true, systemProxy: false, outboundMode: 'rule', checkedAt: null },
    httpApi: { configured: false, loopbackOnly: null },
    remoteSources: [],
    remoteUpdatesNotice: null,
    checks: [{ name: 'gate', ok: true, message: '维护写入门槛已满足' }],
    nameCollisions: [],
    managedFilesDiff: '',
    requiresReload: true,
    measuredReloadImpact: null,
    ...over,
  };
}

async function mountWithPreview(p: RemergePreviewResponse) {
  const { ctx } = testContext(
    (c: Call) => (c.url === '/api/maintenance/remerge/preview' ? { status: 200, body: p } : { status: 404 }),
    snapshot({ capabilities: capabilities(allSupported()) }),
  );
  const m = await mountWith(RemergeCard, ctx);
  click(byText('button', '生成预览'));
  await flush();
  return m;
}

describe('remerge reload notice', () => {
  it('states that a 6.9+ reload may escalate to a full engine restart (docs quote)', async () => {
    const m = await mountWithPreview(preview());
    const notice = document.body.querySelector('[data-test="reload-notice"]')!;
    expect(notice.textContent).toContain('Automatically performs a full engine restart if a change requires one.');
    expect(notice.textContent).toContain('关闭全部连接并清空临时规则');
    // 重载只作为经确认的维护提交：没有单独的“重载”按钮
    const labels = Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('重载'))).toBe(false);
    m.unmount();
  });

  it('shows no reload notice when nothing needs reloading', async () => {
    const m = await mountWithPreview(preview({ requiresReload: false, managedDiff: '' }));
    expect(document.body.querySelector('[data-test="reload-notice"]')).toBeNull();
    m.unmount();
  });
});

const ROTATE_TEXT = '更换本机资源地址：生成新的读取令牌与端口，重新载入工作配置；旧地址立即失效';
const accepted = { status: 202, body: { operation_id: 'op_9', environment_id: null, revision: null, duplicate: false } };

async function mountCard(snap: Snapshot, p: RemergePreviewResponse = preview()) {
  const { ctx, calls } = testContext(
    (c: Call) =>
      c.url === '/api/maintenance/remerge/preview' ? { status: 200, body: p } : c.url === '/api/maintenance/remerge/commit' ? accepted : { status: 404 },
    snap,
  );
  const m = await mountWith(RemergeCard, ctx);
  return { ctx, calls, m };
}

function withResource(nr: NodeResourceStatusView | null, caps = capabilities(allSupported())): Snapshot {
  return snapshotWithNodeResource(nr, { capabilities: caps });
}

function rotateBox(): HTMLInputElement | null {
  return document.body.querySelector<HTMLInputElement>('[data-test="rotate-resource-url"]');
}

function check(el: HTMLInputElement) {
  el.checked = !el.checked;
  el.dispatchEvent(new Event('change'));
}

describe('remerge with a new local resource address (rotateResourceUrl)', () => {
  it('previews with the option and asks for confirmation with the exact consequence before committing', async () => {
    const { calls, m } = await mountCard(withResource(nodeResource({ tokenSuspect: true })));
    expect(document.body.querySelector('[data-test="remerge-token-suspect"]')?.textContent).toContain('更换本机资源地址');
    check(rotateBox()!);
    await flush();
    click(byText('button', '生成预览'));
    await flush();
    expect(calls.find((c) => c.url === '/api/maintenance/remerge/preview')?.body).toEqual({ rotateResourceUrl: true });
    click(document.body.querySelector('[data-test="remerge-commit"]'));
    await flush();
    // 先确认，没有确认之前不提交
    expect(calls.some((c) => c.url === '/api/maintenance/remerge/commit')).toBe(false);
    expect(document.body.querySelector('[data-test="rotate-confirm-text"]')?.textContent).toContain(ROTATE_TEXT);
    click(document.body.querySelector('.modal-footer [data-test="confirm"]'));
    await flush();
    expect(calls.find((c) => c.url === '/api/maintenance/remerge/commit')?.body).toEqual({
      request_id: expect.any(String),
      preview_digest: 'digest-0001',
      rotateResourceUrl: true,
    });
    // 页面从不显示资源地址、端口或令牌
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/127\.0\.0\.1:\d/);
    expect(text).not.toMatch(/[0-9a-f]{32,}/i);
    m.unmount();
  });

  it('cancelling the confirmation sends nothing', async () => {
    const { calls, m } = await mountCard(withResource(nodeResource()));
    check(rotateBox()!);
    await flush();
    click(byText('button', '生成预览'));
    await flush();
    click(document.body.querySelector('[data-test="remerge-commit"]'));
    await flush();
    click(byText('.modal-footer button', '取消'));
    await flush();
    expect(calls.some((c) => c.url === '/api/maintenance/remerge/commit')).toBe(false);
    m.unmount();
  });

  it('an ordinary remerge sends no option and needs no extra confirmation', async () => {
    const { calls, m } = await mountCard(withResource(nodeResource()));
    click(byText('button', '生成预览'));
    await flush();
    expect(calls.find((c) => c.url === '/api/maintenance/remerge/preview')?.body).toEqual({});
    click(document.body.querySelector('[data-test="remerge-commit"]'));
    await flush();
    expect(document.body.querySelector('[data-test="rotate-confirm-text"]')).toBeNull();
    expect(calls.find((c) => c.url === '/api/maintenance/remerge/commit')?.body).toEqual({ request_id: expect.any(String), preview_digest: 'digest-0001' });
    m.unmount();
  });

  it('changing the option discards the preview, so a commit always carries the option it was previewed with', async () => {
    const { calls, m } = await mountCard(withResource(nodeResource()));
    click(byText('button', '生成预览'));
    await flush();
    expect(document.body.querySelector('[data-test="maintenance-preview"]')).not.toBeNull();
    check(rotateBox()!);
    await flush();
    expect(document.body.querySelector('[data-test="maintenance-preview"]')).toBeNull();
    expect(document.body.querySelector<HTMLButtonElement>('[data-test="remerge-commit"]')!.disabled).toBe(true);
    expect(calls.some((c) => c.url === '/api/maintenance/remerge/commit')).toBe(false);
    m.unmount();
  });

  it('is not offered by an older service that reports no resource status', async () => {
    const { calls, m } = await mountCard(snapshot({ capabilities: capabilities(allSupported()) }));
    expect(rotateBox()).toBeNull();
    click(byText('button', '生成预览'));
    await flush();
    expect(calls.find((c) => c.url === '/api/maintenance/remerge/preview')?.body).toEqual({});
    m.unmount();
  });
});

describe('remerge while the profile still references the local node file (legacy line)', () => {
  it('explains that the line stays until the resourceServe checks pass', async () => {
    const caps = capabilities({ ...allSupported(), loopback_resource_restart: 'unverified' });
    const { m } = await mountCard(withResource(nodeResource({ state: 'legacy_line' }), caps));
    const note = document.body.querySelector('[data-test="remerge-legacy-line"]')!;
    expect(note.textContent).toContain('本机资源服务补测通过后才能改用本机资源服务');
    expect(note.textContent).toContain('保持原有本地节点文件引用');
    expect(note.textContent).toContain('回环资源重启后的缓存与恢复');
    m.unmount();
  });

  it('says the remerge switches to the local resource server once the resourceServe gate is met', async () => {
    const { m } = await mountCard(withResource(nodeResource({ state: 'legacy_line' })));
    const note = document.body.querySelector('[data-test="remerge-legacy-line"]')!;
    expect(note.textContent).toContain('重新合并会把它改为指向本机资源服务');
    expect(note.textContent).not.toContain('补测通过后才能');
    m.unmount();
  });

  it('shows no legacy note while serving', async () => {
    const { m } = await mountCard(withResource(nodeResource()));
    expect(document.body.querySelector('[data-test="remerge-legacy-line"]')).toBeNull();
    expect(document.body.querySelector('[data-test="remerge-token-suspect"]')).toBeNull();
    m.unmount();
  });
});
