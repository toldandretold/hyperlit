/**
 * Client-side audio decryption for encrypted books (docs/audio.md §E2EE).
 *
 * An encrypted book's MP3s are stored as HLENC1 blobs (encrypted in place by
 * the lock pass, e2ee/audioBlobs.ts), so the <audio> element can't stream them
 * from the serve URL. Instead: fetch the blob, decrypt with the book DEK, and
 * hand back an object URL — the lazyLoader/encryptedImages pattern. Per-node
 * files are small (tens of KB), so whole-file decrypt beats losing native
 * Range streaming by nothing the listener can feel.
 *
 * Blob URLs are cached per (book, filename) for the session and revoked
 * wholesale on vault lock / player teardown via clearAudioBlobCache.
 */

// cache key `${book}/${filename}` → resolved blob URL, or an in-flight promise (dedupe)
const blobUrlCache = new Map<string, string | Promise<string>>();

async function decryptToBlobUrl(bookId: string, filename: string): Promise<string> {
  // Bytes at this URL flip plaintext⇄HLENC1 across lock/publish — the unique
  // query defeats service-worker caches (see e2ee/imageBlobs.ts).
  const bust = `hlfresh=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const response = await fetch(
    `/${encodeURIComponent(bookId)}/audio/${encodeURIComponent(filename)}?${bust}`,
    { credentials: 'include', cache: 'no-store' },
  );
  if (!response.ok) throw new Error(`audio fetch ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  const [{ getDekForBook }, { decryptBytes, hasBlobMagic }] = await Promise.all([
    import('../../e2ee/keys'),
    import('../../e2ee/crypto'),
  ]);

  // Mid-lock (the audio pass hasn't reached this file yet) the bytes are
  // still plaintext MP3 — playable as-is, no decrypt needed.
  const plain = hasBlobMagic(bytes)
    ? await decryptBytes(bytes, await getDekForBook(bookId), bookId)
    : bytes;

  return URL.createObjectURL(new Blob([plain as BlobPart], { type: 'audio/mpeg' }));
}

/** Resolve (and cache) the decrypted object URL for one node's audio file. */
export function getDecryptedAudioUrl(bookId: string, filename: string): Promise<string> {
  const key = `${bookId}/${filename}`;
  const cached = blobUrlCache.get(key);
  if (typeof cached === 'string') return Promise.resolve(cached);
  if (cached) return cached;

  const promise = decryptToBlobUrl(bookId, filename)
    .then((url) => {
      blobUrlCache.set(key, url);
      return url;
    })
    .catch((error) => {
      blobUrlCache.delete(key); // allow retry on the next play attempt
      throw error;
    });
  blobUrlCache.set(key, promise);
  return promise;
}

/** Revoke all cached blob URLs (vault lock / player teardown). */
export function clearAudioBlobCache(): void {
  for (const value of blobUrlCache.values()) {
    if (typeof value === 'string') URL.revokeObjectURL(value);
  }
  blobUrlCache.clear();
}
