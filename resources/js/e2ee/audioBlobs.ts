/**
 * E2EE audio lock/publish passes (docs/e2ee.md + docs/audio.md §E2EE).
 *
 * TTS MP3s are spoken PLAINTEXT of the book, so the lock pass must cover them:
 * download each plaintext file (owner-authed), encrypt it with the book DEK,
 * and PUT the HLENC1 blob back — the server replaces the bytes in place and
 * flips the row's `encrypted` flag (the book_images pattern, byte for byte).
 * Publish reverses it. Playback for encrypted books decrypts client-side to
 * blob URLs (components/audioPlayer/encryptedAudio.ts). Runs AFTER the content
 * push so a failure here never blocks the (more important) text lock;
 * re-running is idempotent because already-flipped rows are skipped.
 */

import { ensureCsrfToken } from '../utilities/auth/csrf';
import { getDekForBook } from './keys';
import { rootBookId } from './registry';
import { encryptBytes, decryptBytes, hasBlobMagic } from './crypto';
import { runPool, type ProgressFn } from './pool';

interface AudioRow {
  filename: string;
  encrypted: boolean;
}

/**
 * fetch() that waits out 429s (honouring Retry-After) instead of failing —
 * runPool's retries are instant, so without this every retry of a throttled
 * request lands inside the same rate-limit window and the whole pass dies
 * with "upload rejected" (the 2026-07 lock failure).
 */
async function fetchOutlastingThrottle(input: string, init: RequestInit, attempts = 4): Promise<Response> {
  let response = await fetch(input, init);
  for (let i = 0; i < attempts && response.status === 429; i++) {
    const retryAfter = Number(response.headers.get('Retry-After'));
    const waitSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) : 5;
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    response = await fetch(input, init);
  }
  return response;
}

async function listAudio(root: string): Promise<AudioRow[]> {
  const response = await fetch(`/api/books/${encodeURIComponent(root)}/audio`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => ({}))) as { files?: AudioRow[] };
  return data.files ?? [];
}

async function putBytes(root: string, filename: string, bytes: Uint8Array): Promise<boolean> {
  const csrfToken = await ensureCsrfToken();
  if (!csrfToken) return false;
  const response = await fetchOutlastingThrottle(
    `/api/books/${encodeURIComponent(root)}/audio/${encodeURIComponent(filename)}`,
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
  // publish, so ANY cached copy is poison — the unique query defeats service-
  // worker caches too (see imageBlobs.ts for the full CacheFirst-SW war story).
  const bust = `hlfresh=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const response = await fetch(
    `/${encodeURIComponent(root)}/audio/${encodeURIComponent(filename)}?${bust}`,
    { credentials: 'include', cache: 'no-store' },
  );
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Encrypt every still-plaintext audio file of a book. Parallel + retried (a
 * transient fetch/PUT hiccup no longer fails the whole lock); throws only if a
 * file STILL fails after retries. Already-encrypted rows are skipped (idempotent).
 */
export async function encryptBookAudio(bookId: string, onProgress?: ProgressFn): Promise<void> {
  const root = rootBookId(bookId);
  const rows = (await listAudio(root)).filter((r) => !r.encrypted);
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
    throw new Error(`${failures.length} audio file(s) could not be encrypted (${detail}) — run Lock again`);
  }
}

/** Decrypt every still-encrypted audio file of a book (publish). Same robust shape. */
export async function decryptBookAudio(bookId: string, onProgress?: ProgressFn): Promise<void> {
  const root = rootBookId(bookId);
  const rows = (await listAudio(root)).filter((r) => r.encrypted);
  if (!rows.length) return;

  const dek = await getDekForBook(root);
  const reasons = new Map<string, string>();
  const failures = await runPool(rows, async (row) => {
    try {
      const blob = await fetchBytes(root, row.filename); // ciphertext (octet-stream)
      if (!blob) throw new Error('download failed (404/denied)');
      if (!hasBlobMagic(blob)) {
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
    throw new Error(`${failures.length} audio file(s) could not be decrypted (${detail}) — run Publish again`);
  }
}
