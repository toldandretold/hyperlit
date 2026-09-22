/**
 * semanticSearch.ts — the server-backed half of in-text search.
 *
 * Exact mode searches IndexedDB locally (searchEngine.ts). Semantic mode can't:
 * the node embeddings live in Postgres (`nodes.embedding halfvec(768)`), so the
 * query has to be embedded and compared server-side. This module owns that one
 * request and nothing else — the toolbar stays in charge of match state,
 * navigation and highlighting.
 *
 * THE SHAPE DIFFERENCE, which is the whole reason semantic hits render
 * differently: a semantic match is a WHOLE NODE ranked by cosine distance, so
 * there are no `charStart`/`charEnd` offsets. Manufacturing them server-side
 * would mean reproducing the client's `stripHtml(node.content)` exactly, and the
 * server's `plainText` diverges from it at least four ways — `strip_tags` does
 * not decode entities, Python's `node_plain_text()` substitutes `<latex>`
 * payloads and collapses whitespace, `applyDynamicFootnoteNumbers` rewrites
 * `<sup>` text in the live DOM AFTER render (shifting every later offset), and
 * PHP offsets are codepoints while JS offsets are UTF-16 code units. Tinting the
 * node sidesteps all of it.
 */

import { verbose, log } from '../../utilities/logger';
import { drainResponse } from '../../utilities/drainResponse';
import { parseChunkId, type ChunkId } from '../../utilities/idHelpers';
import { searchCacheGet, searchCacheSet } from '../searchResultCache';

/** Minimum query length — shorter fragments embed to near-noise, and every
 *  uncached miss costs an embedding API round-trip (the server enforces this
 *  too; checking here saves the request). */
export const SEMANTIC_MIN_QUERY_LENGTH = 3;

/** Debounce for semantic mode. Longer than exact mode's 300ms for the same
 *  reason searchBox.ts uses 500ms: each uncached keystroke is a round-trip. */
export const SEMANTIC_DEBOUNCE_MS = 500;

/** One ranked node, AFTER normalization (see normalizeHit). `match` is the
 *  floor-rescaled percentage the badge shows; `similarity` is the raw cosine,
 *  kept for debugging. */
export interface SemanticHit {
  node_id: string;
  startLine: string;
  chunk_id: ChunkId;
  excerpt: string;
  similarity: number;
  match: number;
}

/**
 * Coerce one server row into the shape the toolbar expects.
 *
 * 🔑 chunk_id MUST become a number. Postgres serializes `nodes.chunk_id`
 * (numeric) as a STRING in JSON — a live response carries `"chunk_id":"200"` —
 * while the exact-mode path reads it from IndexedDB as a number. Left as a
 * string it compares false against `currentlyLoadedChunks` (a Set of numbers)
 * and keys `matchesByChunk` under "200" while lookups ask for 200, so marks are
 * never applied to chunks already on screen and every hit takes the
 * slow "navigate and wait" branch. parseChunkId is parseFloat, NOT parseInt:
 * fractional indexing means chunk ids can be decimals.
 */
function normalizeHit(raw: any): SemanticHit {
  return {
    node_id: String(raw?.node_id ?? ''),
    startLine: String(raw?.startLine ?? ''),
    chunk_id: parseChunkId(String(raw?.chunk_id ?? '0')),
    excerpt: String(raw?.excerpt ?? ''),
    similarity: Number(raw?.similarity ?? 0),
    match: Number(raw?.match ?? 0),
  };
}

export type SemanticFailure =
  | 'offline'
  | 'unavailable'   // 503 — the embedding provider is down
  | 'unsupported'   // 403 — this book has no embeddings (E2EE, sub-book, feed)
  | 'failed';       // anything else

export type SemanticSearchResult =
  | { ok: true; hits: SemanticHit[] }
  | { ok: false; reason: SemanticFailure }
  | { ok: false; reason: 'aborted' };

/**
 * One in-flight request at a time. A keystroke supersedes the previous query, so
 * the old response is worthless — aborting it frees the connection immediately
 * instead of leaving it to land and be discarded.
 */
let inFlight: AbortController | null = null;

export function abortSemanticSearch(): void {
  if (inFlight) {
    inFlight.abort();
    inFlight = null;
  }
}

/**
 * Rank a book's nodes against `query` by meaning.
 *
 * Results come back ranked by similarity; the CALLER re-sorts to document order
 * (see searchToolbar.performSemanticSearch) so prev/next and the
 * nearest-match-to-reading-position start behave exactly as in exact mode.
 */
export async function searchBookSemantically(
  bookId: string,
  query: string,
  limit = 20,
): Promise<SemanticSearchResult> {
  if (query.length < SEMANTIC_MIN_QUERY_LENGTH) {
    return { ok: true, hits: [] };
  }

  // Cheap and honest: no point burning a request to be told there is no network.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline' };
  }

  const url = `/api/search/in-book?book=${encodeURIComponent(bookId)}`
    + `&q=${encodeURIComponent(query)}&limit=${limit}`;

  // The URL is the cache key — it already encodes book, query and limit, so
  // entries can never leak between books.
  const cached = searchCacheGet<SemanticHit[]>(url);
  if (cached) {
    verbose.content(
      `SemanticSearch: cache hit, ${cached.length} hits`,
      '/search/inTextSearch/semanticSearch',
    );
    return { ok: true, hits: cached };
  }

  abortSemanticSearch();
  const controller = new AbortController();
  inFlight = controller;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'same-origin',
    });

    if (!response.ok) {
      // 403 (this book has no embeddings) and 503 (provider down) are ROUTINE
      // outcomes here, and this branch never reads the body — exactly the shape
      // that leaked a held connection twice and hung ~30 e2e specs on
      // networkidle. Drain before returning.
      await drainResponse(response);

      if (response.status === 503) return { ok: false, reason: 'unavailable' };
      if (response.status === 403 || response.status === 422) {
        return { ok: false, reason: 'unsupported' };
      }
      log.error(
        `SemanticSearch: in-book search failed with ${response.status}`,
        '/search/inTextSearch/semanticSearch',
      );
      return { ok: false, reason: 'failed' };
    }

    // Success path genuinely consumes the body — no drain needed (and a drain
    // here would make the body unreadable).
    const payload = await response.json().catch(() => null);
    const hits: SemanticHit[] = Array.isArray(payload?.results)
      ? payload.results.map(normalizeHit)
      : [];

    searchCacheSet(url, hits);
    verbose.content(
      `SemanticSearch: ${hits.length} hits for "${query}" in ${bookId}`,
      '/search/inTextSearch/semanticSearch',
    );

    return { ok: true, hits };
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      return { ok: false, reason: 'aborted' };
    }
    log.error(
      `SemanticSearch: request threw — ${(error as Error)?.message}`,
      '/search/inTextSearch/semanticSearch',
    );
    return { ok: false, reason: 'failed' };
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}
