import { describe, expect, test } from 'vitest';
import { changedNodeLineFields, nodeLineChanged, type NodeLineFields } from '../../src/domain/node-line.js';
import { allocateEnvironmentNaming, labelOf, revisionNodeName } from '../../src/domain/naming.js';

const base: NodeLineFields = { protocol: 'socks5', host: '203.0.113.10', port: 1080, usernameFp: 'fp-u', passwordFp: 'fp-p', frontProxyId: 'front_1' };

describe('nodeLineChanged', () => {
  test('identical fields → no new revision', () => {
    expect(nodeLineChanged(base, { ...base })).toBe(false);
    expect(changedNodeLineFields(base, { ...base })).toEqual([]);
  });

  test.each([
    ['host', { host: '203.0.113.20' }],
    ['port', { port: 1081 }],
    ['username', { usernameFp: 'fp-u2' }],
    ['password', { passwordFp: 'fp-p2' }],
    ['frontProxyId', { frontProxyId: 'front_2' }],
    ['username', { usernameFp: null }],
    ['password', { passwordFp: null }],
  ] as const)('%s change mints a revision', (field, patch) => {
    const next = { ...base, ...patch } as NodeLineFields;
    expect(nodeLineChanged(base, next)).toBe(true);
    expect(changedNodeLineFields(base, next)).toEqual([field]);
  });

  test('no previous revision → changed (first revision)', () => {
    expect(nodeLineChanged(null, base)).toBe(true);
    expect(changedNodeLineFields(null, base)).toContain('host');
  });

  test('null and undefined fingerprints are equivalent', () => {
    const a = { ...base, usernameFp: null };
    const b = { ...base, usernameFp: undefined as unknown as null };
    expect(nodeLineChanged(a, b)).toBe(false);
  });
});

describe('naming', () => {
  test('allocates stable code and site tag from monotonic counters', () => {
    let env = 0;
    const site = new Map<string, number>();
    const meta = {
      nextEnvironmentSeq: () => ++env,
      nextSiteSeq: (s: string) => {
        const n = (site.get(s) ?? 0) + 1;
        site.set(s, n);
        return n;
      },
    };
    expect(allocateEnvironmentNaming(meta, 'US')).toEqual({ seq: 1, code: 'E0001', nodeTag: 'US01' });
    expect(allocateEnvironmentNaming(meta, 'US')).toEqual({ seq: 2, code: 'E0002', nodeTag: 'US02' });
  });

  test('exit node name per revision contains no account or IP', () => {
    const name = revisionNodeName({ code: 'E0007', nodeTag: 'US03' }, 12);
    expect(name).toBe('SFE-N-E0007-US03-v012');
    expect(name).not.toMatch(/\d+\.\d+\.\d+/);
  });

  test('label combines display name and code', () => {
    expect(labelOf({ displayName: 'US-买家01', code: 'E0001' })).toBe('US-买家01 · E0001');
  });
});
