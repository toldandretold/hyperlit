/**
 * citationMode/searchQuery — pure builder for the /api/search/combined query URL.
 */

export function buildCombinedSearchUrl(
  query: string,
  scope: string,
  shelfId: string,
  offset: number,
  limit = 15,
): string {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    offset: String(offset),
    sourceScope: scope,
  });
  if (scope === 'shelf' && shelfId) {
    params.set('shelfId', shelfId);
  }
  return `/api/search/combined?${params.toString()}`;
}
