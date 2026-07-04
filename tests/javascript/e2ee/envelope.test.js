/**
 * Envelope format — the self-describing `hlenc.v1.<iv>.<ct>` string and its
 * `{__hlenc__}` jsonb wrapper. Detection must be exact: the download path
 * runs isEnvelope on EVERY content field of every book, so false positives
 * would corrupt plaintext books.
 */
import { describe, it, expect } from 'vitest';
import {
  toB64Url,
  fromB64Url,
  isEnvelope,
  encodeEnvelope,
  decodeEnvelope,
  wrapJsonEnvelope,
  isJsonEnvelope,
  unwrapJsonEnvelope,
} from '../../../resources/js/e2ee/envelope';

describe('base64url', () => {
  it('round-trips arbitrary bytes, including padding edge lengths', () => {
    for (const len of [0, 1, 2, 3, 4, 12, 31, 32, 33]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) % 256;
      expect(Array.from(fromB64Url(toB64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('emits url-safe output (no +, /, =)', () => {
    const bytes = new Uint8Array([251, 255, 191, 62, 63, 254]);
    const encoded = toB64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('string envelope', () => {
  const iv = new Uint8Array(12).fill(7);
  const ct = new Uint8Array([1, 2, 3, 250, 251, 252]);

  it('encodes and decodes', () => {
    const envelope = encodeEnvelope(iv, ct);
    expect(envelope.startsWith('hlenc.v1.')).toBe(true);
    const decoded = decodeEnvelope(envelope);
    expect(Array.from(decoded.iv)).toEqual(Array.from(iv));
    expect(Array.from(decoded.ciphertext)).toEqual(Array.from(ct));
  });

  it('isEnvelope accepts a well-formed envelope', () => {
    expect(isEnvelope(encodeEnvelope(iv, ct))).toBe(true);
  });

  it('isEnvelope rejects non-envelopes', () => {
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope(undefined)).toBe(false);
    expect(isEnvelope(42)).toBe(false);
    expect(isEnvelope('')).toBe(false);
    expect(isEnvelope('<p>hlenc.v1.abc.def</p>')).toBe(false); // prefix not at start
    expect(isEnvelope('hlenc.v1.abc')).toBe(false); // missing segment
    expect(isEnvelope('hlenc.v1.abc.def.ghi')).toBe(false); // extra segment
    expect(isEnvelope('hlenc.v2.abc.def')).toBe(false); // unknown version
    expect(isEnvelope('hlenc.v1.a+b.def')).toBe(false); // non-url-safe chars
    expect(isEnvelope('hlenc.v1..def')).toBe(false); // empty iv segment
    // Ordinary book content that merely mentions the prefix
    expect(isEnvelope('hlenc.v1 is the envelope format')).toBe(false);
  });

  it('decodeEnvelope throws on a non-envelope', () => {
    expect(() => decodeEnvelope('not an envelope')).toThrow();
  });

  it('contains no "<" so NodeHtmlSanitizer no-tag early-return passes it through', () => {
    expect(encodeEnvelope(iv, ct)).not.toContain('<');
  });
});

describe('jsonb envelope wrapper', () => {
  const envelope = encodeEnvelope(new Uint8Array(12), new Uint8Array([9, 9]));

  it('wraps and unwraps', () => {
    const wrapped = wrapJsonEnvelope(envelope);
    expect(wrapped).toEqual({ __hlenc__: envelope });
    expect(isJsonEnvelope(wrapped)).toBe(true);
    expect(unwrapJsonEnvelope(wrapped)).toBe(envelope);
  });

  it('rejects lookalikes', () => {
    expect(isJsonEnvelope(null)).toBe(false);
    expect(isJsonEnvelope([envelope])).toBe(false);
    expect(isJsonEnvelope({ __hlenc__: 'not an envelope' })).toBe(false);
    expect(isJsonEnvelope({ __hlenc__: envelope, extra: 1 })).toBe(false);
    expect(isJsonEnvelope({ other: envelope })).toBe(false);
  });
});
