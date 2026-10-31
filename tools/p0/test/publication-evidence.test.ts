import { describe, expect, it } from 'vitest';
import { observedNodePublication } from '../src/commands/continuity.js';
import { check, verdictOf, type ActionEntry } from '../src/results.js';

// 连续性只接受回环发布的完整序列（D10）：同一命令、同一代，先由测试资源服务提供、再对该资源执行一次单 key 更新、最后读回确认。

function action(action: string, t: number, detail: Record<string, unknown> = { resource: 'loopback', generation: 5 }, command = 'loopback'): ActionEntry {
  return { at: new Date(t).toISOString(), command, action, detail };
}

const SERVED = (t: number, gen = 5, command = 'loopback') => action('resource_generation_served', t, { resource: 'loopback', generation: gen }, command);
const UPDATE = (t: number, gen = 5, command = 'loopback') => action('resource_update_call', t, { resource: 'loopback', generation: gen, key: '0123', label: 'x' }, command);
const VERIFIED = (t: number, gen = 5, command = 'loopback') => action('node_publication_verified', t, { resource: 'loopback', generation: gen }, command);

describe('continuity publication evidence (loopback)', () => {
  it('accepts served → single-key update → verified for the same generation in the window, regardless of input order', () => {
    expect(observedNodePublication([VERIFIED(1300), UPDATE(1200), SERVED(1100)], 1000, 2000)).toBe(true);
    expect(observedNodePublication([SERVED(1100, 7, 'chain'), UPDATE(1200, 7, 'chain'), VERIFIED(1300, 7, 'chain')], 1000, 2000)).toBe(true);
  });

  it('keeps uninterrupted traffic incomplete when a served generation was never verified', () => {
    const seen = observedNodePublication([SERVED(1100), UPDATE(1200)], 1000, 2000);
    expect(seen).toBe(false);
    expect(verdictOf([check('traffic uninterrupted', true), check('publication observed', seen ? true : null)])).toBe('incomplete');
  });

  it.each([
    ['verified without an update', [SERVED(1100), VERIFIED(1300)]],
    ['update without serving', [UPDATE(1200), VERIFIED(1300)]],
    ['verified before the update', [SERVED(1100), VERIFIED(1150), UPDATE(1200)]],
    ['different generations', [SERVED(1100, 5), UPDATE(1200, 5), VERIFIED(1300, 6)]],
    ['different commands', [SERVED(1100, 5, 'loopback'), UPDATE(1200, 5, 'chain'), VERIFIED(1300, 5, 'loopback')]],
    ['started before the window', [SERVED(900), UPDATE(1200), VERIFIED(1300)]],
    ['verified after the window', [SERVED(1100), UPDATE(1200), VERIFIED(2100)]],
    ['operator-only evidence', [SERVED(1100, 5, 'operator'), UPDATE(1200, 5, 'operator'), VERIFIED(1300, 5, 'operator')]],
    ['not the loopback resource', [action('resource_generation_served', 1100, { generation: 5 }), action('resource_update_call', 1200, { generation: 5 }), action('node_publication_verified', 1300, { generation: 5 })]],
    // 本地文件写入不再算发布（D7 已被 D10 取代）
    ['local file write', [action('test_file_written', 1100, { file: 'sfe-nodes.list' }, 'refresh'), action('node_publication_verified', 1200, { file: 'sfe-nodes.list' }, 'refresh')]],
  ])('rejects %s', (_name, actions) => {
    expect(observedNodePublication(actions as ActionEntry[], 1000, 2000)).toBe(false);
  });
});
