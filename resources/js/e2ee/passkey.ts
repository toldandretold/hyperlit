/**
 * WebAuthn passkey ceremonies for the E2EE vault (docs/e2ee.md).
 *
 * The passkey's PRF extension output is the root secret of the whole scheme:
 * it is evaluated on the authenticator, read from getClientExtensionResults()
 * — and MUST NEVER be sent to the server. serializeCredential() therefore
 * strips ALL client extension results except the boolean `prf.enabled` flag.
 *
 * Registration is two-phase (the PRF output only exists during an assertion):
 *   1. create() the credential → POST /api/passkeys/register
 *   2. get() an assertion scoped to it → PRF output → wrap the vault key →
 *      POST /api/passkeys/{id}/vault-key (first setup includes the recovery blob)
 */

import { ensureCsrfToken } from '../utilities/auth/csrf';
import { toB64Url, fromB64Url } from './envelope';
import {
  createVault,
  wrapVaultKeyForCredential,
  unlockWithPrf,
  unlockWithRecoveryCode,
  unwrapVaultKeyExtractable,
  VAULT_AAD,
} from './keys';
import {
  generateRecoveryCode,
  generateSalt,
  saltFromB64Url,
  deriveRecoveryKek,
  wrapKeyToEnvelope,
  RECOVERY_PBKDF2_ITERATIONS,
} from './crypto';

export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyError';
  }
}

/** The authenticator/platform doesn't support the PRF extension — no vault possible. */
export class PrfUnsupportedError extends PasskeyError {
  constructor() {
    super('This passkey does not support the PRF extension required for encrypted books');
    this.name = 'PrfUnsupportedError';
  }
}

export function isPasskeySupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window;
}

// ── Wire helpers ────────────────────────────────────────────────────

async function apiFetch(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const csrfToken = await ensureCsrfToken();
  if (!csrfToken) throw new PasskeyError("Couldn't start a secure session — please try again");

  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': csrfToken,
    },
    credentials: 'include',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || data.success !== true) {
    throw new PasskeyError(typeof data.error === 'string' ? data.error : `Passkey request failed (${response.status})`);
  }
  return data;
}

// Server option payloads carry b64url strings where the browser API wants BufferSources.
interface WireCreationOptions {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: Array<{ type: string; id: string; transports?: string[] }>;
  [key: string]: unknown;
}

interface WireRequestOptions {
  challenge: string;
  allowCredentials?: Array<{ type: string; id: string; transports?: string[] }>;
  [key: string]: unknown;
}

// PRF extension shapes (not yet in TS's DOM lib on all toolchains).
interface PrfValues {
  first: BufferSource;
}
interface PrfExtensionResults {
  enabled?: boolean;
  results?: { first?: ArrayBuffer };
}

function prepareCreationOptions(wire: WireCreationOptions): PublicKeyCredentialCreationOptions {
  return {
    ...wire,
    challenge: fromB64Url(wire.challenge) as BufferSource,
    user: { ...wire.user, id: fromB64Url(wire.user.id) as BufferSource },
    excludeCredentials: (wire.excludeCredentials ?? []).map((c) => ({
      ...c,
      id: fromB64Url(c.id) as BufferSource,
    })),
  } as unknown as PublicKeyCredentialCreationOptions;
}

function prepareRequestOptions(wire: WireRequestOptions): PublicKeyCredentialRequestOptions {
  return {
    ...wire,
    challenge: fromB64Url(wire.challenge) as BufferSource,
    allowCredentials: (wire.allowCredentials ?? []).map((c) => ({
      ...c,
      id: fromB64Url(c.id) as BufferSource,
    })),
  } as unknown as PublicKeyCredentialRequestOptions;
}

/**
 * PublicKeyCredential → the JSON shape webauthn-lib deserializes.
 * SECURITY: strips every client extension result except `prf.enabled` —
 * the PRF output must never leave this device.
 */
