/**
 * Build the <img> element for a freshly uploaded book image. The img IS the
 * block node (the stored shape — see MEDIA_RE in lazyLoader/encryptedImages;
 * the Enter handler already treats a top-level IMG as a non-splittable block).
 *
 * Encrypted books: the canonical src would 404-shape into ciphertext, so we
 * mirror the exact shape hydrateEncryptedImages produces — canonical src in
 * BOTH the src attribute and data-hl-src, then the plaintext preview blob URL
 * assigned as a JS property. The save path's existing img[data-hl-src] pass
 * (indexedDB/nodes/contentProcessor) restores the canonical src on persist,
 * so no new save-path code is needed.
 */
import type { UploadedBookImage } from '../../utilities/bookImageUpload';

export interface BuildImageNodeOptions {
  encrypted: boolean;
  /** Plaintext preview object URL for an encrypted book (from the dropped file). */
  previewBlobUrl?: string;
}

export function buildImageNode(upload: UploadedBookImage, opts: BuildImageNodeOptions): HTMLImageElement {
  const img = document.createElement('img');
  img.setAttribute('src', upload.src);
  if (upload.width !== null && upload.height !== null && upload.width > 0 && upload.height > 0) {
    img.setAttribute('width', String(upload.width));
    img.setAttribute('height', String(upload.height));
    img.style.aspectRatio = `${upload.width} / ${upload.height}`;
  }

  if (opts.encrypted && opts.previewBlobUrl) {
    // The live src becomes the transient blob URL; the canonical src rides in
    // data-hl-src, which the save path restores on persist (and DOMPurify
    // would strip a blob: src anyway if this node were re-sanitized).
    img.setAttribute('data-hl-src', upload.src);
    img.src = opts.previewBlobUrl;
  }

  return img;
}
