// lookupSource — read-only POST to the source-lookup endpoint (CanonicalSourceMatcher::preview).
// Returns the best candidate (+ alternates) for the user to confirm. No DB/IDB writes happen here.
import { timedPost, isTimeoutError, BUSY_MESSAGE } from './http';
import type { LookupResult } from './types';

export async function lookupSource(bookId: string): Promise<LookupResult> {
  let resp: Response;
  try {
    resp = await timedPost(`/api/library/${encodeURIComponent(bookId)}/source/lookup`, '{}');
  } catch (err) {
    return errorResult(isTimeoutError(err) ? BUSY_MESSAGE : 'Network error during source lookup');
  }

  const data = await resp.json().catch(() => ({} as any));
  if (!resp.ok) {
    return errorResult(data.message || `Lookup failed (${resp.status})`);
  }
  return data as LookupResult;
}

function errorResult(message: string): LookupResult {
  return {
    success: false, status: 'error', method: null, score: null,
    candidate: null, alternates: [], alreadyLinked: false, current: null, message,
  };
}
