/**
 * Binary blob crypto (docs/e2ee.md): the HLENC1 image-byte envelope. Same
 * AES-GCM guarantees as the string path — roundtrip, magic detection, and
 * rejection on wrong key / wrong AAD / tamper.
 */
import { describe, it, expect } from 'vitest';
import { generateDek } from '../../../resources/js/e2ee/crypto';
import { encryptBytes, decryptBytes, hasBlobMagic, BLOB_MAGIC } from '../../../resources/js/e2ee/crypto';

function bytes(...vals) {
  return new Uint8Array(vals);
}

describe('image blob crypto', () => {
  it('round-trips arbitrary bytes', async () => {
    const dek = await generateDek();
    const plain = new Uint8Array(500);
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 7) % 256;

    const blob = await encryptBytes(plain, dek, 'bk1');
    expect(hasBlobMagic(blob)).toBe(true);
    expect(new TextDecoder().decode(blob.subarray(0, 6))).toBe(BLOB_MAGIC);

    const out = await decryptBytes(blob, dek, 'bk1');
    expect(Array.from(out)).toEqual(Array.from(plain));
  });

  it('hasBlobMagic detects HLENC1 and rejects plaintext / short buffers', async () => {
    const dek = await generateDek();
    const blob = await encryptBytes(bytes(1, 2, 3), dek, 'bk1');
    expect(hasBlobMagic(blob)).toBe(true);
    // A real PNG header is not HLENC1
    expect(hasBlobMagic(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(false);
    expect(hasBlobMagic(bytes(1, 2))).toBe(false); // shorter than the magic
  });

  it('rejects the wrong DEK', async () => {
    const blob = await encryptBytes(bytes(9, 9, 9), await generateDek(), 'bk1');
    await expect(decryptBytes(blob, await generateDek(), 'bk1')).rejects.toThrow();
  });

  it('rejects a wrong AAD (cross-book splice)', async () => {
    const dek = await generateDek();
    const blob = await encryptBytes(bytes(9, 9, 9), dek, 'bk1');
    await expect(decryptBytes(blob, dek, 'bk2')).rejects.toThrow();
  });

  it('rejects a tampered blob', async () => {
    const dek = await generateDek();
    const blob = await encryptBytes(bytes(5, 5, 5, 5), dek, 'bk1');
    blob[blob.length - 1] ^= 0xff; // flip a ciphertext byte
    await expect(decryptBytes(blob, dek, 'bk1')).rejects.toThrow();
  });

  it('rejects a non-magic buffer outright', async () => {
    const dek = await generateDek();
    await expect(decryptBytes(bytes(1, 2, 3, 4, 5, 6, 7, 8), dek, 'bk1')).rejects.toThrow(/HLENC1/);
  });
});
