import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeEvidenceManifest, digestEntries, fileDigest, isEvidenceFile } from '../src/evidence.js';
import { RunDir } from '../src/run-dir.js';
import { createProfileFiles } from '../src/deps.js';

const KEY = Buffer.alloc(32, 7);

describe('digestEntries', () => {
  const entries = [
    { path: 'b.json', content: Buffer.from('2') },
    { path: 'a.json', content: Buffer.from('1') },
  ];

  it('is independent of input order', () => {
    expect(digestEntries(KEY, entries).digest).toBe(digestEntries(KEY, [...entries].reverse()).digest);
  });

  it('changes when content, name or key changes', () => {
    const base = digestEntries(KEY, entries).digest;
    expect(digestEntries(KEY, [{ path: 'a.json', content: Buffer.from('1') }, { path: 'b.json', content: Buffer.from('3') }]).digest).not.toBe(base);
    expect(digestEntries(KEY, [{ path: 'a.json', content: Buffer.from('1') }, { path: 'c.json', content: Buffer.from('2') }]).digest).not.toBe(base);
    expect(digestEntries(Buffer.alloc(32, 8), entries).digest).not.toBe(base);
  });

  it('is a keyed digest with a prefix and per-file entries', () => {
    const r = digestEntries(KEY, entries);
    expect(r.digest).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(r.files.map((f) => f.path)).toEqual(['a.json', 'b.json']);
    expect(r.files[0]!.size).toBe(1);
  });

  it('excludes the key file, proposals and temp files', () => {
    expect(isEvidenceFile('digest.key')).toBe(false);
    expect(isEvidenceFile('proposals/p.json')).toBe(false);
    expect(isEvidenceFile('state.json.tmp-0a1b2c')).toBe(false);
    expect(isEvidenceFile('results/runtime_entry_modes.json')).toBe(true);
    const withExcluded = [...entries, { path: 'digest.key', content: Buffer.from('k') }, { path: 'proposals/x.json', content: Buffer.from('p') }];
    expect(digestEntries(KEY, withExcluded).digest).toBe(digestEntries(KEY, entries).digest);
  });
});

describe('computeEvidenceManifest', () => {
  it('covers files in the run directory and changes when evidence changes', () => {
    const dir = RunDir.create(join(mkdtempSync(join(tmpdir(), 'sfe-p0-ev-')), 'p0'), '20261021-100000-aaaaaa');
    dir.writeJson('inventory.json', { a: 1 });
    const m1 = computeEvidenceManifest(dir);
    expect(m1.files.map((f) => f.path)).toEqual(['inventory.json']);
    dir.writeJson('proposals/x.json', { ignored: true });
    expect(computeEvidenceManifest(dir).digest).toBe(m1.digest);
    dir.appendJsonl('servers/echo.jsonl', { e: 1 });
    expect(computeEvidenceManifest(dir).digest).not.toBe(m1.digest);
  });
});

describe('fileDigest', () => {
  it('matches the service ProfileFiles digest for the same key', async () => {
    const d = mkdtempSync(join(tmpdir(), 'sfe-p0-fd-'));
    writeFileSync(join(d, 'sfe-nodes.list'), 'content\n');
    const files = createProfileFiles({ directory: d, hmacKey: KEY });
    expect(await files.digest('sfe-nodes.list')).toBe(fileDigest(KEY, 'content\n'));
  });
});
