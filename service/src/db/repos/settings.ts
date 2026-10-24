// 设置：键值表（值为 JSON），带类型与默认值。默认前置的唯一来源是 front_proxies.is_default，
// 这里只做读写转发，避免两处真相不一致。Surge CLI 路径只来自安装配置，不在此处。

import { DEFAULT_VERIFY_ENDPOINT_ID, ENTRY_STRATEGIES, type EntryStrategy, type SettingsView } from '@sfe/contract';
import type { FrontProxiesRepo } from './front-proxies.js';
import { parseJson, toJsonColumn, type RepoContext } from './common.js';

export interface SettingValues {
  /** 只能由维护初始化设置。 */
  workingProfilePath: string | null;
  workingProfileName: string | null;
  /** 只来自已确认的 safari_process_attribution 提议。 */
  safariProcessPaths: string[];
  /** 只来自已确认的 runtime_entry_modes 提议。 */
  entryStrategy: EntryStrategy | null;
  verifyEndpointId: string;
  profileArrivalTimeoutSec: number;
  safariVerifyTimeoutSec: number;
  probeTtlSec: number;
  reconcileIntervalSec: number;
}

export type SettingKey = keyof SettingValues;

export const SETTING_DEFAULTS: Readonly<SettingValues> = Object.freeze({
  workingProfilePath: null,
  workingProfileName: null,
  safariProcessPaths: [],
  entryStrategy: null,
  verifyEndpointId: DEFAULT_VERIFY_ENDPOINT_ID,
  profileArrivalTimeoutSec: 600,
  safariVerifyTimeoutSec: 120,
  probeTtlSec: 900,
  reconcileIntervalSec: 30,
});

const NUMERIC_KEYS: ReadonlySet<SettingKey> = new Set(['profileArrivalTimeoutSec', 'safariVerifyTimeoutSec', 'probeTtlSec', 'reconcileIntervalSec']);

function validate<K extends SettingKey>(key: K, value: SettingValues[K]): void {
  const bad = () => new TypeError(`invalid value for setting ${key}`);
  if (NUMERIC_KEYS.has(key)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw bad();
    return;
  }
  switch (key) {
    case 'workingProfilePath':
    case 'workingProfileName':
      if (value !== null && (typeof value !== 'string' || value.length === 0)) throw bad();
      return;
    case 'safariProcessPaths':
      if (!Array.isArray(value) || value.some((p) => typeof p !== 'string' || p.length === 0)) throw bad();
      return;
    case 'entryStrategy':
      if (value !== null && !(ENTRY_STRATEGIES as readonly unknown[]).includes(value)) throw bad();
      return;
    case 'verifyEndpointId':
      if (typeof value !== 'string' || value.length === 0) throw bad();
      return;
  }
}

function isValid<K extends SettingKey>(key: K, value: unknown): value is SettingValues[K] {
  try {
    validate(key, value as SettingValues[K]);
    return true;
  } catch {
    return false;
  }
}

export interface SettingsRepo {
  /** 未设置或存储值无效时返回默认值。 */
  get<K extends SettingKey>(key: K): SettingValues[K];
  /** 运行时校验类型（整数秒必须为正整数等），不合法抛 TypeError。 */
  set<K extends SettingKey>(key: K, value: SettingValues[K]): void;
  /** 删除存储值，回到默认。 */
  reset(key: SettingKey): void;
  getAll(): SettingValues;
  /** 当前默认前置（来自 front_proxies.is_default，已停用的视为没有默认）。 */
  defaultFrontProxyId(): string | null;
  setDefaultFrontProxyId(id: string | null): boolean;
  /** 组装网页设置视图；surgeCliPath 来自服务配置（安装配置文件）。 */
  view(surgeCliPath: string | null): SettingsView;
}

export function createSettingsRepo(ctx: RepoContext, frontProxies: FrontProxiesRepo): SettingsRepo {
  const { db } = ctx;
  const repo: SettingsRepo = {
    get(key) {
      const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
      if (!row) return cloneDefault(key);
      const parsed = parseJson<unknown>(row.value, undefined);
      return isValid(key, parsed) ? parsed : cloneDefault(key);
    },
    set(key, value) {
      validate(key, value);
      db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, toJsonColumn(value)]);
    },
    reset(key) {
      db.run('DELETE FROM settings WHERE key = ?', [key]);
    },
    getAll() {
      const out = {} as Record<SettingKey, unknown>;
      for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) out[key] = repo.get(key);
      return out as SettingValues;
    },
    defaultFrontProxyId() {
      const d = frontProxies.getDefault();
      return d && !d.retired ? d.id : null;
    },
    setDefaultFrontProxyId(id) {
      return frontProxies.setDefault(id);
    },
    view(surgeCliPath) {
      const all = repo.getAll();
      return {
        surgeCliPath,
        workingProfilePath: all.workingProfilePath,
        entryStrategy: all.entryStrategy,
        safariProcessPaths: all.safariProcessPaths,
        verifyEndpointId: all.verifyEndpointId,
        defaultFrontProxyId: repo.defaultFrontProxyId(),
        profileArrivalTimeoutSec: all.profileArrivalTimeoutSec,
        safariVerifyTimeoutSec: all.safariVerifyTimeoutSec,
        probeTtlSec: all.probeTtlSec,
        reconcileIntervalSec: all.reconcileIntervalSec,
      };
    },
  };
  return repo;
}

function cloneDefault<K extends SettingKey>(key: K): SettingValues[K] {
  const v = SETTING_DEFAULTS[key];
  return (Array.isArray(v) ? [...v] : v) as SettingValues[K];
}
