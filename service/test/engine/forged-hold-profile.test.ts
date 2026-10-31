import { afterEach, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME } from '@sfe/contract';
import { runForgedHold } from '../../src/engine/handlers/route.js';
import { PROFILE_A, activeEnv, createHarness, rid, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

test('recovered hold must not attribute another profile REJECT to its saved intent', async () => {
  h = await createHarness();
  await activeEnv(h, 'Synthetic-A', '203.0.113.10', PROFILE_A);
  await h.app.stop();
  const before = h.repos.routeState.get();
  h.app.engine.kv.set('resource:forgedNodes', { since: h.clock.now().toISOString(), reasons: ['unexplained_fetch'] });
  const pending = h.repos.operations.insert({
    id: 'op_profile_hold',
    requestId: rid('profile-hold'),
    requestDigest: 'service',
    kind: 'route.hold',
    initiatorKind: 'service',
    status: 'running',
    phase: 'VALIDATING',
    payload: { forgedHold: { reasons: ['unexplained_fetch'] }, endHold: { externalSelectionBefore: false, cause: 'node_resource_forged' } },
  });
  // The persisted intent belongs to the working profile; the fake controller now reports another profile.
  h.fake.currentProfile = { name: 'Other', path: `${h.surgeDir}/Other.conf` };
  await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, 'REJECT');
  const selects = h.fake.calls.selectGroupPolicy;
  await runForgedHold(h.app.engine, pending, { recovering: true });
  const result = h.repos.operations.get(pending.id)!;
  expect(result).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
  expect(result.result?.rejectSelected).not.toBe(true);
  expect(h.repos.routeState.get().selectedNode).toBe(before.selectedNode);
  expect(h.fake.calls.selectGroupPolicy).toBe(selects);
});
