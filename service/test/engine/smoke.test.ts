import { afterEach, describe, expect, test } from 'vitest';
import { FAKE_CHROME_PATH } from '../../src/surge/fake.js';
import { PROFILE_A, activeEnv, createEnv, createHarness, safariOutcome, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('engine smoke', () => {
  test('create → publish → bind → activate → verify → ACTIVE', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { username: 'synthuser01', password: 'synthpass01' });
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('READY_FOR_NEXT_OPEN');
    const env = h.repos.environments.get(a.environment_id!)!;
    expect(env.deployedProxyRevision).toBe(1);
    const { envId } = await activeEnv(h, 'US-Buyer-02', '203.0.113.11', PROFILE_A);
    const route = h.repos.routeState.get();
    expect(route.activeEnvironmentId).toBe(envId);
    expect(route.entryMode).toBe('ACTIVE');
    expect(route.phase).toBe('active_verified');
    const s = safariOutcome(h);
    expect(s.policyName).toBe('SFE-ROUTE');
    const chrome = h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' });
    expect(chrome.policyName).toBe('DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });
});
