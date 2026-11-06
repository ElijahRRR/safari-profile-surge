export { isSecretStoreFailure, secretStoreError, type SecretStoreFailureReason } from './errors.js';
export { MemorySecretStore } from './memory-store.js';
export {
  LEGACY_KEYCHAIN_DATA_MESSAGE,
  LocalSecretStore,
  assertNoLegacyKeychainData,
  findLegacyKeychainData,
  type LegacyKeychainData,
  type LocalSecretStoreOptions,
} from './local-store.js';
export { DEFAULT_PENDING_TTL_MS, SecretRefManager, type SecretOwner, type SweepResult } from './secret-ref-manager.js';
export { PEPPER_REF, fingerprint, loadPepper, pepperKey, type PepperPurpose } from './pepper.js';
