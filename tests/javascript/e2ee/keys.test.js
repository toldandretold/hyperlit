/**
 * Key lifecycle — vault create/unlock (PRF + recovery code), per-book DEKs,
 * reload-survival via the IDB e2ee store. PRF output is stubbed as random
 * bytes: the WebAuthn ceremony itself is exercised in e2e, not here — what
 * matters is that the SAME prf bytes always reopen the vault and different
 * bytes never do.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne } from '../indexedDB/idbHarness.js';
import {
  createVault,
  wrapVaultKeyForCredential,
  unlockWithPrf,
  unlockWithRecoveryCode,
  unwrapVaultKeyExtractable,
  getVaultKey,
  isVaultUnlocked,
  lockVault,
  clearKeyCaches,
  createDekForBook,
  getDekForBook,
  VaultLockedError,
} from '../../../resources/js/e2ee/keys';
import { generateSalt } from '../../../resources/js/e2ee/crypto';
import { encryptString, decryptString } from '../../../resources/js/e2ee/crypto';

function stubPrfOutput(seed = 1) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (i * seed + seed) % 256;
  return bytes;
}

beforeEach(async () => {
  installFreshIndexedDB();
  clearKeyCaches();
});

describe('vault creation', () => {
  it('creates a vault with a formatted recovery code and enveloped blobs', async () => {
    const vault = await createVault();
    expect(vault.recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(vault.recoveryWrappedVaultKey).toMatch(/^hlenc\.v1\./);
    expect(vault.recoveryKdfParams.alg).toBe('PBKDF2-SHA256');
    expect(vault.recoveryKdfParams.iterations).toBeGreaterThanOrEqual(310000);
    expect(await isVaultUnlocked()).toBe(true);
  });

  it('persists a NON-extractable vault key to the e2ee store', async () => {
    await createVault();
    const record = await readOne('e2ee', 'vaultKey');
    expect(record).toBeTruthy();
    expect(record.key.extractable).toBe(false);
  });
});

describe('passkey (PRF) unlock', () => {
  it('round-trips: wrap for credential, lock, unlock with same PRF output', async () => {
    const vault = await createVault();
    const prf = stubPrfOutput(3);
    const prfSalt = generateSalt();
    const wrapped = await wrapVaultKeyForCredential(vault.vaultKey, prf, prfSalt);

    await lockVault();
    expect(await isVaultUnlocked()).toBe(false);

    await unlockWithPrf(prf, prfSalt, wrapped);
    expect(await isVaultUnlocked()).toBe(true);
  });

  it('rejects a different PRF output', async () => {
    const vault = await createVault();
    const prfSalt = generateSalt();
    const wrapped = await wrapVaultKeyForCredential(vault.vaultKey, stubPrfOutput(3), prfSalt);
    await lockVault();
    await expect(unlockWithPrf(stubPrfOutput(4), prfSalt, wrapped)).rejects.toThrow();
    expect(await isVaultUnlocked()).toBe(false);
  });

  it('unwrapVaultKeyExtractable yields an extractable key for re-wrapping flows', async () => {
    const vault = await createVault();
    const prf = stubPrfOutput(5);
    const prfSalt = generateSalt();
    const wrapped = await wrapVaultKeyForCredential(vault.vaultKey, prf, prfSalt);
    const extractable = await unwrapVaultKeyExtractable(prf, prfSalt, wrapped);
    expect(extractable.extractable).toBe(true);
    // And it is the SAME key: a second credential wrapped with it can unlock.
    const salt2 = generateSalt();
    const wrapped2 = await wrapVaultKeyForCredential(extractable, stubPrfOutput(6), salt2);
    await lockVault();
    await unlockWithPrf(stubPrfOutput(6), salt2, wrapped2);
    expect(await isVaultUnlocked()).toBe(true);
  });
});

describe('recovery code unlock', () => {
  it('unlocks with the exact code and with a sloppily-typed variant', async () => {
    const vault = await createVault();
    await lockVault();

    await unlockWithRecoveryCode(vault.recoveryCode, vault.recoveryWrappedVaultKey, vault.recoveryKdfParams);
    expect(await isVaultUnlocked()).toBe(true);

    await lockVault();
    // lowercase, no dashes — normalizeRecoveryCode must absorb this
    const sloppy = vault.recoveryCode.toLowerCase().replace(/-/g, '');
    await unlockWithRecoveryCode(sloppy, vault.recoveryWrappedVaultKey, vault.recoveryKdfParams);
    expect(await isVaultUnlocked()).toBe(true);
  });

  it('rejects a wrong code', async () => {
    const vault = await createVault();
    await lockVault();
    const wrong = vault.recoveryCode.replace(/[0-9A-Z]$/, (c) => (c === 'X' ? 'Y' : 'X'));
    await expect(
      unlockWithRecoveryCode(wrong, vault.recoveryWrappedVaultKey, vault.recoveryKdfParams),
    ).rejects.toThrow();
  });
});

describe('reload survival (IDB persistence)', () => {
  it('getVaultKey recovers from the e2ee store after the in-memory cache is dropped', async () => {
    await createVault();
    clearKeyCaches(); // simulates a page reload (module state gone, IDB intact)
    expect(await isVaultUnlocked()).toBe(true);
    expect((await getVaultKey()).extractable).toBe(false);
  });

  it('lockVault removes the persisted key too', async () => {
    await createVault();
    await lockVault();
    clearKeyCaches();
    expect(await isVaultUnlocked()).toBe(false);
    expect(await readOne('e2ee', 'vaultKey')).toBeUndefined();
  });
});

describe('per-book DEKs', () => {
  it('createDekForBook returns a wrapped DEK usable after re-unwrap via the library record', async () => {
    await createVault();
    const { wrappedDek } = await createDekForBook('bk1');
    expect(wrappedDek).toMatch(/^hlenc\.v1\./);

    await seedStore('library', [{ book: 'bk1', wrapped_dek: wrappedDek }]);
    clearKeyCaches(); // force the unwrap path (reload: DEK cache gone, vault in IDB)

    const dek = await getDekForBook('bk1');
    const roundTripped = await decryptString(await encryptString('secret', dek, 'bk1'), dek, 'bk1');
    expect(roundTripped).toBe('secret');
  });

  it('sub-book ids resolve to the ROOT book DEK', async () => {
    await createVault();
    const { wrappedDek } = await createDekForBook('bk1');
    await seedStore('library', [{ book: 'bk1', wrapped_dek: wrappedDek }]);
    clearKeyCaches();

    const rootDek = await getDekForBook('bk1');
    const subDek = await getDekForBook('bk1/Fn12');
    // Same underlying key: ciphertext from one decrypts with the other.
    const envelope = await encryptString('x', rootDek, 'bk1');
    expect(await decryptString(envelope, subDek, 'bk1')).toBe('x');
  });

  it('throws VaultLockedError when locked, and a plain Error when the book has no wrapped DEK', async () => {
    await expect(getDekForBook('bk1')).rejects.toBeInstanceOf(VaultLockedError);

    await createVault();
    await seedStore('library', [{ book: 'bk2' }]); // no wrapped_dek
    await expect(getDekForBook('bk2')).rejects.toThrow(/No wrapped DEK/);
  });
});
