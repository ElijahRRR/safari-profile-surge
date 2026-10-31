import { describe, expect, it } from 'vitest';
import { COMMANDS, containsSecretArg, parseArgs, parseCapabilityKey, parseMechanismOverrides, usageText } from '../src/args.js';
import { P0Error } from '../src/errors.js';

function usageError(fn: () => unknown): P0Error {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(P0Error);
    return e as P0Error;
  }
  throw new Error('expected error');
}

describe('parseArgs', () => {
  it('returns help for no command', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['help']).command).toBe('help');
    expect(parseArgs(['--help']).command).toBe('help');
  });

  it('rejects unknown commands without echoing long input', () => {
    const e = usageError(() => parseArgs(['x'.repeat(200)]));
    expect(e.code).toBe('usage');
    expect(e.message.length).toBeLessThan(120);
  });

  it('parses global and command flags', () => {
    const a = parseArgs(['refresh', '--auto-reload', 'off', '--wait=5', '--raw-dir', '/tmp/p0', '--yes']);
    expect(a.command).toBe('refresh');
    expect(a.strings['auto-reload']).toBe('off');
    expect(a.numbers.wait).toBe(5);
    expect(a.strings['raw-dir']).toBe('/tmp/p0');
    expect(a.booleans.yes).toBe(true);
  });

  it('enforces choices', () => {
    expect(usageError(() => parseArgs(['refresh', '--auto-reload', 'maybe'])).message).toContain('on、off');
    expect(usageError(() => parseArgs(['entry', '--strategy', 'reload'])).code).toBe('usage');
  });

  it('enforces numeric ranges and integers for ports', () => {
    expect(usageError(() => parseArgs(['test-servers', '--echo-port', '70000'])).code).toBe('usage');
    expect(usageError(() => parseArgs(['test-servers', '--echo-port', '80.5'])).code).toBe('usage');
    expect(usageError(() => parseArgs(['test-servers', '--echo-port', 'abc'])).code).toBe('usage');
    expect(parseArgs(['test-servers', '--echo-port', '18090']).numbers['echo-port']).toBe(18090);
    expect(parseArgs(['continuity', '--interval', '0.5']).numbers.interval).toBe(0.5);
  });

  it('rejects flags that do not belong to the command', () => {
    expect(usageError(() => parseArgs(['inventory', '--strategy', 'temp_rule'])).message).toContain('不支持');
  });

  it('rejects missing values and boolean values', () => {
    expect(usageError(() => parseArgs(['refresh', '--auto-reload'])).message).toContain('缺少值');
    expect(usageError(() => parseArgs(['refresh', '--auto-reload', '--wait', '3'])).message).toContain('缺少值');
    expect(usageError(() => parseArgs(['rollback', '--execute=yes'])).message).toContain('不带值');
  });

  it('rejects duplicate string flags', () => {
    expect(usageError(() => parseArgs(['inventory', '--profile', '/a.conf', '--profile', '/b.conf'])).message).toContain('重复');
  });

  it('collects list flags from repeats and commas', () => {
    const a = parseArgs(['entry', '--strategy', 'ruleset_resource', '--precedence-test', 'temp,module', '--process-path', '/A/b', '--process-path', '/C/d']);
    expect(a.lists['precedence-test']).toEqual(['temp', 'module']);
    expect(a.lists['process-path']).toEqual(['/A/b', '/C/d']);
  });

  it('checks positional counts', () => {
    expect(usageError(() => parseArgs(['propose', 'runtime_entry_modes'])).message).toContain('用法');
    expect(parseArgs(['propose', 'runtime_entry_modes', 'supported']).positionals).toEqual(['runtime_entry_modes', 'supported']);
    expect(usageError(() => parseArgs(['inventory', 'extra'])).code).toBe('usage');
  });

  it('rejects control characters in values', () => {
    expect(usageError(() => parseArgs(['inventory', '--profile', '/a\nb.conf'])).message).toContain('控制字符');
  });

  it('every command has usage and summary', () => {
    for (const c of COMMANDS) {
      expect(c.usage.startsWith(c.name)).toBe(true);
      expect(c.summary.length).toBeGreaterThan(4);
    }
    expect(usageText()).toContain('docs/P0-RUNBOOK.md');
  });
});

describe('secret arguments', () => {
  it.each([
    ['--password', 'x'],
    ['--password=x'],
    ['--key', 'k'],
    ['--token=abc'],
    ['--user', 'u'],
    ['--note', 'password=abc'],
    ['--note', 'http-api = k@127.0.0.1:6171'],
  ])('refuses %s', (...argv) => {
    expect(containsSecretArg(argv)).toBe(true);
    expect(usageError(() => parseArgs(['inventory', ...argv])).message).toContain('不能出现密码');
  });

  it('allows ordinary flags', () => {
    expect(containsSecretArg(['--surge-team-id', 'ABCDE12345', '--profile', '/x.conf'])).toBe(false);
  });

  it('does not echo the secret value', () => {
    const e = usageError(() => parseArgs(['inventory', '--password=example-hunter']));
    expect(e.message).not.toContain('hunter');
  });
});

describe('parseCapabilityKey', () => {
  it('accepts known keys and rejects others', () => {
    expect(parseCapabilityKey('runtime_entry_modes')).toBe('runtime_entry_modes');
    expect(usageError(() => parseCapabilityKey('nope')).code).toBe('usage');
    expect(usageError(() => parseCapabilityKey(undefined)).code).toBe('usage');
  });
});

describe('parseMechanismOverrides', () => {
  const prims = ['getVersion', 'selectGroupPolicy'];
  it('parses overrides', () => {
    expect(parseMechanismOverrides(['getVersion=cli', 'selectGroupPolicy=http'], prims)).toEqual({ getVersion: 'cli', selectGroupPolicy: 'http' });
  });
  it('rejects unknown primitives and mechanisms', () => {
    expect(usageError(() => parseMechanismOverrides(['reloadProfile=cli'], prims)).code).toBe('usage');
    expect(usageError(() => parseMechanismOverrides(['getVersion=fake'], prims)).code).toBe('usage');
    expect(usageError(() => parseMechanismOverrides(['getVersion'], prims)).code).toBe('usage');
  });
});
