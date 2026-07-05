/**
 * Render-time image decrypt-hydration (docs/e2ee.md): swaps an encrypted
 * book's /{book}/media/ <img> srcs to decrypted blob: URLs on the live nodes,
 * caches per src, restores canonical for the save path, and revokes on
 * teardown. Plaintext books early-exit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFreshIndexedDB, seedStore } from '../indexedDB/idbHarness.js';
import { createVault, createDekForBook, getDekForBook, clearKeyCaches } from '../../../resources/js/e2ee/keys';
import { setBookEncrypted, clearEncryptedBookRegistry } from '../../../resources/js/e2ee/registry';
import { encryptBytes } from '../../../resources/js/e2ee/crypto';
import {
  hydrateEncryptedImages,
  restoreCanonicalImageSrcs,
  clearImageBlobCache,
} from '../../../resources/js/lazyLoader/encryptedImages';

const ENC = 'encbook';
let dek;
let ciphertext;
let revoked;
let blobCounter;

beforeEach(async () => {
  installFreshIndexedDB();
  clearKeyCaches();
  clearEncryptedBookRegistry();
  clearImageBlobCache();
  document.body.innerHTML = '';

  await createVault();
  const { wrappedDek } = await createDekForBook(ENC);
  await seedStore('library', [{ book: ENC, encrypted: true, wrapped_dek: wrappedDek }]);
  setBookEncrypted(ENC, true);
  dek = await getDekForBook(ENC);

  // The ciphertext the media route would serve for the encrypted image
  const plain = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  ciphertext = await encryptBytes(plain, dek, ENC);

  global.fetch = vi.fn(async (url) => ({
    ok: url.includes('/media/'),
    status: url.includes('/media/') ? 200 : 404,
    arrayBuffer: async () => ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength),
  }));

  // happy-dom lacks a real object-URL impl — stub it deterministically
  revoked = [];
  blobCounter = 0;
  global.URL.createObjectURL = vi.fn(() => `blob:mock/${++blobCounter}`);
  global.URL.revokeObjectURL = vi.fn((u) => revoked.push(u));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function containerWith(src) {
  const div = document.createElement('div');
  div.innerHTML = `<p><img src="${src}"></p>`;
  return div;
}

describe('hydrateEncryptedImages', () => {
  it('swaps a media src to a blob URL and stashes the canonical for restore', async () => {
    const container = containerWith(`/${ENC}/media/fig.png`);
    await hydrateEncryptedImages(container, ENC);

    const img = container.querySelector('img');
    expect(img.getAttribute('src')).toBe('blob:mock/1');
    expect(img.dataset.hlSrc).toBe(`/${ENC}/media/fig.png`);
    expect(img.classList.contains('e2ee-img-loading')).toBe(false);
  });

  it('is a no-op for a plaintext book (no fetch, no swap)', async () => {
    setBookEncrypted(ENC, false);
    const container = containerWith(`/${ENC}/media/fig.png`);
    await hydrateEncryptedImages(container, ENC);

    expect(container.querySelector('img').getAttribute('src')).toBe(`/${ENC}/media/fig.png`);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('caches per canonical src — the same image decrypts once across chunks', async () => {
    await hydrateEncryptedImages(containerWith(`/${ENC}/media/fig.png`), ENC);
    await hydrateEncryptedImages(containerWith(`/${ENC}/media/fig.png`), ENC);

    // Two renders, ONE decrypt/fetch/objectURL
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.URL.createObjectURL).toHaveBeenCalledTimes(1);
    // Must bypass the HTTP/SW cache — the media URL's bytes flip plaintext⇄HLENC1
    // across lock/publish, so a cached plaintext copy would fail the magic check.
    expect(global.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache: 'no-store' }));
  });

  it('marks the image locked (placeholder) when decryption fails', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer }));
    const container = containerWith(`/${ENC}/media/fig.png`);
    await hydrateEncryptedImages(container, ENC);

    const img = container.querySelector('img');
    expect(img.classList.contains('e2ee-img-locked')).toBe(true);
    expect(img.getAttribute('src')).toBe(`/${ENC}/media/fig.png`); // NOT a blob url
  });

  it('restoreCanonicalImageSrcs turns a serialized blob src back to canonical', async () => {
    const container = containerWith(`/${ENC}/media/fig.png`);
    await hydrateEncryptedImages(container, ENC);
    const html = container.innerHTML; // contains blob:mock/1
    expect(html).toContain('blob:mock/1');

    const restored = restoreCanonicalImageSrcs(html);
    expect(restored).toContain(`/${ENC}/media/fig.png`).not.toContain('blob:mock/1');
  });

  it('clearImageBlobCache revokes every blob URL', async () => {
    await hydrateEncryptedImages(containerWith(`/${ENC}/media/a.png`), ENC);
    await hydrateEncryptedImages(containerWith(`/${ENC}/media/b.png`), ENC);
    clearImageBlobCache();
    expect(revoked.sort()).toEqual(['blob:mock/1', 'blob:mock/2']);
  });
});
