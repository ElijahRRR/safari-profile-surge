export { isSecretStoreFailure, secretStoreError, type SecretStoreFailureReason } from './errors.js';
export { MemorySecretStore } from './memory-store.js';
export {
  DEFAULT_KEYCHAIN_TIMEOUT_MS,
  KEYCHAIN_HELPER_ARGS,
  KeychainHelperStore,
  type KeychainHelperStoreOptions,
  type SpawnFn,
} from './keychain-helper-store.js';
export { DEFAULT_PENDING_TTL_MS, SecretRefManager, type SecretOwner, type SweepResult } from './secret-ref-manager.js';
export { PEPPER_REF, fingerprint, loadPepper, pepperKey, type PepperPurpose } from './pepper.js';
