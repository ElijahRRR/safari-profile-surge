import { describe, expect, test } from 'vitest';
import {
  API_ROUTES,
  buildPath,
  classifySiteUrl,
  environmentCode,
  exitNodeName,
  frontNodeName,
  isSfeName,
  isTerminalPhase,
  maskLoginIdentifier,
  nodeTag,
  parseExitNodeName,
  shortProfileId,
  SfeError,
  httpStatusFor,
  SAFARI_MINIMUM_VERSION,
  safariBelowMinimum,
} from '../src/index.js';

describe('naming', () => {
  test('formats stable codes and versioned node names', () => {
    expect(environmentCode(1)).toBe('E0001');
    expect(environmentCode(12345)).toBe('E12345');
    expect(nodeTag('US', 1)).toBe('US01');
    expect(exitNodeName('E0001', 'US01', 3)).toBe('SFE-N-E0001-US01-v003');
    expect(exitNodeName('E0001', 'US01', 1234)).toBe('SFE-N-E0001-US01-v1234');
    expect(frontNodeName(1)).toBe('SFE-F-F0001');
  });

  test('round-trips exit node names', () => {
    expect(parseExitNodeName('SFE-N-E0001-US01-v018')).toEqual({ envCode: 'E0001', tag: 'US01', proxyRevision: 18 });
    expect(parseExitNodeName('SFE-ROUTE')).toBeNull();
    expect(parseExitNodeName('SFE-N-E0001-US01-v018 ')).toBeNull();
  });

  test('rejects invalid names and sequences', () => {
    expect(isSfeName('SFE-N-E0001-US01-v001')).toBe(true);
    expect(isSfeName('SFE-N 1')).toBe(false);
    expect(isSfeName('sfe-x')).toBe(false);
    expect(() => environmentCode(0)).toThrow();
    expect(() => exitNodeName('E0001', 'US01', 0)).toThrow();
    expect(() => exitNodeName('E 1', 'US01', 1)).toThrow();
  });
});

describe('sites', () => {
  test('classifies only exact https www.amazon.com pages', () => {
    expect(classifySiteUrl('US', 'https://www.amazon.com/ap/signin?openid=x')).toBe('signin');
    expect(classifySiteUrl('US', 'https://www.amazon.com/ax/claim/intent')).toBe('signin');
    expect(classifySiteUrl('US', 'https://www.amazon.com/ap/mfa?x')).toBe('mfa');
    expect(classifySiteUrl('US', 'https://www.amazon.com/gp/css/order-history')).toBe('orders');
    expect(classifySiteUrl('US', 'https://www.amazon.com/dp/B000')).toBe('other');
    expect(classifySiteUrl('US', 'http://www.amazon.com/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'https://www.amazon.com.evil.test/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'https://amazon.com/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'https://www.amazon.co.uk/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'https://user:pw@www.amazon.com/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'https://www.amazon.com:8443/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'not a url')).toBe('foreign');
  });
});

describe('redaction helpers', () => {
  test('masks identifiers', () => {
    expect(maskLoginIdentifier('buyer01@example.test')).toBe('b*****1@example.test');
    expect(maskLoginIdentifier('ab@example.test')).toBe('a*@example.test');
    expect(maskLoginIdentifier('+15551234567')).toBe('******4567');
    expect(maskLoginIdentifier(null)).toBeNull();
    expect(shortProfileId('8F1B2C3D-AAAA-BBBB')).toBe('8F1B2C3D');
  });
});

describe('phases, errors, routes', () => {
  test('terminal phases', () => {
    expect(isTerminalPhase('ACTIVE_VERIFIED')).toBe(true);
    expect(isTerminalPhase('VERIFY_ONLY')).toBe(false);
    expect(isTerminalPhase('WAITING_DEPLOYMENT')).toBe(true);
  });

  test('errors serialize without extra fields', () => {
    const e = new SfeError('REVISION_CONFLICT', '保存环境失败：版本已变化', { details: { current: 18 } });
    expect(e.toBody()).toEqual({ code: 'REVISION_CONFLICT', message: '保存环境失败：版本已变化', details: { current: 18 } });
    expect(httpStatusFor('REVISION_CONFLICT')).toBe(409);
    expect(httpStatusFor('INTERNAL')).toBe(500);
  });

  test('route paths are unique and buildable', () => {
    const keys = Object.values(API_ROUTES).map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(buildPath(API_ROUTES.activate.path, { id: 'env_1' })).toBe('/api/environments/env_1/activate');
    expect(() => buildPath(API_ROUTES.activate.path)).toThrow();
  });
});

describe('safari minimum version', () => {
  // Safari 17.6 才修复 “background pages would stop responding after about 30 seconds”
  test('is 17.6', () => {
    expect(SAFARI_MINIMUM_VERSION).toBe('17.6');
  });

  test('compares dotted versions numerically and returns null when unreadable', () => {
    for (const v of ['17.0', '17.5', '17.5.1', '16.6', '17']) expect(safariBelowMinimum(v)).toBe(true);
    for (const v of ['17.6', '17.6.0', '17.6.1', '17.10', '18.0', '18.0.1', '26.0', ' 18.4 ']) expect(safariBelowMinimum(v)).toBe(false);
    for (const v of [null, '', 'unknown', 'demo', '17.x', '18.0 (20619.1.26)', '-17.0']) expect(safariBelowMinimum(v)).toBeNull();
  });
});
