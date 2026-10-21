import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SfeError } from '@sfe/contract';
import { describe, expect, test } from 'vitest';
import { createLogger, createMemorySink, fileSink, nullLogger, serializeError } from '../../src/util/logger.js';
import { createScrubber, SCRUB_MASK } from '../../src/util/scrubber.js';

const fixedNow = () => new Date('2026-10-21T08:00:00.000Z');

describe('createLogger', () => {
  test('writes one JSON line with ts, level, scope, msg and fields', () => {
    const mem = createMemorySink();
    const log = createLogger({ sink: mem.sink, scope: 'engine', now: fixedNow });
    log.log('info', '已领取操作', { operationId: 'op_01', attempt: 1 });
    expect(mem.lines).toHaveLength(1);
    expect(JSON.parse(mem.lines[0]!)).toEqual({ ts: '2026-10-21T08:00:00.000Z', level: 'info', scope: 'engine', msg: '已领取操作', operationId: 'op_01', attempt: 1 });
    expect(mem.lines[0]!.startsWith('{"ts":')).toBe(true);
  });

  test('filters below the configured level', () => {
    const mem = createMemorySink();
    const log = createLogger({ sink: mem.sink, level: 'warn' });
    log.log('debug', 'd');
    log.log('info', 'i');
    log.log('warn', 'w');
    log.log('error', 'e');
    expect(mem.entries().map((e) => e.level)).toEqual(['warn', 'error']);
  });

  test('child loggers extend the scope', () => {
    const mem = createMemorySink();
    const log = createLogger({ sink: mem.sink, scope: 'service' }).child('surge').child('cli');
    log.log('info', 'x');
    expect(mem.entries()[0]!.scope).toBe('service.surge.cli');
  });

  test('never emits a registered secret, in msg, fields or nested errors', () => {
    const scrubber = createScrubber();
    const secret = 'Canary-Pw-7731';
    scrubber.register(secret);
    const mem = createMemorySink();
    const log = createLogger({ sink: mem.sink, scrubber, now: fixedNow });
    const cause = new Error(`inner ${secret}`);
    const err = new SfeError('SURGE_COMMAND_FAILED', `执行 Surge 命令失败：${secret}`, { details: { stderr: secret }, cause });
    log.log('error', `failed with ${secret}`, { err, args: ['--x', secret], nested: { deep: [{ v: secret }] } });
    const line = mem.lines[0]!;
    expect(line).not.toContain(secret);
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect((entry.err as Record<string, unknown>).code).toBe('SURGE_COMMAND_FAILED');
    expect(line).toContain(SCRUB_MASK);
  });

  test('without an explicit scrubber, rule-based masking still applies', () => {
    const mem = createMemorySink();
    const log = createLogger({ sink: mem.sink });
    const pw = 'Rule-Pw-1';
    log.log('info', `line A = socks5, 192.0.2.1, 1080, username=u1, password=${pw}`, { token: 'tok-value' });
    expect(mem.lines[0]).not.toContain(pw);
    expect(mem.lines[0]).not.toContain('tok-value');
  });

  test('reserved keys in fields do not overwrite envelope keys', () => {
    const mem = createMemorySink();
    const log = createLogger({ sink: mem.sink, scope: 's', now: fixedNow });
    log.log('info', 'real', { msg: 'fake', level: 'error', ts: 'x', scope: 'y' });
    const e = mem.entries()[0]!;
    expect(e).toMatchObject({ msg: 'real', level: 'info', scope: 's', ts: '2026-10-21T08:00:00.000Z', field_msg: 'fake', field_level: 'error' });
  });

  test('a throwing sink does not throw into business code', () => {
    const log = createLogger({
      sink: () => {
        throw new Error('disk full');
      },
    });
    expect(() => log.log('error', 'x')).not.toThrow();
  });

  test('bigint fields are serialised as strings', () => {
    const mem = createMemorySink();
    createLogger({ sink: mem.sink }).log('info', 'x', { n: 10n });
    expect(mem.entries()[0]!.n).toBe('10');
  });
});

describe('serializeError', () => {
  test('includes name, message, code, details and cause chain', () => {
    const e = new SfeError('NOT_FOUND', '找不到环境', { details: { id: 'env_1' }, cause: new Error('root') });
    const s = serializeError(e);
    expect(s).toMatchObject({ name: 'SfeError', message: '找不到环境', code: 'NOT_FOUND', details: { id: 'env_1' }, cause: { message: 'root' } });
  });

  test('non-errors become a message', () => {
    expect(serializeError('boom')).toEqual({ message: 'boom' });
  });
});

describe('nullLogger', () => {
  test('accepts calls and returns itself as child', () => {
    expect(() => nullLogger.log('info', 'x')).not.toThrow();
    expect(nullLogger.child('a')).toBe(nullLogger);
  });
});

describe('fileSink', () => {
  test('creates the log file with mode 0600 and appends lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-log-'));
    const path = join(dir, 'service.log');
    const sink = fileSink(path);
    const log = createLogger({ sink, now: fixedNow });
    log.log('info', 'one');
    log.log('info', 'two');
    sink.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['one', 'two']);
    // 关闭后写入被忽略
    expect(() => sink('{"x":1}')).not.toThrow();
  });

  test('tightens an existing world-readable log file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-log-'));
    const path = join(dir, 'service.log');
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    const sink = fileSink(path);
    sink.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('refuses a symlinked log path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-log-'));
    const target = join(dir, 'elsewhere.log');
    writeFileSync(target, '');
    const link = join(dir, 'service.log');
    symlinkSync(target, link);
    expect(() => fileSink(link)).toThrow();
  });
});
