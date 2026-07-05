/**
 * E2EE image lock/publish passes (docs/e2ee.md).
 *
 * Book content is encrypted at the sync seam, but image BYTES live as separate
 * files in the unified store. To make them E2EE we download each plaintext
 * image (owner-authed), encrypt it with the book DEK, and PUT the HLENC1 blob
 * back — the server replaces the bytes in place and flips the row's `encrypted`
 * flag. Publish reverses it. Runs AFTER the content push so a failure here
 * never blocks the (more important) text lock; re-running is idempotent
 * because already-flipped rows are skipped.
 */

import { ensureCsrfToken } from '../utilities/auth/csrf';
import { getDekForBook } from './keys';
import { rootBookId } from './registry';
import { encryptBytes, decryptBytes, hasBlobMagic } from './crypto';
import { runPool, type ProgressFn } from './pool';

interface ImageRow {
  filename: string;
  mime: string;
  encrypted: boolean;
}

async function listImages(root: string): Promise<ImageRow[]> {
  const response = await fetch(`/api/books/${encodeURIComponent(root)}/images`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => ({}))) as { images?: ImageRow[] };
  return data.images ?? [];
}

async function putBytes(root: string, filename: string, bytes: Uint8Array): Promise<boolean> {
  const csrfToken = await ensureCsrfToken();
  if (!csrfToken) return false;
  const response = await fetch(
    `/api/books/${encodeURIComponent(root)}/images/${encodeURIComponent(filename)}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-XSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
      body: bytes as BodyInit,
    },
  );
  return response.ok;
}

async function fetchBytes(root: string, filename: string): Promise<Uint8Array | null> {
  // The bytes at this URL flip between plaintext and HLENC1 across a lock/
  // publish, so ANY cached copy is poison. `cache:'no-store'` covers the HTTP
  // cache but does NOT bypass a service worker — and an old CacheFirst SW that
  // hasn't updated yet will happily serve the stale plaintext it cached during
  // the lock (the deterministic "N image(s) could not be decrypted" bug). A
  // unique query string defeats every SW version: cache lookups match the full
  // URL, so a never-seen URL can never hit a cached ghost.
  const bust = `hlfresh=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const response = await fetch(
    `/${encodeURIComponent(root)}/media/${encodeURIComponent(filename)}?${bust}`,
    { credentials: 'include', cache: 'no-store' },
  );
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Encrypt every still-plaintext image of a book tree. Parallel + retried (a
 * transient fetch/PUT hiccup no longer fails the whole lock); throws only if an
 * image STILL fails after retries. Already-encrypted rows are skipped (idempotent).
 */
export async function encryptBookImages(bookId: string, onProgress?: ProgressFn): Promise<void> {
  const root = rootBookId(bookId);
  const rows = (await listImages(root)).filter((r) => !r.encrypted);
  if (!rows.length) return;

  const dek = await getDekForBook(root);
  const reasons = new Map<string, string>();
  const failures = await runPool(rows, async (row) => {
    try {
      const plain = await fetchBytes(root, row.filename);
      if (!plain) throw new Error('download failed (404/denied)');
      if (hasBlobMagic(plain)) throw new Error('already ciphertext but row says plaintext (stale flag)');
      const blob = await encryptBytes(plain, dek, root);
      if (!(await putBytes(root, row.filename, blob))) throw new Error('upload rejected');
    } catch (error) {
      reasons.set(row.filename, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, { onProgress });

  if (failures.length) {
    const detail = failures.map((f) => `${f.filename}: ${reasons.get(f.filename) ?? '?'}`).join('; ');
    throw new Error(`${failures.length} image(s) could not be encrypted (${detail}) — run Lock again`);
  }
}

/** Decrypt every still-encrypted image of a book tree (publish). Same robust shape. */
export async function decryptBookImages(bookId: string, onProgress?: ProgressFn): Promise<void> {
  const root = rootBookId(bookId);
  const rows = (await listImages(root)).filter((r) => r.encrypted);
  if (!rows.length) return;

  const dek = await getDekForBook(root);
  const reasons = new Map<string, string>();
  const failures = await runPool(rows, async (row) => {
    try {
      const blob = await fetchBytes(root, row.filename); // ciphertext (octet-stream)
      if (!blob) throw new Error('download failed (404/denied)');
      if (!hasBlobMagic(blob)) {
        // The server holds HLENC1 but we received something else → a cache
        // (service worker / proxy) served a stale pre-lock plaintext copy.
        throw new Error(`received ${blob.length}B of NON-ciphertext (stale cache?)`);
      }
      const plain = await decryptBytes(blob, dek, root);
      if (!(await putBytes(root, row.filename, plain))) throw new Error('upload rejected');
    } catch (error) {
      reasons.set(row.filename, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, { onProgress });

  if (failures.length) {
    const detail = failures.map((f) => `${f.filename}: ${reasons.get(f.filename) ?? '?'}`).join('; ');
    throw new Error(`${failures.length} image(s) could not be decrypted (${detail}) — run Publish again`);
  }
}