function serializeCredential(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response;
  const ext = credential.getClientExtensionResults() as { prf?: PrfExtensionResults };

  const base: Record<string, unknown> = {
    id: credential.id,
    rawId: toB64Url(new Uint8Array(credential.rawId)),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    clientExtensionResults: ext.prf?.enabled !== undefined ? { prf: { enabled: ext.prf.enabled } } : {},
  };

  if (response instanceof AuthenticatorAttestationResponse) {
    base.response = {
      clientDataJSON: toB64Url(new Uint8Array(response.clientDataJSON)),
      attestationObject: toB64Url(new Uint8Array(response.attestationObject)),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    };
  } else if (response instanceof AuthenticatorAssertionResponse) {
    base.response = {
      clientDataJSON: toB64Url(new Uint8Array(response.clientDataJSON)),
      authenticatorData: toB64Url(new Uint8Array(response.authenticatorData)),
      signature: toB64Url(new Uint8Array(response.signature)),
      userHandle: response.userHandle ? toB64Url(new Uint8Array(response.userHandle)) : null,
    };
  }

  return base;
}

// ── Ceremonies ──────────────────────────────────────────────────────

interface AssertOutcome {
  prfOutput: ArrayBuffer;
  passkey: {
    id: number;
    credential_id: string;
    prf_salt: string;
    wrapped_vault_key: string | null;
    kek_params: Record<string, unknown> | null;
  };
}

/**
 * Run an assertion with PRF evaluation. When `onlyCredentialId` is given the
 * ceremony is scoped to that credential (post-registration bootstrap).
 */
async function assertWithPrf(onlyCredentialId?: string): Promise<AssertOutcome> {
  const optionsResponse = await apiFetch('/api/passkeys/assertion-options', {});
  const wire = optionsResponse.options as WireRequestOptions;
  const prfSalts = (optionsResponse.prf_salts ?? {}) as Record<string, string>;

  if (onlyCredentialId) {
    wire.allowCredentials = (wire.allowCredentials ?? []).filter((c) => c.id === onlyCredentialId);
  }

  const evalByCredential: Record<string, PrfValues> = {};
  for (const descriptor of wire.allowCredentials ?? []) {
    const salt = prfSalts[descriptor.id];
    if (salt) evalByCredential[descriptor.id] = { first: fromB64Url(salt) as BufferSource };
  }

  const publicKey = prepareRequestOptions(wire);
  (publicKey as { extensions?: unknown }).extensions = { prf: { evalByCredential } };

  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new PasskeyError('Passkey prompt was dismissed');

  const ext = credential.getClientExtensionResults() as { prf?: PrfExtensionResults };
  const prfOutput = ext.prf?.results?.first;
  if (!prfOutput) throw new PrfUnsupportedError();

  const assertResponse = await apiFetch('/api/passkeys/assert', {
    credential: serializeCredential(credential),
  });

  return { prfOutput, passkey: assertResponse.passkey as AssertOutcome['passkey'] };
}

export interface RegistrationResult {
  passkeyId: number;
  /** Present on FIRST vault setup — show ONCE, it is never stored anywhere. */
  recoveryCode: string | null;
  /**
   * True when a vault already exists: the new passkey is registered but can't
   * unlock yet — the vault key must be re-wrapped for it via an unlock with an
   * EXISTING passkey (see addPasskeyToVault).
   */
  needsExistingUnlock: boolean;
}

/**
 * Register a new passkey and (on first setup) create the E2EE vault.
 * Throws PrfUnsupportedError if the authenticator can't do PRF.
 */
