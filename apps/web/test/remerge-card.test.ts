// 重新合并预览：需要重载同一配置时说明 Surge 6.9+ 的重载可能自动升级为完整引擎重启（关闭全部连接、清空临时规则）。
// 只用合成数据。
import { afterEach, describe, expect, it } from 'vitest';
import type { RemergePreviewResponse } from '@sfe/contract';
import RemergeCard from '../src/components/RemergeCard.vue';
import { allSupported, byText, capabilities, click, flush, mountWith, snapshot, testContext, type Call } from './fixtures';

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
