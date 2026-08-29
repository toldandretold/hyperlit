/**
 * Render-time image dimension application — the no-layout-shift root fix.
 *
 * Much imported content stores `<img>` tags WITHOUT width/height attributes
 * (article harvester, absolutised-src digestion lanes), so every decode grows
 * the page and shoves the reader's viewport — the jitter the imageState belt
 * can only chase. But the server already knows every media image's pixel
 * dimensions (`book_images.width/height`, measured at ingest), and the CSS
 * (`img { max-width:100%; height:auto; }`) turns width/height attrs into a
 * reserved aspect-ratio box before any bytes arrive. This module closes the
 * gap: fetch the per-book dimension map once, and stamp the attrs onto
 * attr-less media imgs at chunk render — BEFORE handleBrokenImages, whose
 * settle-compensation belt deliberately skips sized images.
 *
 * Works for E2EE books by construction: the dims columns are plaintext, and
 * the attrs are applied before the blob-URL swap (which only changes `src`).
 * SVGs (null dims at ingest) stay unsized — the belt remains their fallback.
 */

import { verbose } from '../utilities/logger';
import { MEDIA_RE } from './encryptedImages';

interface ImageDims { width: number; height: number }
type DimsMap = Map<string, ImageDims>;

interface ImageRowLike {
  filename?: unknown;
  width?: unknown;
  height?: unknown;
}

// book → resolved filename→dims map, or the in-flight fetch (dedupe).
const dimsByBook = new Map<string, DimsMap | Promise<DimsMap>>();

/**
 * Fetch (once per book, deduped) the dimension map for a book's media images.
 * Failure resolves to an empty map and is cached — the belt covers the gap;
 * a retry storm against a down endpoint would be worse than one missed render.
 */
export function primeImageDims(bookId: string): Promise<DimsMap> {
  const cached = dimsByBook.get(bookId);
  if (cached instanceof Map) return Promise.resolve(cached);
  if (cached) return cached;

  const promise = fetch(`/api/books/${encodeURIComponent(bookId)}/images`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  })
    .then(async (response) => {
      const map: DimsMap = new Map();
      if (!response.ok) return map;
      const data = (await response.json().catch(() => ({}))) as { images?: ImageRowLike[] };
      for (const row of data.images ?? []) {
        const filename = typeof row.filename === 'string' ? row.filename : '';
        const width = typeof row.width === 'number' ? row.width : 0;
        const height = typeof row.height === 'number' ? row.height : 0;
        if (filename && width > 0 && height > 0) map.set(filename, { width, height });
      }
      return map;
    })
    .catch(() => new Map<string, ImageDims>())
    .then((map) => {
      dimsByBook.set(bookId, map);
      return map;
    });
  dimsByBook.set(bookId, promise);
  return promise;
}

function applyTo(img: HTMLImageElement, dims: ImageDims | undefined): boolean {
  if (!dims) return false;
  // Never clobber attrs that arrived meanwhile (stored content, load listener).
  if (img.getAttribute('width') && img.getAttribute('height')) return false;
  img.setAttribute('width', String(dims.width));
  img.setAttribute('height', String(dims.height));
  img.style.aspectRatio = `${dims.width} / ${dims.height}`;
  return true;
}

/**
 * Stamp known dimensions onto every attr-less media <img> in a freshly
 * rendered (possibly still detached) chunk container. Synchronous when the
 * book's map is already resolved — the load-bearing case, since the caller
 * (chunkRender) attaches the settle belt right after and skips sized imgs.
 * While the map is still in flight, application is deferred per-img; those
 * imgs keep the belt as a safety net for this render.
 *
 * The book is keyed from each img's OWN src segment (not the rendering
 * instance) so sub-book containers referencing the root book's media resolve
 * correctly.
 */
export function applyImageDims(container: Element): void {
  const imgs = container.querySelectorAll<HTMLImageElement>('img');
  if (imgs.length === 0) return;

  let applied = 0;
  let deferred = 0;
  imgs.forEach((img) => {
    if (img.getAttribute('width') && img.getAttribute('height')) return;
    const canonical = img.dataset.hlSrc ?? img.getAttribute('src') ?? '';
    const match = canonical.match(MEDIA_RE);
    if (!match) return;
    const book = decodeURIComponent(match[1] ?? '');
    const filename = decodeURIComponent(match[2] ?? '');
    if (!book || !filename) return;

    const entry = dimsByBook.get(book) ?? primeImageDims(book);
    if (entry instanceof Map) {
      if (applyTo(img, entry.get(filename))) applied += 1;
    } else {
      deferred += 1;
      void entry.then((map) => applyTo(img, map.get(filename)));
    }
  });
  if (applied || deferred) {
    verbose.content(`imageDims: ${applied} applied, ${deferred} deferred`, 'lazyLoader/imageDims');
  }
}

/** Drop all cached maps (book teardown / tests). */
export function clearImageDimsCache(): void {
  dimsByBook.clear();
}
