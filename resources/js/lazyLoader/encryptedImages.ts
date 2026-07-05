/**
 * Render-time image decryption for encrypted books (docs/e2ee.md).
 *
 * Stored content always keeps the canonical `/{book}/media/{file}` src (so it
 * survives DOMPurify — which strips `blob:` from HTML — and never persists a
 * blob URL). For an ENCRYPTED book that src serves an HLENC1 ciphertext blob,
 * so at render time we fetch it, decrypt with the book DEK, and swap the img's
 * src to an object URL via JS PROPERTY assignment (post-sanitize, never through
 * the HTML string). Plaintext books early-exit at zero cost.
 *
 * Blob URLs are cached per canonical src for the session (trimWindow churns
 * chunks on every scroll — revoking per chunk-remove would thrash re-decrypts)
 * and revoked wholesale on vault lock / book teardown via clearImageBlobCache.
 */

import { verbose } from '../utilities/logger';
import { isBookEncrypted, rootBookId } from '../e2ee/registry';

// canonical src → resolved blob URL, or an in-flight promise (dedupe)
const blobUrlCache = new Map<string, string | Promise<string>>();
// blob URL → canonical src, so the save path can restore the stored src
const canonicalBySrc = new Map<string, string>();

const MEDIA_RE = /^\/([^/]+)\/media\/([^/?#]+)$/;

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

function mimeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

async function decryptToBlobUrl(canonical: string): Promise<string> {
  const match = canonical.match(MEDIA_RE);
  if (!match) throw new Error(`Not a media src: ${canonical}`);
  const root = decodeURIComponent(match[1] ?? '');
  const filename = decodeURIComponent(match[2] ?? '');

  // This URL's bytes flip plaintext⇄HLENC1 across lock/publish, so ANY cached
  // copy can be the wrong form. `no-store` covers the HTTP cache; the unique
  // query defeats service-worker caches too (an old CacheFirst SW that hasn't
  // updated serves stale bytes regardless of request cache mode — lookups match
  // the full URL, so a never-seen URL can't hit a cached ghost).
  const bust = `hlfresh=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const response = await fetch(`${canonical}?${bust}`, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(`media fetch ${response.status}`);
  const ciphertext = new Uint8Array(await response.arrayBuffer());

  const [{ getDekForBook }, { decryptBytes }] = await Promise.all([
    import('../e2ee/keys'),
    import('../e2ee/crypto'),
  ]);
  const dek = await getDekForBook(root);
  const plain = await decryptBytes(ciphertext, dek, rootBookId(root));

  const url = URL.createObjectURL(new Blob([plain as BlobPart], { type: mimeFor(filename) }));
  canonicalBySrc.set(url, canonical);
  return url;
}

/** Resolve (and cache) the decrypted object URL for a canonical media src. */
function getDecryptedUrl(canonical: string): Promise<string> {
  const cached = blobUrlCache.get(canonical);
  if (typeof cached === 'string') return Promise.resolve(cached);
  if (cached) return cached;

  const promise = decryptToBlobUrl(canonical)
    .then((url) => {
      blobUrlCache.set(canonical, url);
      return url;
    })
    .catch((error) => {
      blobUrlCache.delete(canonical); // allow retry on next render
      throw error;
    });
  blobUrlCache.set(canonical, promise);
  return promise;
}

/**
 * Decrypt-hydrate every media <img> in a freshly-rendered chunk container.
 * Fire-and-forget from the render path — rendering must not await decryption.
 */
export async function hydrateEncryptedImages(container: Element, bookId: string): Promise<void> {
  if (!isBookEncrypted(rootBookId(bookId))) return;

  const imgs = container.querySelectorAll<HTMLImageElement>('img');
  for (const img of imgs) {
    const canonical = img.getAttribute('src') ?? '';
    if (!MEDIA_RE.test(canonical)) continue;

    img.dataset.hlSrc = canonical; // remembered for the save-path restore
    img.classList.add('e2ee-img-loading');
    try {
      const url = await getDecryptedUrl(canonical);
      img.src = url; // JS property, post-sanitize — DOMPurify never sees blob:
      img.classList.remove('e2ee-img-loading');
    } catch (error) {
      img.classList.remove('e2ee-img-loading');
      img.classList.add('e2ee-img-locked'); // CSS lock placeholder
      verbose.content(`Encrypted image not shown (${(error as Error).message})`, 'lazyLoader/encryptedImages');
    }
  }
}

/**
 * Reverse any blob: img srcs in an HTML string back to their canonical media
 * URL. Belt for the save path (in addition to DOMPurify stripping blob:) so a
 * transient blob URL can never land in stored/synced content.
 */
export function restoreCanonicalImageSrcs(html: string): string {
  if (!canonicalBySrc.size || !html.includes('blob:')) return html;
  let out = html;
  for (const [blobUrl, canonical] of canonicalBySrc) {
    if (out.includes(blobUrl)) out = out.split(blobUrl).join(canonical);
  }
  return out;
}

/** Revoke all cached blob URLs (vault lock / book teardown). */
export function clearImageBlobCache(): void {
  for (const value of blobUrlCache.values()) {
    if (typeof value === 'string') URL.revokeObjectURL(value);
  }
  blobUrlCache.clear();
  canonicalBySrc.clear();
}
