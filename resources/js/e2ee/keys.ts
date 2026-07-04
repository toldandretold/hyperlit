/**
 * E2EE key lifecycle — vault creation/unlock, per-book DEK management.
 *
 * The unwrapped vault key lives in two places:
 *  - an in-memory module cache (fast path), and
 *  - the IDB `e2ee` store as a NON-EXTRACTABLE CryptoKey (structured-clone),
 *    so a reload doesn't force a passkey prompt. Local at-rest protection is
 *    deliberately not a goal (IndexedDB holds plaintext content anyway); the
 *    key is wiped with the rest of IDB on logout (clearDatabase).
 *
 * DEKs are unwrapped on demand from `library.wrapped_dek` (root book row) and
 * cached in memory for the session.
 */

import { getConnection } from '../indexedDB/core/connection';
import {
  generateVaultKey,
  generateDek,
  generateRecoveryCode,
  generateSalt,
  saltFromB64Url,
  deriveKekFromPrf,
  deriveRecoveryKek,
  wrapKeyToEnvelope,
  unwrapKeyFromEnvelope,
  RECOVERY_PBKDF2_ITERATIONS,
} from './crypto';
import { rootBookId } from './registry';

/** AAD used when wrapping the vault key itself (not book-bound). */
export const VAULT_AAD = 'hlenc/vault/v1';

const E2EE_STORE = 'e2ee';
const VAULT_RECORD_ID = 'vaultKey';

/** Thrown when an encrypt/decrypt path runs while no vault key is available. */
export class VaultLockedError extends Error {
  constructor(message = 'E2EE vault is locked — passkey unlock required') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

// ── Module state (session caches) ───────────────────────────────────
let vaultKeyCache: CryptoKey | null = null;
const dekCache = new Map<string, CryptoKey>();

// ── IDB persistence ─────────────────────────────────────────────────

async function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await getConnection();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName: string, value: unknown): Promise<void> {
  const db = await getConnection();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await getConnection();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Persist the vault key for reload-survival. The stored copy is always
 * NON-extractable: re-import through raw export only happens transiently at
 * vault creation (where the generated key is extractable by construction).
 */
async function persistVaultKey(vaultKey: CryptoKey): Promise<CryptoKey> {
  let storable = vaultKey;
  if (vaultKey.extractable) {
    const raw = await crypto.subtle.exportKey('raw', vaultKey);
    storable = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
      'wrapKey',
      'unwrapKey',
      'encrypt',
      'decrypt',
    ]);
  }
  await idbPut(E2EE_STORE, { id: VAULT_RECORD_ID, key: storable });
  return storable;
}

// ── Vault lifecycle ─────────────────────────────────────────────────

export interface CreatedVault {
  /** Show ONCE, never stored: the recovery code. */
  recoveryCode: string;
  /** Server blob for user_e2ee_vaults. */
  recoveryWrappedVaultKey: string;
  recoveryKdfParams: { alg: 'PBKDF2-SHA256'; salt: string; iterations: number; version: 'v1' };
  /**
   * The extractable vault key, ONLY so the caller can immediately wrap it for
   * the registering passkey credential (wrapVaultKeyForCredential). Do not hold
   * onto it — the persisted/cached copies are non-extractable.
   */
  vaultKey: CryptoKey;
}

/**
 * Create the account vault: vault key + recovery code + recovery-wrapped blob.
 * Caches and persists the (non-extractable) vault key locally.
 */
export async function createVault(): Promise<CreatedVault> {
  const vaultKey = await generateVaultKey();
  const recoveryCode = generateRecoveryCode();
  const salt = generateSalt(16);
  const recoveryKek = await deriveRecoveryKek(recoveryCode, saltFromB64Url(salt));
  const recoveryWrappedVaultKey = await wrapKeyToEnvelope(vaultKey, recoveryKek, VAULT_AAD);

  vaultKeyCache = await persistVaultKey(vaultKey);

  return {
    recoveryCode,
    recoveryWrappedVaultKey,
    recoveryKdfParams: { alg: 'PBKDF2-SHA256', salt, iterations: RECOVERY_PBKDF2_ITERATIONS, version: 'v1' },
    vaultKey,
  };
}

/** Wrap a vault key under a passkey credential's PRF-derived KEK (registration / add-passkey). */
export async function wrapVaultKeyForCredential(
  vaultKey: CryptoKey,
  prfOutput: BufferSource,
  prfSalt: string,
): Promise<string> {
  const kek = await deriveKekFromPrf(prfOutput, saltFromB64Url(prfSalt));
  return wrapKeyToEnvelope(vaultKey, kek, VAULT_AAD);
}

/** Unlock the vault with a passkey assertion's PRF output. Caches + persists. */
export async function unlockWithPrf(
  prfOutput: BufferSource,
  prfSalt: string,
  wrappedVaultKey: string,
): Promise<void> {
  const kek = await deriveKekFromPrf(prfOutput, saltFromB64Url(prfSalt));
  const vaultKey = await unwrapKeyFromEnvelope(wrappedVaultKey, kek, VAULT_AAD);
  vaultKeyCache = vaultKey;
  await persistVaultKey(vaultKey);
}

