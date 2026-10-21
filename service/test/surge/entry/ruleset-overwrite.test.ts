// ruleset_resource：本应用拥有、但被外部修改/无法识别/缺失的入口规则集文件只在撤销入口（undo：普通模式、回滚，
// 目标 BLOCKED/NORMAL）时按载入时读到的摘要比较后改写；激活中的阻断与 VERIFY_ONLY/ACTIVE 仍然拒绝；
// 不属于本应用的文件任何方向都不改写。
// 只用合成数据（example.test、文档地址）。见 docs/ARCHITECTURE.md §5.5。

import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ENTRY_MODE_BITS, ENTRY_RULESET_FILES, SfeError, type KnownEntryMode } from '@sfe/contract';
import type { EntryController, EntryTransitionOptions } from '../../../src/ports.js';
import { FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment } from '../../../src/surge/fake.js';
import { createProfileFiles, type ManagedProfileFiles } from '../../../src/surge/files.js';
import { entryRuleSetFileContent, nodeLine, resourceFile } from '../../../src/surge/generate.js';
import { createMemoryEntryOwnership, type MemoryEntryOwnership } from '../../../src/surge/entry/ownership.js';
import { createRulesetStrategy, ownedRulesetRecords } from '../../../src/surge/entry/ruleset-strategy.js';
import { modeOfSemantic, type EntrySemantic, type Outcome } from '../../../src/surge/entry/common.js';

const NODE = 'SFE-N-E0001-US01-v001';
const SITE = 'www.example.test';
const CFG = { processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST, siteHosts: [SITE] };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfe-entry-ow-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Safari 四类流量在假 Surge 已加载规则下的实际模式。 */
function observedMode(fake: FakeSurge): KnownEntryMode | null {
  const outcome = (host: string, protocol: 'tcp' | 'udp'): Outcome => {
    const r = fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host, protocol });
    if (r.failed && r.policyName?.startsWith('REJECT')) return 'reject';
    return r.policyName === 'SFE-ROUTE' ? 'route' : 'pass';
  };
  const s: EntrySemantic = { tcpVerify: outcome(FAKE_VERIFY_HOST, 'tcp'), tcpOther: outcome(SITE, 'tcp'), udpVerify: outcome(FAKE_VERIFY_HOST, 'udp'), udpOther: outcome(SITE, 'udp') };
  return modeOfSemantic(s);
}

interface Setup {
  fake: FakeSurge;
  files: ManagedProfileFiles;
  ownership: MemoryEntryOwnership;
  ctrl: EntryController;
  /** 每一步之后的实际模式（断言没有放行窗口）。 */
  seen: Array<KnownEntryMode | null>;
}

async function setup(start: KnownEntryMode): Promise<Setup> {
  createFakeSurgeEnvironment(dir);
  const fake = new FakeSurge({ directory: dir, autoReload: false });
  writeFileSync(join(dir, 'sfe-nodes.list'), resourceFile(1, [nodeLine({ name: NODE, host: '203.0.113.10', port: 1080, username: null, password: null, front: 'Front-A' })]));
  await fake.updateExternalResource('policy-path:sfe-nodes.list');
  await fake.selectGroupPolicy('SFE-ROUTE', NODE);
  const files = createProfileFiles({ directory: dir, hmacKey: 'example-hmac-key' });
  const ownership = createMemoryEntryOwnership(await ownedRulesetRecords(files));
  const ctrl = createRulesetStrategy({ adapter: fake, files, ownership, config: () => CFG, operationId: () => 'op_test', autoReloadCondition: () => 'off' });
  if (start !== 'NORMAL') await ctrl.transition(start);
  expect(observedMode(fake)).toBe(start);
  return { fake, files, ownership, ctrl, seen: [] };
}

function assertNoWindow(seen: Array<KnownEntryMode | null>, from: KnownEntryMode, to: KnownEntryMode): void {
  const allowed = new Set<KnownEntryMode>(['BLOCKED', 'VERIFY_ONLY', from, to]);
  for (const m of seen) {
    expect(m).not.toBeNull();
    expect(allowed.has(m!)).toBe(true);
  }
}

const path = (bit: keyof typeof ENTRY_RULESET_FILES) => join(dir, ENTRY_RULESET_FILES[bit]);
const UNDO: EntryTransitionOptions = { undo: true };

