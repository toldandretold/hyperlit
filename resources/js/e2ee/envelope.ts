/**
 * E2EE envelope format — zero-import leaf.
 *
 * A ciphertext travelling to/from the server is a self-describing string:
 *
 *   hlenc.v1.<base64url(iv)>.<base64url(ciphertext)>
 *
 * so both sides can detect encrypted values by prefix alone (no flags needed
 * on the read path), and the version segment lets us rotate primitives later.
 *
 * JSONB columns can't hold a bare string without changing their shape, so an
 * encrypted JSON value is wrapped as a single-key object:
 *
 *   { "__hlenc__": "hlenc.v1...." }
 *
 * NOTE: envelopes deliberately contain no '<' so they pass unchanged through
 * NodeHtmlSanitizer::clean()'s no-tag early return on the server.
 */

export const ENVELOPE_PREFIX = 'hlenc';
export const ENVELOPE_VERSION = 'v1';
const ENVELOPE_HEAD = `${ENVELOPE_PREFIX}.${ENVELOPE_VERSION}.`;

/** Key of the jsonb wrapper object. */
export const JSON_ENVELOPE_KEY = '__hlenc__';

// base64url alphabet only — anything else in a segment means "not an envelope".
const B64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function toB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Is this value an encrypted string envelope? */
export function isEnvelope(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(ENVELOPE_HEAD)) return false;
  const segments = value.split('.');
  return (
    segments.length === 4 &&
    B64URL_SEGMENT.test(segments[2] ?? '') &&
    B64URL_SEGMENT.test(segments[3] ?? '')
  );
}

export function encodeEnvelope(iv: Uint8Array, ciphertext: Uint8Array): string {
  return `${ENVELOPE_HEAD}${toB64Url(iv)}.${toB64Url(ciphertext)}`;
}

export function decodeEnvelope(envelope: string): { iv: Uint8Array; ciphertext: Uint8Array } {
  if (!isEnvelope(envelope)) {
    throw new Error('Not an hlenc envelope');
  }
  const [, , iv = '', ct = ''] = envelope.split('.');
  return { iv: fromB64Url(iv), ciphertext: fromB64Url(ct) };
}

/** Wrap an envelope string for storage in a jsonb column. */
export function wrapJsonEnvelope(envelope: string): Record<string, string> {
  return { [JSON_ENVELOPE_KEY]: envelope };
}

/** Is this value the jsonb form of an encrypted field? */
export function isJsonEnvelope(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    isEnvelope((value as Record<string, unknown>)[JSON_ENVELOPE_KEY])
  );
}

export function unwrapJsonEnvelope(value: Record<string, string>): string {
  return value[JSON_ENVELOPE_KEY] ?? '';
}
