// Reference-level (bibliography) "Check source" client — from the citation card:
//   • lookupReference — READ-ONLY live candidate search (works for any viewer; a non-author's pick
//     just links OUT to the candidate, see candidateExternalUrl).
//   • approveReference — the book AUTHOR picks a candidate → server links the canonical + stamps
//     user_verified (owner-gated). verifyReference (confirm the existing auto match) + rejectReference.
// On the author's success we mirror the decision onto the local IndexedDB bibliography record so a
// re-open within the session reflects it (a reload resyncs from the server). Sibling of
// sourceVerify/verify.ts (book-level); keyed on [book, referenceId].
import { openDatabase } from '../indexedDB/index';
import { log } from '../utilities/logger';
import { identifierOf } from './verify';
import type { LookupResult, SourceCandidate } from './types';

export interface ReferenceVerifyResult {
  success: boolean;
  referenceId?: string;
  canonical_source_id?: string;
  reference_match_method?: 'user_verified' | 'user_rejected';
  message?: string;
}

function csrfToken(): string {
  return (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content ?? '';
}

/**
 * The external "view source" destination for a candidate — prefers the READABLE full-text (OA url /
 * PDF) over the DOI landing page and, last, the OpenAlex/Open Library metadata record. Kept in sync
 * with plainCitation.ts::citationExternalLink so the immediate post-approve link matches the reloaded
 * verified state.
 */
export function candidateExternalUrl(c: SourceCandidate | null | undefined): string | null {
  if (!c) return null;
  if (typeof c.oa_url === 'string' && c.oa_url) return c.oa_url;
  if (typeof c.pdf_url === 'string' && c.pdf_url) return c.pdf_url;
  if (c.doi) return `https://doi.org/${c.doi}`;
  if (c.openalex_id) return `https://openalex.org/${c.openalex_id}`;
  if (c.open_library_key) return `https://openlibrary.org${c.open_library_key}`;
  return null;
}

/** Read-only live candidate search for a reference. Any valid session may call it. */
export async function lookupReference(bookId: string, referenceId: string): Promise<LookupResult> {
  let resp: Response;
  try {
    resp = await fetch(
      `/api/library/${encodeURIComponent(bookId)}/reference/${encodeURIComponent(referenceId)}/source/lookup`,
      { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken() }, credentials: 'include', body: '{}' },
    );
  } catch {
    return { success: false, status: 'error', method: null, score: null, candidate: null, alternates: [], alreadyLinked: false, current: null, message: 'Network error during lookup' };
  }
  const data = await resp.json().catch(() => ({} as any));
  if (!resp.ok) {
    return { success: false, status: 'error', method: null, score: null, candidate: null, alternates: [], alreadyLinked: false, current: null, message: data.message || `Lookup failed (${resp.status})` };
  }
  return data as LookupResult;
}

/** Author picks a candidate → server links the canonical + stamps verified (owner-gated). */
export async function approveReference(
  bookId: string,
  referenceId: string,
  candidate: SourceCandidate,
): Promise<ReferenceVerifyResult> {
  const result = await post(
    `/api/library/${encodeURIComponent(bookId)}/reference/${encodeURIComponent(referenceId)}/source/verify`,
    { identifier: identifierOf(candidate) },
  );
  if (result.success) await mergeLocalDecision(bookId, referenceId, 'user_verified', result.canonical_source_id);
  return result;
}

async function post(url: string, body: Record<string, unknown>): Promise<ReferenceVerifyResult> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken(),
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    return { success: false, message: 'Network error during verification' };
  }

  const data = await resp.json().catch(() => ({} as any));
  if (!resp.ok) {
    return { success: false, message: data.message || `Verification failed (${resp.status})` };
  }
  return data as ReferenceVerifyResult;
}

/** Author confirms the pipeline's canonical match for this reference. */
export async function verifyReference(
  bookId: string,
  referenceId: string,
  canonicalSourceId?: string | null,
): Promise<ReferenceVerifyResult> {
  const result = await post(
    `/api/library/${encodeURIComponent(bookId)}/reference/${encodeURIComponent(referenceId)}/source/verify`,
    canonicalSourceId ? { canonical_source_id: canonicalSourceId } : {},
  );
  if (result.success) await mergeLocalDecision(bookId, referenceId, 'user_verified');
  return result;
}

/** Author rejects the pipeline's canonical match for this reference. */
export async function rejectReference(
  bookId: string,
  referenceId: string,
): Promise<ReferenceVerifyResult> {
  const result = await post(
    `/api/library/${encodeURIComponent(bookId)}/reference/${encodeURIComponent(referenceId)}/source/reject`,
    {},
  );
  if (result.success) await mergeLocalDecision(bookId, referenceId, 'user_rejected');
  return result;
}

/** Stamp the decision onto the cached IndexedDB bibliography record (keyed [book, referenceId]). */
async function mergeLocalDecision(
  bookId: string,
  referenceId: string,
  method: 'user_verified' | 'user_rejected',
  canonicalSourceId?: string | null,
): Promise<void> {
  try {
    const db = await openDatabase();
    const tx = db.transaction('bibliography', 'readwrite');
    const store = tx.objectStore('bibliography');
    const key = [bookId, referenceId];

    const existing: any = await new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (existing) {
      const merged: any = { ...existing, reference_match_method: method, book: bookId, referenceId };
      // A pick on a previously-unmatched reference now carries a canonical — persist it so the card
      // can render the clean citation without waiting for a full resync.
      if (canonicalSourceId) merged.canonical_source_id = canonicalSourceId;
      store.put(merged);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    // Non-fatal: the server persisted it; a reload will resync the record.
    log.error('Failed to update local bibliography record after reference verify', 'referenceVerify.ts', err);
  }
}
