// lookupSource — read-only POST to the source-lookup endpoint (CanonicalSourceMatcher::preview).
// Returns the best candidate (+ alternates) for the user to confirm. No DB/IDB writes happen here.
import type { LookupResult } from './types';

function csrfToken(): string {
  return (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content ?? '';
}

export async function lookupSource(bookId: string): Promise<LookupResult> {
  let resp: Response;
  try {
    resp = await fetch(`/api/library/${encodeURIComponent(bookId)}/source/lookup`, {
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
    return errorResult('Network error during source lookup');
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
