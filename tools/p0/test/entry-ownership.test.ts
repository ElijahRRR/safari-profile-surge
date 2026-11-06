import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileEntryOwnership, loadEntryRecords } from '../src/entry-ownership.js';
import { RunDir } from '../src/run-dir.js';

function dir(): RunDir {
  return RunDir.create(join(mkdtempSync(join(tmpdir(), 'sfe-p0-own-')), 'p0'), '20261021-110000-aaaaaa');
}

describe('file-backed entry ownership', () => {
  it('persists intents and confirmations across instances', async () => {
    const d = dir();
    const a = createFileEntryOwnership(d);
    await a.recordIntent('temp_rule', 'PROCESS-NAME,/Applications/Safari.app/Contents/MacOS/Safari,REJECT', null, 'op1');
    const b = createFileEntryOwnership(d);
    expect((await b.getRecordedTempRules()).map((r) => r.state)).toEqual(['pending_add']);
    await b.confirm('temp_rule', 'PROCESS-NAME,/Applications/Safari.app/Contents/MacOS/Safari,REJECT', 'present');
    expect(loadEntryRecords(d)?.[0]?.state).toBe('present');
  });

  it('adds seed records without overwriting existing ones', async () => {
    const d = dir();
    const first = createFileEntryOwnership(d);
    await first.recordIntent('entry_ruleset_file', 'sfe-entry-udp.list', 'new', 'op1');
    const seeded = createFileEntryOwnership(d, [
      { kind: 'entry_ruleset_file', identity: 'sfe-entry-udp.list', digest: 'seed', state: 'present', operationId: null },
      { kind: 'entry_ruleset_file', identity: 'sfe-entry-block.list', digest: 'seed2', state: 'present', operationId: null },
    ]);
    expect((await seeded.getRecord('entry_ruleset_file', 'sfe-entry-udp.list'))?.state).toBe('pending_add');
    expect((await seeded.getRecord('entry_ruleset_file', 'sfe-entry-block.list'))?.digest).toBe('seed2');
  });

  it('starts empty when no file exists', () => {
    const d = dir();
    expect(loadEntryRecords(d)).toBeNull();
    createFileEntryOwnership(d);
    expect(loadEntryRecords(d)).toEqual([]);
  });
});