/** Unlock the vault with the recovery code. Caches + persists. */
export async function unlockWithRecoveryCode(
  recoveryCode: string,
  recoveryWrappedVaultKey: string,
  kdfParams: { salt: string; iterations: number },
): Promise<void> {
  const kek = await deriveRecoveryKek(recoveryCode, saltFromB64Url(kdfParams.salt), kdfParams.iterations);
  const vaultKey = await unwrapKeyFromEnvelope(recoveryWrappedVaultKey, kek, VAULT_AAD);
  vaultKeyCache = vaultKey;
  await persistVaultKey(vaultKey);
}

/**
 * Transiently unwrap the vault key EXTRACTABLE from a server blob (needed when
 * adding a second passkey or rotating the recovery code). Never cached/persisted.
 */
export async function unwrapVaultKeyExtractable(
  prfOutput: BufferSource,
  prfSalt: string,
  wrappedVaultKey: string,
): Promise<CryptoKey> {
  const kek = await deriveKekFromPrf(prfOutput, saltFromB64Url(prfSalt));
  return unwrapKeyFromEnvelope(wrappedVaultKey, kek, VAULT_AAD, { extractable: true });
}

/** The vault key, from memory or IDB. Null when locked. */
export async function getVaultKey(): Promise<CryptoKey | null> {
  if (vaultKeyCache) return vaultKeyCache;
  const record = await idbGet<{ id: string; key: CryptoKey }>(E2EE_STORE, VAULT_RECORD_ID);
  if (record?.key) {
    vaultKeyCache = record.key;
    return vaultKeyCache;
  }
  return null;
}

export async function isVaultUnlocked(): Promise<boolean> {
  return (await getVaultKey()) !== null;
}

/** Drop the vault key + DEK caches (memory AND the persisted IDB copy). */
export async function lockVault(): Promise<void> {
  vaultKeyCache = null;
  dekCache.clear();
  await idbDelete(E2EE_STORE, VAULT_RECORD_ID);
}

/** Test/logout hook: clear in-memory caches only (IDB wipe handled elsewhere). */
export function clearKeyCaches(): void {
  vaultKeyCache = null;
  dekCache.clear();
}

// ── Per-book DEKs ───────────────────────────────────────────────────

/** Create + wrap a DEK for a new encrypted book. Caches the DEK. */
export async function createDekForBook(bookId: string): Promise<{ wrappedDek: string }> {
  const vaultKey = await getVaultKey();
  if (!vaultKey) throw new VaultLockedError();
  const root = rootBookId(bookId);
  const dek = await generateDek();
  const wrappedDek = await wrapKeyToEnvelope(dek, vaultKey, root);
  dekCache.set(root, dek);
  return { wrappedDek };
}

/**
 * The DEK for a book (sub-books resolve to the root book's DEK). Reads
 * `wrapped_dek` from the root book's library record unless cached.
 * Throws VaultLockedError when the vault key is unavailable.
 */
export async function getDekForBook(bookId: string): Promise<CryptoKey> {
  const root = rootBookId(bookId);
  const cached = dekCache.get(root);
  if (cached) return cached;

  const vaultKey = await getVaultKey();
  if (!vaultKey) throw new VaultLockedError();

  const libraryRecord = await idbGet<{ wrapped_dek?: string }>('library', root);
  const wrappedDek = libraryRecord?.wrapped_dek;
  if (!wrappedDek) {
    throw new Error(`No wrapped DEK for encrypted book ${root}`);
  }
  const dek = await unwrapKeyFromEnvelope(wrappedDek, vaultKey, root, {
    usages: ['encrypt', 'decrypt'],
  });
  dekCache.set(root, dek);
  return dek;
}

/** Seed the DEK cache directly (used right after unwrapping via a server blob). */
export function cacheDekForBook(bookId: string, dek: CryptoKey): void {
  dekCache.set(rootBookId(bookId), dek);
}

/**
 * Bootstrap the DEK cache from a wrapped blob that rides the incoming library
 * row itself (first download of an encrypted book: the IDB library record —
 * getDekForBook's source — doesn't exist yet). No-op when already cached;
 * silent no-op when the vault is locked (the decrypt that follows will throw
 * VaultLockedError with better context).
 */
export async function ensureDekFromWrapped(bookId: string, wrappedDek: string): Promise<void> {
  const root = rootBookId(bookId);
  if (dekCache.has(root)) return;
  const vaultKey = await getVaultKey();
  if (!vaultKey) return;
  const dek = await unwrapKeyFromEnvelope(wrappedDek, vaultKey, root, {
    usages: ['encrypt', 'decrypt'],
  });
  dekCache.set(root, dek);
}
