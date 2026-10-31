// 数据库入口：打开、迁移、事务与全部仓库。仓库方法都是同步的（node:sqlite 是同步接口）；
// 跨越 await 的流程（例如写秘密存储）不得放在事务里。

import type { Clock, IdGenerator, Scrubber } from '../ports.js';
import { systemClock } from '../util/clock.js';
import { createIdGenerator } from '../util/ids.js';
import { createScrubber } from '../util/scrubber.js';
import { openDatabase, type Db } from './db.js';
import { createBackupsRepo, type BackupsRepo } from './repos/backups.js';
import { createProfileBindingsRepo, createProfileReportsRepo, type ProfileBindingsRepo, type ProfileReportsRepo } from './repos/bindings.js';
import { createCapabilitiesRepo, createCapabilityProposalsRepo, type CapabilitiesRepo, type CapabilityProposalsRepo } from './repos/capabilities.js';
import type { RepoContext } from './repos/common.js';
import { createDeploymentsRepo, createManagedObjectsRepo, type DeploymentsRepo, type ManagedObjectsRepo } from './repos/deployments.js';
import {
  createAccountsRepo,
  createEnvironmentsRepo,
  createProxyRevisionsRepo,
  type AccountsRepo,
  type EnvironmentsRepo,
  type ProxyRevisionsRepo,
} from './repos/environments.js';
import { createFrontProxiesRepo, type FrontProxiesRepo } from './repos/front-proxies.js';
import { createMetaRepo, type MetaRepo } from './repos/meta.js';
import { createOperationsRepo, createOutboxRepo, type OperationsRepo, type OutboxRepo } from './repos/operations.js';
import { createProbesRepo, createVerificationTestsRepo, type ProbesRepo, type VerificationTestsRepo } from './repos/probes.js';
import { createRouteStateRepo, type RouteStateRepo } from './repos/route-state.js';
import { createSecretRefsRepo, type SecretRefsRepo } from './repos/secret-refs.js';
import { createSettingsRepo, type SettingsRepo } from './repos/settings.js';
import { createLoginCodesRepo, createWebSessionsRepo, type LoginCodesRepo, type WebSessionsRepo } from './repos/web-auth.js';

export { openDatabase, isSqliteExperimentalWarning, type Db, type Row, type RunResult, type SqlParams, type SqlValue } from './db.js';
export { assertNoSecretMaterial, toIso, type InsertOf } from './repos/common.js';
export type { BackupFileEntry, BackupRecord, BackupRuntimeSwitches, BackupsRepo } from './repos/backups.js';
export type { ProfileBindingRecord, ProfileBindingsRepo, ProfileReportRecord, ProfileReportsRepo } from './repos/bindings.js';
export type { CapabilitiesRepo, CapabilityProposalRecord, CapabilityProposalsRepo, CapabilityRecord } from './repos/capabilities.js';
export type {
  DeploymentOperationRecord,
  DeploymentRecord,
  DeploymentState,
  DeploymentsRepo,
  ManagedIntentInput,
  ManagedObjectKind,
  ManagedObjectRecord,
  ManagedObjectState,
  ManagedObjectsRepo,
  NodeManifestEntry,
} from './repos/deployments.js';
export type {
  AccountRecord,
  AccountsRepo,
  BindingStage,
  EnvironmentPatch,
  EnvironmentRecord,
  EnvironmentsRepo,
  ProxyRevisionRecord,
  ProxyRevisionState,
  ProxyRevisionsRepo,
} from './repos/environments.js';
export type { FrontProxiesRepo, FrontProxyRecord } from './repos/front-proxies.js';
export type { MetaRepo } from './repos/meta.js';
export type {
  InitiatorKind,
  OperationInsert,
  OperationPatch,
  OperationRecord,
  OperationStepRecord,
  OperationsRepo,
  OutboxRecord,
  OutboxRepo,
} from './repos/operations.js';
export type { ProbeRecord, ProbesRepo, VerificationPurpose, VerificationTestRecord, VerificationTestsRepo } from './repos/probes.js';
export { defaultRouteState, type RouteStateRecord, type RouteStateRepo } from './repos/route-state.js';
export type { SecretKind, SecretRefRecord, SecretRefState, SecretRefsRepo } from './repos/secret-refs.js';
export {
  SETTING_DEFAULTS,
  isResourcePort,
  type InternalSettingKey,
  type SettingKey,
  type SettingValues,
  type SettingsRepo,
  type WritableSettingKey,
} from './repos/settings.js';
export type { LoginCodeRecord, LoginCodesRepo, WebSessionRecord, WebSessionsRepo } from './repos/web-auth.js';