describe('ruleset_resource: externally modified app-owned entry files', () => {
  test('a comment appended while ACTIVE: VERIFY_ONLY/ACTIVE refuse without writing, BLOCKED overwrites without a permissive window, then NORMAL', async () => {
    const s = await setup('ACTIVE');
    appendFileSync(path('active'), '# note\n');
    expect((await s.ctrl.read()).mode).toBe('UNKNOWN');
    const updates = s.fake.calls.updateExternalResource;
    for (const to of ['VERIFY_ONLY', 'ACTIVE'] as const) {
      await expect(s.ctrl.transition(to)).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
    }
    expect(s.fake.calls.updateExternalResource).toBe(updates);
    expect(readFileSync(path('active'), 'utf8')).toContain('# note');

    const rb = await s.ctrl.transition('BLOCKED', () => s.seen.push(observedMode(s.fake)), UNDO);
    expect(rb.mode).toBe('BLOCKED');
    expect(rb.bits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    expect(rb.evidence.some((e) => e.includes('已改写被外部修改的本应用入口规则集文件'))).toBe(true);
    assertNoWindow(s.seen, 'ACTIVE', 'BLOCKED');
    expect(observedMode(s.fake)).toBe('BLOCKED');
    // 改写后的内容与记录一致：不再是外部修改
    expect(await s.files.digest(ENTRY_RULESET_FILES.active)).toBe(s.files.digestContent(entryRuleSetFileContent('active', false, CFG)));
    expect(s.ownership.records().find((r) => r.identity === ENTRY_RULESET_FILES.active)).toMatchObject({ state: 'present', digest: await s.files.digest(ENTRY_RULESET_FILES.active) });
    expect((await s.ctrl.read()).mode).toBe('BLOCKED');
    expect((await s.ctrl.read()).changedOwnedFiles).toEqual([]);
    expect((await s.ctrl.transition('NORMAL')).mode).toBe('NORMAL');
    expect(observedMode(s.fake)).toBe('NORMAL');
    expect(s.fake.calls.reloadProfile).toBeUndefined();
  });

  test('without undo (an activation blocking first): the edited file is listed in the readback and refused before any write', async () => {
    const s = await setup('NORMAL');
    appendFileSync(path('active'), '# note\n');
    const rb = await s.ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.changedOwnedFiles).toEqual([ENTRY_RULESET_FILES.active]);
    const updates = s.fake.calls.updateExternalResource;
    for (const to of ['BLOCKED', 'NORMAL'] as const) {
      const err = (await s.ctrl.transition(to).catch((e: unknown) => e)) as SfeError;
      expect(err).toBeInstanceOf(SfeError);
      expect(err.code).toBe('BASELINE_CHANGED');
      expect(err.details!.lastConfirmedBits).toBeNull();
    }
    expect(s.fake.calls.updateExternalResource).toBe(updates);
    expect(readFileSync(path('active'), 'utf8')).toContain('# note');
    expect(observedMode(s.fake)).toBe('NORMAL');
  });

  test('unrecognised rule content (bits unknown): ACTIVE is UNKNOWN_STATE, NORMAL plans from the permissive side and succeeds', async () => {
    const s = await setup('VERIFY_ONLY');
    writeFileSync(path('verify'), '# edited\nDOMAIN,other.example.test\n');
    expect((await s.ctrl.read()).bits).toBeNull();
    await expect(s.ctrl.transition('ACTIVE')).rejects.toMatchObject({ code: 'UNKNOWN_STATE' });
    const rb = await s.ctrl.transition('NORMAL', () => s.seen.push(observedMode(s.fake)), UNDO);
    expect(rb.mode).toBe('NORMAL');
    assertNoWindow(s.seen, 'VERIFY_ONLY', 'NORMAL');
    expect(observedMode(s.fake)).toBe('NORMAL');
  });

  test('a deleted app-owned file is recreated toward NORMAL', async () => {
    const s = await setup('BLOCKED');
    unlinkSync(path('udp'));
    expect((await s.ctrl.read()).mode).toBe('UNKNOWN');
    expect((await s.ctrl.transition('NORMAL', () => s.seen.push(observedMode(s.fake)), UNDO)).mode).toBe('NORMAL');
    assertNoWindow(s.seen, 'BLOCKED', 'NORMAL');
    expect(readFileSync(path('udp'), 'utf8')).toBe(entryRuleSetFileContent('udp', false, CFG));
    expect(observedMode(s.fake)).toBe('NORMAL');
  });

  test('a file the app does not own is never overwritten, in any direction', async () => {
    const s = await setup('BLOCKED');
    await s.ownership.confirm('entry_ruleset_file', ENTRY_RULESET_FILES.block, 'removed');
    const before = readFileSync(path('block'), 'utf8');
    for (const to of ['NORMAL', 'BLOCKED'] as const) {
      const err = (await s.ctrl.transition(to, undefined, UNDO).catch((e: unknown) => e)) as SfeError;
      expect(err).toBeInstanceOf(SfeError);
      expect(err.code).toBe('BASELINE_CHANGED');
      expect(err.details!.anomalies).toEqual(['not_owned_block']);
    }
    expect(readFileSync(path('block'), 'utf8')).toBe(before);
    expect(observedMode(s.fake)).toBe('BLOCKED');
  });

  test('the overwrite is compare-and-swap against the digest read at load: a newer edit is kept and never adopted as baseline', async () => {
    const s = await setup('ACTIVE');
    appendFileSync(path('active'), '# note\n');
    // ACTIVE → BLOCKED：先开 block，再改写 active；在两步之间 active 又被改了一次
    const err = (await s.ctrl
      .transition(
        'BLOCKED',
        (step) => {
          s.seen.push(observedMode(s.fake));
          if (step.bit === 'block') appendFileSync(path('active'), '# second note\n');
        },
        UNDO,
      )
      .catch((e: unknown) => e)) as SfeError;
    expect(err).toBeInstanceOf(SfeError);
    expect(err.code).toBe('BASELINE_CHANGED');
    assertNoWindow(s.seen, 'ACTIVE', 'BLOCKED');
    expect(observedMode(s.fake)).toBe('BLOCKED');
    expect(readFileSync(path('active'), 'utf8')).toContain('# second note');
    // 外部内容没有被确认为记录：仍读作外部修改
    const rb = await s.ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence).toContain('异常：file_changed_active');
    // 之后再次进入阻断时按新读到的摘要改写
    expect((await s.ctrl.transition('BLOCKED', undefined, UNDO)).mode).toBe('BLOCKED');
    expect((await s.ctrl.read()).mode).toBe('BLOCKED');
  });
});
