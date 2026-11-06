// 本机节点资源（D10）的 key 安全检查：只有形状确定不可能含读取令牌的 key 才能经 CLI（argv）更新。合成令牌与地址。

import { describe, expect, test } from 'vitest';
import { nodeResourceUrl } from '@sfe/contract';
import {
  RESOURCE_KEY_NEEDS_HTTP_MESSAGE,
  RESOURCE_UPDATE_UNMAPPED_MESSAGE,
  canUseCliForResourceKey,
  resourceUpdateRoute,
} from '../../src/surge/resource-key.js';
import * as surge from '../../src/surge/index.js';

const TOKEN = '5a'.repeat(32);
const URL = nodeResourceUrl(20001, TOKEN);
const SAFE_KEY = '0123456789abcdef0123456789abcdef';

describe('canUseCliForResourceKey', () => {
  test('accepts exactly 32 lower-case hex characters unrelated to the token', () => {
    expect(canUseCliForResourceKey(SAFE_KEY, TOKEN)).toBe(true);
  });

  test.each([
    ['the URL itself', URL],
    ['the token', TOKEN],
    ['half of the token', TOKEN.slice(0, 32)],
    ['the second half of the token', TOKEN.slice(32)],
    ['upper-case hex', SAFE_KEY.toUpperCase()],
    ['31 hex characters', SAFE_KEY.slice(1)],
    ['33 hex characters', `${SAFE_KEY}0`],
    ['a path', `${SAFE_KEY.slice(0, 16)}/${SAFE_KEY.slice(17)}`],
    ['a colon', `policy-path:${SAFE_KEY}`],
    ['a percent escape', `%2F${SAFE_KEY.slice(3)}`],
    ['an empty key', ''],
    ['a non-hex opaque key', 'policy-path:sfe-nodes.list'],
  ])('refuses %s', (_name, key) => {
    expect(canUseCliForResourceKey(key, TOKEN)).toBe(false);
  });

  test('fails closed without a usable token or with non-string input', () => {
    expect(canUseCliForResourceKey(SAFE_KEY, '')).toBe(false);
    expect(canUseCliForResourceKey(SAFE_KEY as unknown as string, null as unknown as string)).toBe(false);
    expect(canUseCliForResourceKey(42 as unknown as string, TOKEN)).toBe(false);
  });

  test('a key that is part of the token is refused even when it has the safe shape', () => {
    const token = `${SAFE_KEY}${'f'.repeat(32)}`;
    expect(canUseCliForResourceKey(SAFE_KEY, token)).toBe(false);
  });
});

describe('resourceUpdateRoute', () => {
  test('HTTP carries the key in the request body: any key may use it', () => {
    expect(resourceUpdateRoute({ updateExternalResource: 'http' }, URL, TOKEN)).toEqual({ kind: 'http' });
    expect(resourceUpdateRoute({ updateExternalResource: 'http' }, SAFE_KEY, TOKEN)).toEqual({ kind: 'http' });
  });

  test('CLI only for a key that cannot contain the token; otherwise park with the fixed text', () => {
    expect(resourceUpdateRoute({ updateExternalResource: 'cli' }, SAFE_KEY, TOKEN)).toEqual({ kind: 'cli' });
    const parked = resourceUpdateRoute({ updateExternalResource: 'cli' }, URL, TOKEN);
    expect(parked).toEqual({ kind: 'park', reason: 'key_unsafe_for_cli', message: RESOURCE_KEY_NEEDS_HTTP_MESSAGE });
    expect(RESOURCE_KEY_NEEDS_HTTP_MESSAGE).toBe('更新本机节点资源必须经 Surge HTTP API：资源标识可能含读取令牌，不能出现在命令行参数中');
    expect(JSON.stringify(parked)).not.toContain(TOKEN);
  });

  test('the fake mechanism follows the CLI rule (tests and demo cover the parked path)', () => {
    expect(resourceUpdateRoute({ updateExternalResource: 'fake' }, SAFE_KEY, TOKEN)).toEqual({ kind: 'fake' });
    expect(resourceUpdateRoute({ updateExternalResource: 'fake' }, `policy-path:${URL}`, TOKEN)).toMatchObject({ kind: 'park', reason: 'key_unsafe_for_cli' });
  });

  test('an unmapped or unavailable primitive parks', () => {
    for (const mechanism of [{}, { updateExternalResource: 'unavailable' as const }, { updateExternalResource: undefined }]) {
      expect(resourceUpdateRoute(mechanism, SAFE_KEY, TOKEN)).toEqual({ kind: 'park', reason: 'unmapped', message: RESOURCE_UPDATE_UNMAPPED_MESSAGE });
    }
  });

  test('is exported from the surge entry point', () => {
    expect(surge.canUseCliForResourceKey).toBe(canUseCliForResourceKey);
    expect(surge.resourceUpdateRoute).toBe(resourceUpdateRoute);
  });
});