export interface Repositories {
  readonly db: Db;
  /** 同 db.tx：最外层 BEGIN IMMEDIATE，嵌套为 SAVEPOINT；回调必须同步。 */
  tx<T>(fn: () => T): T;
  environments: EnvironmentsRepo;
  proxyRevisions: ProxyRevisionsRepo;
  frontProxies: FrontProxiesRepo;
  accounts: AccountsRepo;
  profileBindings: ProfileBindingsRepo;
  profileReports: ProfileReportsRepo;
  deployments: DeploymentsRepo;
  managedObjects: ManagedObjectsRepo;
  routeState: RouteStateRepo;
  operations: OperationsRepo;
  outbox: OutboxRepo;
  probes: ProbesRepo;
  verificationTests: VerificationTestsRepo;
  capabilities: CapabilitiesRepo;
  proposals: CapabilityProposalsRepo;
  backups: BackupsRepo;
  secretRefs: SecretRefsRepo;
  webSessions: WebSessionsRepo;
  loginCodes: LoginCodesRepo;
  settings: SettingsRepo;
  meta: MetaRepo;
}

export interface RepositoryOptions {
  /** 自动时间戳来源；缺省为系统时钟。 */
  clock?: Clock;
  /** 自动生成的 id（managed_objects）；缺省为新的生成器。 */
  ids?: IdGenerator;
  /** 步骤消息、错误消息与实测消息写入前的按值脱敏；缺省只按规则脱敏。 */
  scrubber?: Scrubber;
}

/** 数据库须已迁移（db.migrate()）。 */
export function createRepositories(db: Db, opts: RepositoryOptions = {}): Repositories {
  const scrubber = opts.scrubber ?? createScrubber();
  const ctx: RepoContext = {
    db,
    clock: opts.clock ?? systemClock,
    ids: opts.ids ?? createIdGenerator(),
    scrubber,
    scrub: (t: string) => scrubber.scrub(t),
  };
  const frontProxies = createFrontProxiesRepo(ctx);
  return {
    db,
    tx: <T>(fn: () => T): T => db.tx(fn),
    environments: createEnvironmentsRepo(ctx),
    proxyRevisions: createProxyRevisionsRepo(ctx),
    frontProxies,
    accounts: createAccountsRepo(ctx),
    profileBindings: createProfileBindingsRepo(ctx),
    profileReports: createProfileReportsRepo(ctx),
    deployments: createDeploymentsRepo(ctx),
    managedObjects: createManagedObjectsRepo(ctx),
    routeState: createRouteStateRepo(ctx),
    operations: createOperationsRepo(ctx),
    outbox: createOutboxRepo(ctx),
    probes: createProbesRepo(ctx),
    verificationTests: createVerificationTestsRepo(ctx),
    capabilities: createCapabilitiesRepo(ctx),
    proposals: createCapabilityProposalsRepo(ctx),
    backups: createBackupsRepo(ctx),
    secretRefs: createSecretRefsRepo(ctx),
    webSessions: createWebSessionsRepo(ctx),
    loginCodes: createLoginCodesRepo(ctx),
    settings: createSettingsRepo(ctx, frontProxies),
    meta: createMetaRepo(ctx),
  };
}

/** 便捷：打开、迁移并创建仓库。 */
export function openRepositories(path: string | ':memory:', opts: RepositoryOptions = {}): Repositories {
  const db = openDatabase(path);
  db.migrate();
  return createRepositories(db, opts);
}
