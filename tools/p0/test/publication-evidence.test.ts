import { describe, expect, it } from 'vitest';
import { NODE_RESOURCE_FILE } from '@sfe/contract';
import { observedNodePublication } from '../src/commands/continuity.js';
import { check, verdictOf, type ActionEntry } from '../src/results.js';

function action(action: string, t: number, command = 'refresh', file = NODE_RESOURCE_FILE): ActionEntry {
  return { at: new Date(t).toISOString(), command, action, detail: { file } };
}

describe('continuity publication evidence', () => {
  it('keeps uninterrupted traffic incomplete when a local file write never became a publication', () => {
    const seen = observedNodePublication([
      action('test_file_written', 1100), action('resource_update_call', 1200),
      action('test_file_written', 1300), // restore of the original nodes
    ], 1000, 2000);
    expect(seen).toBe(false);
    expect(verdictOf([check('traffic uninterrupted', true), check('publication observed', seen ? true : null)])).toBe('incomplete');
  });

  it('accepts a fresh write followed by verified new-node traffic in the observation window', () => {
    expect(observedNodePublication([action('node_publication_verified', 1200), action('test_file_written', 1100)], 1000, 2000)).toBe(true);
  });

  it.each([
    [action('test_file_written', 900), action('node_publication_verified', 950)],
    [action('test_file_written', 1100), action('node_publication_verified', 2100)],
    [action('test_file_written', 900), action('node_publication_verified', 1100)],
    [action('node_publication_verified', 1100)],
    [action('node_publication_verified', 1100), action('test_file_written', 1200)],
    [action('test_file_written', 1100), action('node_publication_verified', 1200, 'operator')],
    [action('test_file_written', 1100, 'refresh', 'other.list'), action('node_publication_verified', 1200)],
  ])('rejects stale, out-of-window, unpaired or operator-only evidence: %j', (...actions) => {
    expect(observedNodePublication(actions, 1000, 2000)).toBe(false);
  });
});
