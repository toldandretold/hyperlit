// verifySource — POST the user-confirmed match. The server re-resolves the identifier and links
// the canonical + overwrites the library row's identity fields; on success we mirror those fields
// onto the local IndexedDB library record so the source panel reflects the change offline.
// rejectSource records "looked, no match" so the flow doesn't re-prompt.
import { openDatabase } from '../indexedDB/index';
import type { SourceCandidate, SourceIdentifier, VerifyResult } from './types';

function csrfToken(): string {
  return (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content ?? '';
}

/** The identifier subset the server keys off to re-resolve the work authoritatively. */
export function identifierOf(c: SourceCandidate): SourceIdentifier {
  const id: SourceIdentifier = {};
  if (c.openalex_id) id.openalex_id = String(c.openalex_id);
  if (c.doi) id.doi = String(c.doi);
  if (c.open_library_key) id.open_library_key = String(c.open_library_key);
  if (c.semantic_scholar_id) id.semantic_scholar_id = String(c.semantic_scholar_id);
  return id;
}

export async function verifySource(bookId: string, candidate: SourceCandidate): Promise<VerifyResult> {
  let resp: Response;
  try {
    resp = await fetch(`/api/library/${encodeURIComponent(bookId)}/source/verify`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken(),
      },
      credentials: 'include',
      body: JSON.stringify({ identifier: identifierOf(candidate) }),
    });
  } catch (err) {
    return { success: false, message: 'Network error during verification' };
  }

  const data = await resp.json().catch(() => ({} as any));
  if (!resp.ok) {
    return { success: false, message: data.message || `Verification failed (${resp.status})` };
  }

  if (data.success && data.library) {
    try {
      await mergeLocalLibrary(bookId, data.library);
    } catch (err) {
      // Non-fatal: the server is the source of truth; a reload will resync the record.
      console.warn('Failed to update local library record after verify:', err);
    }
  }
  return data as VerifyResult;
}

export async function rejectSource(bookId: string): Promise<void> {
  try {
    await fetch(`/api/library/${encodeURIComponent(bookId)}/source/reject`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken(),
      },
      credentials: 'include',
      body: '{}',
    });
  } catch (err) {
    // best-effort — rejection is only a UI convenience
  }
}

/** Merge the server's overwritten citation fields onto the cached IndexedDB library record. */
async function mergeLocalLibrary(bookId: string, fields: Record<string, unknown>): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction('library', 'readwrite');
  const store = tx.objectStore('library');

  const existing: any = await new Promise((resolve, reject) => {
    const req = store.get(bookId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const merged = { ...(existing || {}), ...fields, book: bookId };
  store.put(merged);

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
