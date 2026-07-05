/**
 * E2EE crypto primitives — WebCrypto only, no app imports (envelope is a leaf).
 *
 * Key hierarchy (all client-side; the server only ever stores wrapped blobs):
 *
 *   passkey PRF output (32B) ── HKDF-SHA256(salt, info) ──► KEK (AES-GCM 256)
 *   recovery code (Crockford) ── PBKDF2-SHA256 ───────────► recovery KEK
 *   vault key (random AES-GCM 256, per account) — wrapped by each KEK
 *   per-book DEK (random AES-GCM 256) — wrapped by the vault key
 *
 * Field encryption is AES-256-GCM with a fresh 12-byte IV per write and
 * AAD = the top-level book id, so ciphertext can't be spliced across books.
 */

import { encodeEnvelope, decodeEnvelope, toB64Url, fromB64Url } from './envelope';

export const HKDF_INFO_KEK = 'hlenc/kek/v1';
export const RECOVERY_PBKDF2_ITERATIONS = 310_000;

const AES_PARAMS: AesKeyGenParams = { name: 'AES-GCM', length: 256 };
const IV_BYTES = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

// ── Key generation ──────────────────────────────────────────────────

/**
 * Generate the account vault key. Extractable so it can be wrapped for the
 * server blobs at creation time — persist only a non-extractable re-import
 * (see keys.ts persistVaultKey).
 */
export function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES_PARAMS, true, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
}

/** Generate a per-book data-encryption key. */
export function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES_PARAMS, true, ['encrypt', 'decrypt']);
}

// ── KEK derivation ──────────────────────────────────────────────────

/** Derive the wrap key from a passkey's PRF output. */
export async function deriveKekFromPrf(prfOutput: BufferSource, salt: Uint8Array): Promise<CryptoKey> {
  const prfKey = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: textEncoder.encode(HKDF_INFO_KEK) },
    prfKey,
    AES_PARAMS,
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/**
 * Derive the recovery wrap key from a recovery code. PBKDF2 is WebCrypto-native;
 * the code itself carries ~120 bits of entropy, so a memory-hard KDF (and its
 * WASM dependency) buys nothing here.
 */
export async function deriveRecoveryKek(
  recoveryCode: string,
  salt: Uint8Array,
  iterations: number = RECOVERY_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(normalizeRecoveryCode(recoveryCode)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    AES_PARAMS,
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

// ── Recovery code ───────────────────────────────────────────────────

// Crockford base32 — no I, L, O, U (visual ambiguity / accidental profanity).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE_CHARS = 24; // 120 bits of entropy

/** Generate a recovery code like "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" (shown once). */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_CHARS);
  let code = '';
  for (let i = 0; i < RECOVERY_CODE_CHARS; i++) {
    // 256 % 32 === 0, so a byte modulo 32 is uniform over the alphabet.
    code += CROCKFORD[(bytes[i] ?? 0) % 32];
    if ((i + 1) % 4 === 0 && i !== RECOVERY_CODE_CHARS - 1) code += '-';
  }
  return code;
}

/** Canonical form for KDF input: strip separators, uppercase, fix ambiguous glyphs. */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

// ── Key wrap / unwrap (envelope-encoded) ────────────────────────────

/** Wrap a key's raw bytes under a wrapping key; returns an hlenc envelope string. */
export async function wrapKeyToEnvelope(key: CryptoKey, wrappingKey: CryptoKey, aad: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const wrapped = await crypto.subtle.wrapKey('raw', key, wrappingKey, {
    name: 'AES-GCM',
    iv: iv as BufferSource,
    additionalData: textEncoder.encode(aad),
  });
  return encodeEnvelope(iv, new Uint8Array(wrapped));
}

export async function unwrapKeyFromEnvelope(
  envelope: string,
  wrappingKey: CryptoKey,
  aad: string,
  options: { extractable?: boolean; usages?: KeyUsage[] } = {},
): Promise<CryptoKey> {
  const { iv, ciphertext } = decodeEnvelope(envelope);
  return crypto.subtle.unwrapKey(
    'raw',
    ciphertext as BufferSource,
    wrappingKey,
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: textEncoder.encode(aad) },
    AES_PARAMS,
    options.extractable ?? false,
    options.usages ?? ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt'],
  );
}

// ── Field encryption ────────────────────────────────────────────────

/** Encrypt a UTF-8 string to an hlenc envelope. AAD binds it to its book. */
export async function encryptString(plaintext: string, dek: CryptoKey, aad: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: textEncoder.encode(aad) },
    dek,
    textEncoder.encode(plaintext),
  );
  return encodeEnvelope(iv, new Uint8Array(ciphertext));
}

/** Decrypt an hlenc envelope back to the original string. Throws on tamper/wrong key/wrong AAD. */
export async function decryptString(envelope: string, dek: CryptoKey, aad: string): Promise<string> {
  const { iv, ciphertext } = decodeEnvelope(envelope);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: textEncoder.encode(aad) },
    dek,
    ciphertext as BufferSource,
  );
  return textDecoder.decode(plaintext);
}

// ── Binary blob encryption (image files — docs/e2ee.md) ─────────────
//
// A raw binary envelope for image bytes (data-URI inlining was rejected for
// bloat/fidelity). Format: magic "HLENC1" (6 bytes) + iv (12) + AES-GCM
// ciphertext. AAD = root book id (same cross-book-splice binding as strings).
// The magic lets both the client and the server-side upload guard recognise a
// ciphertext blob without decrypting it.

export const BLOB_MAGIC = 'HLENC1';
const BLOB_MAGIC_BYTES = new TextEncoder().encode(BLOB_MAGIC); // 6 ASCII bytes

/** Does this byte buffer start with the HLENC1 magic? */
export function hasBlobMagic(bytes: Uint8Array): boolean {
  if (bytes.length < BLOB_MAGIC_BYTES.length) return false;
  for (let i = 0; i < BLOB_MAGIC_BYTES.length; i++) {
    if (bytes[i] !== BLOB_MAGIC_BYTES[i]) return false;
  }
  return true;
}

/** Encrypt raw bytes into a self-describing HLENC1 blob. */
export async function encryptBytes(plain: Uint8Array, dek: CryptoKey, aad: string): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: textEncoder.encode(aad) },
    dek,
    plain as BufferSource,
  ));
  const out = new Uint8Array(BLOB_MAGIC_BYTES.length + IV_BYTES + ciphertext.length);
  out.set(BLOB_MAGIC_BYTES, 0);
  out.set(iv, BLOB_MAGIC_BYTES.length);
  out.set(ciphertext, BLOB_MAGIC_BYTES.length + IV_BYTES);
  return out;
}

/** Decrypt an HLENC1 blob back to the original bytes. Throws on missing magic / tamper / wrong key. */
export async function decryptBytes(blob: Uint8Array, dek: CryptoKey, aad: string): Promise<Uint8Array> {
  if (!hasBlobMagic(blob)) {
    throw new Error('Not an HLENC1 blob');
  }
  const iv = blob.subarray(BLOB_MAGIC_BYTES.length, BLOB_MAGIC_BYTES.length + IV_BYTES);
  const ciphertext = blob.subarray(BLOB_MAGIC_BYTES.length + IV_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: textEncoder.encode(aad) },
    dek,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plain);
}

// ── Misc ────────────────────────────────────────────────────────────

/** Random salt for HKDF (per passkey credential) or PBKDF2 (per recovery code). */
export function generateSalt(length = 32): string {
  return toB64Url(randomBytes(length));
}

export function saltFromB64Url(salt: string): Uint8Array {
  return fromB64Url(salt);
}
