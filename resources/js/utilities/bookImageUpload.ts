/**
 * Editor image upload seam (drop / toolbar insert).
 *
 * One image file → POST /api/books/{root}/images (raw body; the server mints
 * the filename) → canonical `/{root}/media/{filename}` src for the new node.
 * For an E2EE book the bytes are encrypted client-side first (HLENC1 blob,
 * AAD = root book id — the same envelope as the lock pass in e2ee/imageBlobs),
 * and the dims travel as query params because the server can't measure
 * ciphertext (plaintext dims are an accepted leak, docs/e2ee.md).
 */

import { ensureCsrfToken } from './auth/csrf';
import { log } from './logger';
import { fetchOutlastingThrottle } from '../e2ee/imageBlobs';
import { isBookEncrypted, rootBookId } from '../e2ee/registry';
import { getDekForBook } from '../e2ee/keys';
import { encryptBytes } from '../e2ee/crypto';
import { patchImageDims } from '../lazyLoader/imageDims';

/** Mirrors BookImageStore::ALLOWED_EXTENSIONS / the media route regex. */
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg']);

export interface UploadedBookImage {
  filename: string;
  width: number | null;
  height: number | null;
  /** Canonical `/{root}/media/{filename}` src for the stored node. */
  src: string;
  /** Whether the stored bytes are an HLENC1 blob (book is E2EE). */
  encrypted: boolean;
}

interface ImageFileDims {
  width: number | null;
  height: number | null;
}

export function isInsertableImageFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Measure a file's pixel dims client-side. Exported for test stubbing (jsdom
 * has neither createImageBitmap nor real image decode).
 */
export async function readImageDims(file: File): Promise<ImageFileDims> {
  try {
    const bitmap = await createImageBitmap(file);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  } catch {
    // SVG (and some formats) fail createImageBitmap in some browsers —
    // fall back to an Image decode via an object URL.
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<ImageFileDims>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth || null, height: img.naturalHeight || null });
      img.onerror = () => resolve({ width: null, height: null });
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Upload one image into a book's media store and return the canonical src for
 * the new node. Throws with a user-presentable message on any failure —
 * callers insert NOTHING in that case (the node must never point at a src the
 * server doesn't have).
 */
export async function uploadBookImage(
  bookId: string,
  file: File,
  measureDims: (file: File) => Promise<ImageFileDims> = readImageDims,
): Promise<UploadedBookImage> {
  const root = rootBookId(bookId);
  if (!isInsertableImageFile(file)) {
    throw new Error(`"${file.name}" is not a supported image type (jpg, png, gif, webp, svg)`);
  }

  const dims = await measureDims(file);
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());

  const encrypted = isBookEncrypted(root);
  if (encrypted) {
    // Vault locked → getDekForBook rejects and the upload aborts cleanly.
    const dek = await getDekForBook(root);
    bytes = await encryptBytes(bytes, dek, root);
  }

  const csrfToken = await ensureCsrfToken();
  if (!csrfToken) {
    throw new Error('Not authenticated — could not upload the image');
  }

  const params = new URLSearchParams({ name: file.name });
  if (dims.width !== null) params.set('w', String(dims.width));
  if (dims.height !== null) params.set('h', String(dims.height));

  const response = await fetchOutlastingThrottle(
    `/api/books/${encodeURIComponent(root)}/images?${params.toString()}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-XSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
      body: bytes as unknown as BodyInit,
    },
  );

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    log.error(`Image upload failed (${response.status}): ${data.message ?? file.name}`, 'bookImageUpload');
    throw new Error(data.message ?? `Image upload failed (${response.status})`);
  }

  const data = (await response.json()) as {
    filename: string;
    width: number | null;
    height: number | null;
    encrypted: boolean;
    src: string;
  };

  // Keep the render-time dims cache warm so a later re-render of this node
  // doesn't miss (the map was fetched before this image existed).
  patchImageDims(root, data.filename, { width: data.width, height: data.height });

  return {
    filename: data.filename,
    width: data.width,
    height: data.height,
    src: data.src,
    encrypted: data.encrypted,
  };
}