export async function registerPasskey(name?: string): Promise<RegistrationResult> {
  if (!isPasskeySupported()) throw new PasskeyError('This browser does not support passkeys');

  const listing = await apiFetch('/api/passkeys');
  const hasVault = listing.has_vault === true;

  const optionsResponse = await apiFetch('/api/passkeys/registration-options', {});
  const publicKey = prepareCreationOptions(optionsResponse.options as WireCreationOptions);
  (publicKey as { extensions?: unknown }).extensions = { prf: {} };

  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new PasskeyError('Passkey creation was dismissed');

  const ext = credential.getClientExtensionResults() as { prf?: PrfExtensionResults };
  if (!ext.prf?.enabled) throw new PrfUnsupportedError();

  const registerResponse = await apiFetch('/api/passkeys/register', {
    credential: serializeCredential(credential),
    name: name ?? null,
  });
  const registered = registerResponse.passkey as { id: number; credential_id: string; prf_salt: string };

  // Phase 2: one assertion scoped to the new credential → PRF output.
  const { prfOutput } = await assertWithPrf(registered.credential_id);

  if (hasVault) {
    // Adding a SECOND passkey: wrapping needs an extractable vault key, which
    // only an assertion with an ALREADY-capable passkey can produce. Run it
    // now (one more prompt); if the user dismisses, the passkey stays
    // registered but not vault-capable (linkable later via another unlock).
    try {
      const existing = await assertWithPrf();
      if (!existing.passkey.wrapped_vault_key) {
        throw new PasskeyError('That passkey cannot unlock your books yet — pick one that already can');
      }
      const vaultKey = await unwrapVaultKeyExtractable(
        existing.prfOutput,
        existing.passkey.prf_salt,
        existing.passkey.wrapped_vault_key,
      );
      const wrappedForNew = await wrapVaultKeyForCredential(vaultKey, prfOutput, registered.prf_salt);
      await apiFetch(`/api/passkeys/${registered.id}/vault-key`, {
        wrapped_vault_key: wrappedForNew,
        kek_params: { info: 'hlenc/kek/v1', version: 'v1' },
      });
      return { passkeyId: registered.id, recoveryCode: null, needsExistingUnlock: false };
    } catch {
      return { passkeyId: registered.id, recoveryCode: null, needsExistingUnlock: true };
    }
  }

  const vault = await createVault();
  const wrappedVaultKey = await wrapVaultKeyForCredential(vault.vaultKey, prfOutput, registered.prf_salt);

  await apiFetch(`/api/passkeys/${registered.id}/vault-key`, {
    wrapped_vault_key: wrappedVaultKey,
    kek_params: { info: 'hlenc/kek/v1', version: 'v1' },
    recovery: {
      recovery_wrapped_vault_key: vault.recoveryWrappedVaultKey,
      recovery_kdf_params: vault.recoveryKdfParams,
    },
  });

  return { passkeyId: registered.id, recoveryCode: vault.recoveryCode, needsExistingUnlock: false };
}

/** Unlock the vault with any registered vault-capable passkey. */
export async function unlockVaultWithPasskey(): Promise<void> {
  const { prfOutput, passkey } = await assertWithPrf();
  if (!passkey.wrapped_vault_key) {
    throw new PasskeyError('This passkey is not linked to your encrypted books yet — unlock with another passkey or your recovery code first');
  }
  await unlockWithPrf(prfOutput, passkey.prf_salt, passkey.wrapped_vault_key);
}

/** Unlock the vault with the one-time recovery code. */
export async function unlockVaultWithRecoveryCode(recoveryCode: string): Promise<void> {
  const response = await apiFetch('/api/e2ee/vault');
  const vault = response.vault as {
    recovery_wrapped_vault_key: string;
    recovery_kdf_params: { salt: string; iterations: number };
  };
  await unlockWithRecoveryCode(recoveryCode, vault.recovery_wrapped_vault_key, vault.recovery_kdf_params);
}

/**
 * Rotate the recovery code: unlock via a vault-capable passkey (extractable),
 * mint a fresh code, re-wrap, and replace the server blob. Returns the NEW
 * code — show it once, it is never stored.
 */
export async function rotateRecoveryCode(): Promise<string> {
  const { prfOutput, passkey } = await assertWithPrf();
  if (!passkey.wrapped_vault_key) {
    throw new PasskeyError('That passkey cannot unlock your books — pick one that can');
  }
  const vaultKey = await unwrapVaultKeyExtractable(prfOutput, passkey.prf_salt, passkey.wrapped_vault_key);

  const recoveryCode = generateRecoveryCode();
  const salt = generateSalt(16);
  const recoveryKek = await deriveRecoveryKek(recoveryCode, saltFromB64Url(salt));
  const recoveryWrappedVaultKey = await wrapKeyToEnvelope(vaultKey, recoveryKek, VAULT_AAD);

  await apiFetch('/api/e2ee/vault/recovery', {
    recovery_wrapped_vault_key: recoveryWrappedVaultKey,
    recovery_kdf_params: { alg: 'PBKDF2-SHA256', salt, iterations: RECOVERY_PBKDF2_ITERATIONS, version: 'v1' },
  });

  return recoveryCode;
}

/** GET /api/passkeys listing for the settings UI. */
export async function listPasskeys(): Promise<{
  passkeys: Array<{ id: number; name: string | null; created_at: string; has_vault_key: boolean }>;
  hasVault: boolean;
}> {
  const response = await apiFetch('/api/passkeys');
  return {
    passkeys: response.passkeys as Array<{ id: number; name: string | null; created_at: string; has_vault_key: boolean }>,
    hasVault: response.has_vault === true,
  };
}
