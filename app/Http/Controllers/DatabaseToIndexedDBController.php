<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;
use App\Helpers\BookSlugHelper;
use App\Services\BookCache;
use App\Jobs\WarmBookCacheJob;

class DatabaseToIndexedDBController extends Controller
{
    /** Resolve the file-cache service (lazily; not all endpoints touch it). */
    private function bookCache(): BookCache
    {
        return app(BookCache::class);
    }

    /**
     * Schedule a background (re)warm of a book's file cache after a MISS, so the current
     * request stays on the live path. Falls back to an inline warm if queue dispatch fails.
     */
    private function warmAsync(string $bookId): void
    {
        try {
            WarmBookCacheJob::dispatch($bookId)->afterResponse();
        } catch (\Throwable $e) {
            // Queue unavailable (e.g. sync driver mid-request) — warm inline, best-effort.
            try {
                $this->bookCache()->warm($bookId);
            } catch (\Throwable $inner) {
                Log::warning('Inline BookCache warm failed', ['book' => $bookId, 'error' => $inner->getMessage()]);
            }
        }
    }
    // NOTE: `library`, `hypercites`, and `hyperlights` tables each have an
    // `access_granted` jsonb column (nullable, defaults to null) for future
    // per-content sharing/permissions checks.

    /**
     * Check book visibility using SECURITY DEFINER function (bypasses RLS).
     * This allows distinguishing between "book doesn't exist" and "book exists but is private".
     *
     * @return object|null Returns object with book_exists, visibility, creator, is_owner or null if book doesn't exist
     */
    private function checkBookVisibility(string $bookId): ?object
    {
        $result = DB::selectOne('SELECT * FROM check_book_visibility(?)', [$bookId]);
        return $result;
    }

    /**
     * Check authorization for a book and return appropriate error response if unauthorized.
     *
     * @return JsonResponse|null Returns error response if unauthorized, null if authorized
     */
    private function checkBookAuthorization(Request $request, string $bookId): ?JsonResponse
    {
        // Use SECURITY DEFINER function to bypass RLS and check if book exists
        $bookInfo = $this->checkBookVisibility($bookId);

        // Book doesn't exist at all
        if (!$bookInfo) {
            return response()->json([
                'error' => 'Book not found',
                'book_id' => $bookId
            ], 404);
        }

        // Book is deleted
        if ($bookInfo->visibility === 'deleted') {
            Log::info('🗑️ Deleted book accessed', [
                'book_id' => $bookId
            ]);

            return response()->json([
                'error' => 'book_deleted',
                'message' => 'This book has been deleted',
                'is_deleted' => true,
                'book_id' => $bookId
            ], 410);
        }

        // Book is private - check authorization (is_owner computed inside SECURITY DEFINER function)
        if ($bookInfo->visibility === 'private' && !$bookInfo->is_owner) {
            $authorized = false;
            $anonymousToken = $request->cookie('anon_token');
            $user = Auth::user();

            Log::warning('🔒 Private book access denied', [
                'book_id' => $bookId,
                'user' => $user ? $user->name : 'anonymous',
            ]);

            // Check creator (username-based auth)
            if ($user && $bookInfo->creator === $user->name) {
                $authorized = true;
                Log::info('📗 Private book access granted via username', [
                    'book_id' => $bookId,
                    'user' => $user->name
                ]);
            }
            // Check creator_token (anonymous token-based auth)
            elseif (!$user && $anonymousToken && ($bookInfo->creator_token ?? null) === $anonymousToken) {
                $authorized = true;
                Log::info('📗 Private book access granted via anonymous token', [
                    'book_id' => $bookId
                ]);
            }

            if (!$authorized) {
                Log::warning('🔒 Private book access denied', [
                    'book_id' => $bookId,
                    'user' => $user ? $user->name : 'anonymous',
                    'has_token' => !empty($anonymousToken)
                ]);

                return response()->json([
                    'error' => 'access_denied',
                    'message' => 'You do not have permission to access this private book',
                    'is_private' => true,
                    'book_id' => $bookId
                ], 403);
            }
        }

        // Authorized - no error response needed
        return null;
    }

    /**
     * Get complete book data for IndexedDB import
     */
    public function getBookData(Request $request, string $bookId): JsonResponse
    {
        try {
            $bookId = BookSlugHelper::resolve($bookId);

            // 🔒 CRITICAL: Check book visibility and access permissions (bypasses RLS)
            $authError = $this->checkBookAuthorization($request, $bookId);
            if ($authError) {
                return $authError;
            }

            // File-cache freshness (one cheap probe). Node content / footnotes / bibliography
            // are served from disk on a HIT; annotations + library stay live.
            $cache = $this->bookCache();
            $liveTs = $cache->freshTimestamp($bookId);
            $fresh = $cache->isFresh($bookId, $liveTs);

            // Fetch annotations ONCE for the entire request (avoids redundant queries)
            $hyperlights = $this->getHyperlights($bookId);
            $hypercites = $this->getHypercites($bookId);

            // Build per-node lookups from pre-fetched data
            $hyperlightsByNode = $this->buildHyperlightsByNodeFromProcessed($hyperlights);
            $hypercitesByNode = $this->buildHypercitesByNodeFromProcessed($hypercites);

            // Get node chunks (cache HIT serves base nodes from disk; annotations merged live)
            $nodes = $this->getNodesWithPreFetched($bookId, $hyperlightsByNode, $hypercitesByNode, $fresh, $cache);

            if (empty($nodes)) {
                return response()->json([
                    'error' => 'No data found for book',
                    'book_id' => $bookId
                ], 404);
            }

            $footnotes = $fresh ? $cache->getFootnotes($bookId) : $this->getFootnotes($bookId);
            $bibliography = $fresh ? $cache->getBibliography($bookId) : $this->getBibliography($bookId);
            $library = $this->getLibrary($bookId);

            if (!$fresh) {
                $this->warmAsync($bookId); // rebuild for next time, off the request path
            }

            // Structure data for efficient IndexedDB import
            $response = [
                'nodes' => $nodes,
                'footnotes' => $footnotes,
                'bibliography' => $bibliography,
                'hyperlights' => $hyperlights,
                'hypercites' => $hypercites,
                'library' => $library,
                'metadata' => [
                    'book_id' => $bookId,
                    'total_chunks' => count($nodes),
                    'total_footnotes' => $footnotes ? count($footnotes['data'] ?? []) : 0,
                    'total_bibliography' => $bibliography ? count($bibliography['data'] ?? []) : 0,
                    'total_hyperlights' => count($hyperlights ?? []),
                    'total_hypercites' => count($hypercites ?? []),
                    'generated_at' => now()->toISOString(),
                ]
            ];

            return response()->json($response);

        } catch (\Exception $e) {
            Log::error('Error fetching book data', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return response()->json([
                'error' => 'Internal server error',
                'message' => 'Failed to fetch book data'
            ], 500);
        }
    }

    /**
     * Build per-node hyperlight lookup from pre-fetched processed hyperlights (the getHyperlights() result).
     * Avoids redundant queries by deriving the per-node structure in-process. Each entry is the EMBEDDED
     * per-node view (TS `NodeHyperlightView`), keyed by `highlightID`.
     *
     * @param  array<int, array<string, mixed>> $hyperlights  output of getHyperlights()
     * @return array<string, array<int, array{
     *   highlightID: string, charStart: int, charEnd: int, annotation: ?string, creator: ?string,
     *   preview_nodes: ?array, time_since: ?int, hidden: bool, is_user_highlight: bool
     * }>>
     */
    private function buildHyperlightsByNodeFromProcessed(array $hyperlights): array
    {
        $byNode = [];
        foreach ($hyperlights as $hl) {
            $nodeIds = $hl['node_id'] ?? [];
            $charData = $hl['charData'] ?? [];

            foreach ($nodeIds as $nodeUUID) {
                $nodeCharData = $charData[$nodeUUID] ?? null;
                if (!$nodeCharData) {
                    continue;
                }

                if (!isset($byNode[$nodeUUID])) {
                    $byNode[$nodeUUID] = [];
                }

                $byNode[$nodeUUID][] = [
                    'highlightID' => $hl['hyperlight_id'],
                    'charStart' => $nodeCharData['charStart'],
                    'charEnd' => $nodeCharData['charEnd'],
                    'annotation' => $hl['annotation'],
                    'creator' => $hl['creator'],
                    'preview_nodes' => $hl['preview_nodes'] ?? null,
                    'time_since' => $hl['time_since'],
                    'hidden' => $hl['hidden'] ?? false,
                    'is_user_highlight' => $hl['is_user_highlight'] ?? false
                ];
            }
        }
        return $byNode;
    }

    /**
     * Build per-node hypercite lookup from pre-fetched processed hypercites (the getHypercites() result).
     * Each entry is the EMBEDDED per-node view (TS `NodeHyperciteView`), here carrying the extra
     * creator/is_user_hypercite the processed path has on hand.
     *
     * INVARIANT: the embedded arrays MUST derive from getHypercites() output — that method is the
     * single filter seam (gate filters + the always-on singles filter + pinned exemptions). The
     * renderer consumes these embedded copies, so a direct DB::table('hypercites') query here would
     * split the filter and leak gated/single hypercites into node payloads. Never bypass it.
     *
     * @param  array<int, array<string, mixed>> $hypercites  output of getHypercites()
     * @return array<string, array<int, array{
     *   hyperciteId: string, charStart: int, charEnd: int, relationshipStatus: string,
     *   citedIN: string[], time_since: ?int, creator: ?string, is_user_hypercite: bool
     * }>>
     */
    private function buildHypercitesByNodeFromProcessed(array $hypercites): array
    {
        $byNode = [];
        foreach ($hypercites as $hc) {
            $nodeIds = $hc['node_id'] ?? [];
            $charData = $hc['charData'] ?? [];

            foreach ($nodeIds as $nodeUUID) {
                $nodeCharData = $charData[$nodeUUID] ?? null;
                if (!$nodeCharData) {
                    continue;
                }

                if (!isset($byNode[$nodeUUID])) {
                    $byNode[$nodeUUID] = [];
                }

                $byNode[$nodeUUID][] = [
                    'hyperciteId' => $hc['hyperciteId'],
                    'charStart' => $nodeCharData['charStart'],
                    'charEnd' => $nodeCharData['charEnd'],
                    'relationshipStatus' => $hc['relationshipStatus'],
                    'citedIN' => $hc['citedIN'] ?? [],
                    'time_since' => $hc['time_since'] ?? null,
                    'creator' => $hc['creator'] ?? null,
                    'is_user_hypercite' => $hc['is_user_hypercite'] ?? false,
                ];
            }
        }
        return $byNode;
    }

    /**
     * Get node chunks using pre-fetched annotation lookups (avoids redundant queries).
     */
    /**
     * Map a raw `nodes` row to the user-independent wire node (no annotation arrays).
     *
     * Mirrors `BookCache::baseNode` (which `warm()` uses to write the same shape to the cache).
     * The literal is kept INLINE here — rather than calling `BookCache::baseNode($row)` at the
     * map call sites — so the data-flow map generator can read the node-row shape off these read
     * endpoints (`content`/`startLine`/`chunk_id`/`node_id` + the NodeRecord type-trace); it does
     * not follow the cross-file static call. The `BookCacheTest` live==cache contract guards the
     * two definitions against drifting.
     *
     * @return array<string, mixed>
     */
    private function baseNodeRow(object $row): array
    {
        return [
            'book' => $row->book,
            'chunk_id' => (float) $row->chunk_id,
            'startLine' => (float) $row->startLine,
            'node_id' => $row->node_id,
            'content' => $row->content,
            'plainText' => $row->plainText,
            'type' => $row->type,
            'footnotes' => json_decode($row->footnotes ?? '[]', true),
        ];
    }

    private function getNodesWithPreFetched(string $bookId, array $hyperlightsByNode, array $hypercitesByNode, bool $cacheFresh = false, ?BookCache $cache = null): array
    {
        $base = null;

        // Cache HIT: stitch base nodes from every cached chunk (manifest order).
        if ($cacheFresh && $cache) {
            $manifest = $cache->getManifest($bookId);
            if ($manifest !== null) {
                $base = [];
                foreach ($manifest as $entry) {
                    $chunkNodes = $cache->getChunk($bookId, (float) $entry['chunk_id']);
                    if ($chunkNodes === null) { // incomplete cache → abandon, fall back to PG
                        $base = null;
                        break;
                    }
                    foreach ($chunkNodes as $n) {
                        $base[] = $n;
                    }
                }
            }
        }

        if ($base === null) {
            $base = DB::table('nodes')
                ->where('book', $bookId)
                ->orderBy('chunk_id')
                ->orderBy('startLine')
                ->get()
                ->map(fn ($row) => $this->baseNodeRow($row))
                ->toArray();
        }

        $nodes = BookCache::mergeAnnotations($base, $hyperlightsByNode, $hypercitesByNode);

        Log::info('Node chunks loaded', [
            'book' => $bookId,
            'chunks' => count($nodes),
            'highlights' => count($hyperlightsByNode),
            'hypercites' => count($hypercitesByNode),
            'cache' => ($cacheFresh && $cache) ? 'hit' : 'live',
        ]);

        return $nodes;
    }

    /**
     * Get footnotes for a book — the LOAD wire shape for the `footnotes` store.
     *
     * A book id + a footnoteId→value map; the client loader expands it into one record per footnote.
     * MUST stay in sync with the TS wire type `ServerFootnotesPayload` in
     * resources/js/indexedDB/serverSync/types.ts (→ `FootnoteRecord`). The server-managed
     * citation-matching columns (is_citation/source_id/match_*) + sub_book_id are NOT in this shape.
     *
     * @return array{book: string, data: array<string, array{content: string, preview_nodes: ?array}>}|null
     */
    private function getFootnotes(string $bookId): ?array
    {
        $footnotes = DB::table('footnotes')
            ->where('book', $bookId)
            ->get();

        if ($footnotes->isEmpty()) {
            return null;
        }

        $footnotesData = [];
        foreach ($footnotes as $footnote) {
            $footnotesData[$footnote->footnoteId] = [
                'content'       => $footnote->content,
                'preview_nodes' => $footnote->preview_nodes
                    ? json_decode($footnote->preview_nodes, true)
                    : null,
            ];
        }

        return [
            'book' => $bookId,
            'data' => $footnotesData,
        ];
    }

    /**
     * Get bibliography/references for a book — the LOAD wire shape for the `bibliography` store.
     *
     * A book id + a referenceId→value map; the client loader expands it into one record per reference.
     * MUST stay in sync with the TS wire type `ServerBibliographyPayload` in
     * resources/js/indexedDB/serverSync/types.ts (→ `BibliographyRecord`). `source_has_nodes` is
     * DERIVED here via the leftJoin to library.has_nodes (read-only, not a bibliography column);
     * `source_id`/`canonical_source_id` are the links resolved to a canonical source at click time.
     *
     * @return array{book: string, data: array<string, array{
     *   content: string, source_id: ?string, canonical_source_id: ?string, source_has_nodes: ?bool
     * }>}|null
     */
    private function getBibliography(string $bookId): ?array
    {
        $references = DB::table('bibliography')
            ->leftJoin('library', 'bibliography.source_id', '=', 'library.book')
            ->select(
                'bibliography.*',
                'library.has_nodes as source_has_nodes',
                'library.type as source_type',
                'library.url as source_url',
            )
            ->where('bibliography.book', $bookId)
            ->get();

        if ($references->isEmpty()) {
            return null;
        }

        // Convert to full record format including source_id and canonical_source_id
        // for linked citations.
        $bibliographyData = [];
        foreach ($references as $reference) {
            // A WebFetch scrape stub is never surfaced as a readable source — the card links OUT to
            // the original URL instead (source_external_url). See displayCitations/plainCitation.ts.
            $isWebStub = ($reference->source_type ?? null) === 'web_source';
            $bibliographyData[$reference->referenceId] = [
                'content' => $reference->content,
                'source_id' => $reference->source_id ?? null,
                'canonical_source_id' => $reference->canonical_source_id ?? null,
                'source_has_nodes' => isset($reference->source_has_nodes)
                    ? (bool) $reference->source_has_nodes
                    : null, // null → treated as true (backward compat)
                'source_is_web_stub' => $isWebStub,
                'source_external_url' => $isWebStub ? ($reference->source_url ?? null) : null,
                // Human confirm/reject of the canonical match (orthogonal to the pipeline's match_*).
                'reference_match_method' => $reference->reference_match_method ?? null,
                'reference_verified_at' => $reference->reference_verified_at ?? null,
            ];
        }

        return [
            'book' => $bookId,
            'data' => $bibliographyData,
        ];
    }

    /**
     * Read gate filter preferences for the current user.
     * Returns a normalised settings array with mode + custom flags.
     */
    private function getGatePreferences(): array
    {
        $defaults = [
            'mode' => 'default',
            'custom' => ['hideAI' => false, 'hideAnonymous' => false, 'hideNoAnnotation' => false],
        ];

        // 1. Prefer query-param gate settings (sent by client on every fetch —
        //    avoids race with async preference save and works for anonymous users)
        $qp = request()->input('gate');
        if ($qp) {
            $gate = is_string($qp) ? json_decode($qp, true) : $qp;
            if (is_array($gate) && isset($gate['mode'])) {
                return [
                    'mode' => $gate['mode'],
                    'custom' => array_merge($defaults['custom'], $gate['custom'] ?? []),
                    'bookDefaults' => $gate['bookDefaults'] ?? null,
                ];
            }
        }

        // 2. Fall back to stored user preferences
        $user = Auth::user();
        if (!$user) return $defaults;

        $prefs = $user->preferences ?? [];
        $gate = $prefs['gate_filter'] ?? null;
        if (!is_array($gate)) return $defaults;

        return [
            'mode' => $gate['mode'] ?? 'default',
            'custom' => array_merge($defaults['custom'], $gate['custom'] ?? []),
        ];
    }

    /**
     * Get the book creator's gate defaults for a given book.
     * Returns decoded array or null if the book has no overrides.
     */
    private function getBookGateDefaults(string $bookId): ?array
    {
        $row = DB::table('library')->where('book', $bookId)->select('gate_defaults')->first();
        if (!$row || !$row->gate_defaults) return null;
        return json_decode($row->gate_defaults, true);
    }

    /**
     * Apply gate filter WHERE clauses to an annotation query.
     * The user's own rows always pass through (ownership bypass in every clause).
     *
     * @param \Illuminate\Database\Query\Builder $query
     * @param array  $gate          Gate settings from getGatePreferences()
     * @param string $type          'hyperlight' or 'hypercite'
     * @param mixed  $user          Auth::user() or null
     * @param string|null $anonToken Anonymous token cookie
     * @param array|null $bookGateDefaults Book-level default overrides (from library.gate_defaults)
     * @param array  $pinnedIds     Deep-link target hypercite ids that bypass every gate clause
     *                              (explicit navigation intent — see getPinnedHyperciteIds()).
     */
    private function applyGateFilters($query, array $gate, string $type, $user, ?string $anonToken, ?array $bookGateDefaults = null, array $pinnedIds = []): void
    {
        if ($gate['mode'] === 'all') return;

        // Pinned exemption only applies to hypercites (deep-link targets navigated by id).
        $pinned = ($type === 'hypercite') ? $pinnedIds : [];

        // Co-author escape (hypercites only): the AI Archivist stamps its cites
        // creator='AIarchivist' with the ASKING user in access_granted as co-author —
        // those are "the user's own" for every always-show rule.
        $coAuthor = ($type === 'hypercite' && $user) ? $user->name : null;

        // "hideAll" — exclude everything except the user's own rows (and pinned deep-link targets)
        if ($gate['mode'] === 'hideAll') {
            $query->where(function ($q) use ($user, $anonToken, $pinned, $coAuthor) {
                $q->whereRaw('1 = 0'); // exclude everything...
                if ($user) $q->orWhere('creator', $user->name);
                if ($anonToken) $q->orWhere('creator_token', $anonToken);
                if ($coAuthor) $q->orWhereRaw('"access_granted" ->> ? IS NOT NULL', [$coAuthor]);
                if (!empty($pinned)) $q->orWhereIn('hyperciteId', $pinned);
            });
            return;
        }

        // Determine which restrictions to apply — flags are PER-TYPE (the settings panel
        // has a Highlights column and a Hypercites column). normalizeGateFlags() accepts
        // both the nested shape ({hyperlight:{...}, hypercite:{...}}) and the legacy flat
        // shape ({hideAI,...} → applies to both types).
        $hideAI = false;
        $hideAnonymous = false;
        $hideNoAnnotation = false;

        if ($gate['mode'] === 'default') {
            // Prefer client-provided bookDefaults (avoids race with async DB save)
            $effectiveDefaults = $gate['bookDefaults'] ?? $bookGateDefaults;
            if ($effectiveDefaults !== null) {
                $flags = $this->normalizeGateFlags($effectiveDefaults, $type);
            } else {
                // Global default DIFFERS per type: hyperlights hide AI + empty-annotation;
                // hypercites hide AI + ANONYMOUS — an anonymous cite is a navigation funnel
                // (it can lead readers to spam/trash books), unlike an anonymous highlight
                // which is just an in-place mark. (See also the always-on singles/citedIN
                // rules in getHypercites.)
                $flags = $type === 'hypercite'
                    ? ['hideAI' => true, 'hideAnonymous' => true, 'hideNoAnnotation' => false]
                    : ['hideAI' => true, 'hideAnonymous' => false, 'hideNoAnnotation' => true];
            }
            $hideAI = $flags['hideAI'];
            $hideAnonymous = $flags['hideAnonymous'];
            $hideNoAnnotation = $flags['hideNoAnnotation'];
        } elseif ($gate['mode'] === 'custom') {
            $flags = $this->normalizeGateFlags($gate['custom'] ?? [], $type);
            $hideAI = $flags['hideAI'];
            $hideAnonymous = $flags['hideAnonymous'];
            $hideNoAnnotation = $flags['hideNoAnnotation'];
        }

        if ($hideAI) {
            // AI creators: 'AIreview:%' (citation review — highlights) and 'AIarchivist%'
            // (the AI Archivist — the one that mints hypercites).
            $query->where(function ($q) use ($user, $anonToken, $pinned, $coAuthor) {
                $q->where(function ($notAi) {
                    $notAi->where('creator', 'NOT LIKE', 'AIreview:%')
                          ->where('creator', 'NOT LIKE', 'AIarchivist%');
                });
                $q->orWhereNull('creator');
                if ($user) $q->orWhere('creator', $user->name);
                if ($anonToken) $q->orWhere('creator_token', $anonToken);
                if ($coAuthor) $q->orWhereRaw('"access_granted" ->> ? IS NOT NULL', [$coAuthor]);
                if (!empty($pinned)) $q->orWhereIn('hyperciteId', $pinned);
            });
        }

        if ($hideAnonymous) {
            $query->where(function ($q) use ($user, $anonToken, $pinned, $coAuthor) {
                $q->whereNotNull('creator');
                if ($user) $q->orWhere('creator', $user->name);
                if ($anonToken) $q->orWhere('creator_token', $anonToken);
                if ($coAuthor) $q->orWhereRaw('"access_granted" ->> ? IS NOT NULL', [$coAuthor]);
                if (!empty($pinned)) $q->orWhereIn('hyperciteId', $pinned);
            });
        }

        if ($hideNoAnnotation && $type === 'hyperlight') {
            $query->where(function ($q) use ($user, $anonToken) {
                $q->where(function ($inner) {
                    $inner->where(function ($sub) {
                        $sub->whereNotNull('annotation')
                            ->where('annotation', '!=', '');
                    })->orWhere(function ($sub) {
                        $sub->whereNotNull('preview_nodes')
                            ->whereRaw("jsonb_typeof(preview_nodes) = 'array'")
                            ->whereRaw("EXISTS (SELECT 1 FROM jsonb_array_elements(preview_nodes) AS elem WHERE regexp_replace(elem->>'content', '<[^>]*>', '', 'g') ~ '\\S')");
                    });
                });
                if ($user) $q->orWhere('creator', $user->name);
                if ($anonToken) $q->orWhere('creator_token', $anonToken);
            });
        }
    }

    /**
     * Normalize a gate flag object to the {hideAI, hideAnonymous, hideNoAnnotation} triple
     * for ONE annotation type. Accepts the nested per-type shape the two-column settings
     * panel writes ({hyperlight: {...}, hypercite: {...}}) AND the legacy flat shape
     * ({hideAI, ...} — pre-split settings/gate_defaults, applied to both types).
     */
    private function normalizeGateFlags($flags, string $type): array
    {
        $empty = ['hideAI' => false, 'hideAnonymous' => false, 'hideNoAnnotation' => false];
        if (!is_array($flags)) return $empty;

        if (array_key_exists('hyperlight', $flags) || array_key_exists('hypercite', $flags)) {
            $flags = $flags[$type] ?? [];
            if (!is_array($flags)) return $empty;
        }

        return [
            'hideAI' => (bool) ($flags['hideAI'] ?? false),
            'hideAnonymous' => (bool) ($flags['hideAnonymous'] ?? false),
            'hideNoAnnotation' => (bool) ($flags['hideNoAnnotation'] ?? false),
        ];
    }

    /**
     * Get hyperlights for a book — the standalone LOAD wire shape for the `hyperlights` store.
     *
     * MUST stay in sync with the TS wire type `ServerHyperlightRow` (→ `HyperlightRecord`). Gate-filtered
     * server-side, and rows whose sub-book (annotation) is private and not the caller's are dropped;
     * `creator_token` is intentionally never sent (only `is_user_highlight` is exposed, and it is unset
     * from `raw_json` too). `node_id`/`charData`/`preview_nodes`/`raw_json` are JSON-decoded here (the
     * loader normalizer `processHyperlight` re-parses defensively).
     *
     * @return array<int, array{
     *   book: string, hyperlight_id: string, node_id: string[], charData: array<string, array{charStart: int, charEnd: int}>,
     *   annotation: ?string, preview_nodes: ?array, highlightedHTML: ?string, highlightedText: ?string,
     *   startLine: ?string, raw_json: array, time_since: ?int, hidden: bool, is_user_highlight: bool, creator: ?string
     * }>
     */
    private function getHyperlights(string $bookId): array
    {
        $user = Auth::user();
        $anonymousToken = request()->cookie('anon_token');

        Log::info('🔍 getHyperlights started', [
            'book_id' => $bookId,
            'user_id' => $user ? $user->id : null,
            'user_name' => $user ? $user->name : null,
            'is_logged_in' => !is_null($user),
            'anonymous_token' => $anonymousToken ? 'present' : 'null'
        ]);

        $query = DB::table('hyperlights')
            ->where('book', $bookId)
            ->where(function($q) use ($user, $anonymousToken) {
                $q->where('hidden', false);

                if ($user) {
                    $q->orWhere('creator', $user->name);
                }

                if ($anonymousToken) {
                    $q->orWhere('creator_token', $anonymousToken);
                }
            });

        // Server-side gate filter — exclude gated highlights before download
        $gate = $this->getGatePreferences();
        $bookGateDefaults = $this->getBookGateDefaults($bookId);
        $this->applyGateFilters($query, $gate, 'hyperlight', $user, $anonymousToken, $bookGateDefaults);

        $rows = $query
            ->orderBy('hyperlight_id')
            ->get();

        // Filter out highlights whose sub-book is private and doesn't belong to the current user.
        // Use admin connection to bypass RLS so we can actually see private library records.
        $subBookIds = $rows->pluck('sub_book_id')->filter()->unique()->values()->toArray();
        $privateSubBookInfo = []; // sub_book_id => ['creator' => ..., 'creator_token' => ...]
        if (!empty($subBookIds)) {
            $privateRows = DB::connection('pgsql_admin')->table('library')
                ->whereIn('book', $subBookIds)
                ->where('visibility', 'private')
                ->get(['book', 'creator', 'creator_token']);
            foreach ($privateRows as $row) {
                $privateSubBookInfo[$row->book] = [
                    'creator' => $row->creator,
                    'creator_token' => $row->creator_token,
                ];
            }
        }

        $rows = $rows->filter(function ($h) use ($user, $anonymousToken, $privateSubBookInfo) {
            if (!$h->sub_book_id) return true;
            if (!array_key_exists($h->sub_book_id, $privateSubBookInfo)) return true; // not private
            // Private sub-book — only include if current user is the creator
            $info = $privateSubBookInfo[$h->sub_book_id];
            if ($user && $info['creator'] === $user->name) return true;
            if ($anonymousToken && $info['creator_token'] && $info['creator_token'] === $anonymousToken) return true;
            return false;
        });

        $hyperlights = $rows
            ->map(function ($hyperlight) use ($user, $anonymousToken, $bookId) {
                // Determine if this highlight belongs to the current user
                // Prioritized auth: if highlight has username (creator), ONLY use username-based auth
                $isUserHighlight = false;

                if ($hyperlight->creator) {
                    // Highlight has username - ONLY check username-based auth (ignore token)
                    $isUserHighlight = $user && $hyperlight->creator === $user->name;
                } elseif ($hyperlight->creator_token) {
                    // Highlight has no username, only token - check token-based auth
                    // This works for both anonymous users AND logged-in users who created pre-login
                    // (they still have the same anon_token cookie)
                    $isUserHighlight = $anonymousToken && $hyperlight->creator_token === $anonymousToken;
                }

                // (per-hyperlight processing log removed — it fired once per annotation on
                //  every reader load; the start/complete summary logs below cover the totals.)

                // 🔒 SECURITY: Never expose creator_token in API responses
                // Only the owner needs to know ownership, which is indicated by is_user_highlight
                // Also sanitize raw_json to remove creator_token
                // Note: raw_json may be double-encoded (JSON string containing JSON string)
                $rawJson = json_decode($hyperlight->raw_json ?? '{}', true);
                if (is_string($rawJson)) {
                    // Double-encoded - decode again
                    $rawJson = json_decode($rawJson, true);
                }
                if (is_array($rawJson)) {
                    unset($rawJson['creator_token']);
                }

                return [
                    'book' => $hyperlight->book,
                    'hyperlight_id' => $hyperlight->hyperlight_id,
                    'node_id' => json_decode($hyperlight->node_id ?? '[]', true),
                    'charData' => json_decode($hyperlight->charData ?? '{}', true),
                    'annotation' => $hyperlight->annotation,
                    'preview_nodes' => (function () use ($hyperlight) {
                        if (!$hyperlight->preview_nodes) return null;
                        $decoded = json_decode($hyperlight->preview_nodes, true);
                        if (is_string($decoded)) {
                            // Double-encoded — decode again to break the cycle
                            $decoded = json_decode($decoded, true);
                        }
                        return $decoded;
                    })(),
                    'highlightedHTML' => $hyperlight->highlightedHTML,
                    'highlightedText' => $hyperlight->highlightedText,
                    'startLine' => $hyperlight->startLine,
                    // Ghost anchor (renumber-proof "lived after this node" ref, set by
                    // the client at whole-node-deletion tombstone time; maintained
                    // server-side by CharDataRecalculator::reanchorForDeletedNodes).
                    // Served under the client's underscore-prefixed field name — the
                    // IDB loader spreads the wire row wholesale.
                    '_ghost_anchor_node' => $hyperlight->ghost_anchor_node ?? null,
                    'raw_json' => $rawJson,
                    'time_since' => $hyperlight->time_since,
                    'hidden' => (bool) ($hyperlight->hidden ?? false),
                    'is_user_highlight' => $isUserHighlight,
                    'creator' => $hyperlight->creator,
                    // creator_token intentionally omitted - security sensitive
                ];
            })
            ->toArray();
        
        Log::info('🔍 getHyperlights completed', [
            'book_id' => $bookId,
            'total_count' => count($hyperlights),
            'user_highlights_count' => count(array_filter($hyperlights, function($h) { return $h['is_user_highlight']; })),
            'sample_highlight' => count($hyperlights) > 0 ? $hyperlights[0] : null
        ]);

        return $hyperlights;
    }

    /**
     * Get hypercites for a book — the standalone LOAD wire shape for the `hypercites` store.
     *
     * MUST stay in sync with the TS wire type `ServerHyperciteRow` (→ `HyperciteRecord`). Gate-filtered
     * server-side; `creator_token` is intentionally never sent (only `is_user_hypercite` is exposed).
     * Foreign `relationshipStatus='single'` rows are always excluded (owner/pinned escapes apply) —
     * see the singles filter below and getPinnedHyperciteIds().
     *
     * @return array<int, array{
     *   book: string, hyperciteId: string, node_id: string[], charData: array<string, array{charStart: int, charEnd: int}>,
     *   citedIN: string[], hypercitedHTML: ?string, hypercitedText: ?string, relationshipStatus: ?string,
     *   time_since: ?int, raw_json: array, creator: ?string, is_user_hypercite: bool
     * }>
     */
    private function getHypercites(string $bookId): array
    {
        $user = Auth::user();
        $anonymousToken = request()->cookie('anon_token');
        $pinned = $this->getPinnedHyperciteIds();

        $query = DB::table('hypercites')
            ->where('book', $bookId);

        // Server-side gate filter
        $gate = $this->getGatePreferences();
        $bookGateDefaults = $this->getBookGateDefaults($bookId);
        $this->applyGateFilters($query, $gate, 'hypercite', $user, $anonymousToken, $bookGateDefaults, $pinned);

        // ALWAYS-ON singles filter (not gate-wired): a relationshipStatus='single' hypercite has
        // zero inbound citations — for anyone but its creator it is operational residue of a copy
        // event, so it is never sent unless (a) the requester created it, or (b) it is a pinned
        // deep-link target (an externally-pasted #hypercite_ link can point at a still-'single'
        // cite that must render and glow). NULL statuses are legacy rows and stay visible — a bare
        // `!= 'single'` would silently drop them in Postgres.
        $query->where(function ($q) use ($user, $anonymousToken, $pinned) {
            $q->whereNull('relationshipStatus')
              ->orWhere('relationshipStatus', '!=', 'single');
            if ($user) {
                $q->orWhere('creator', $user->name);
                // co-author grant (e.g. the AI Archivist cites on the asking user's behalf)
                $q->orWhereRaw('"access_granted" ->> ? IS NOT NULL', [$user->name]);
            }
            if ($anonymousToken) $q->orWhere('creator_token', $anonymousToken);
            if (!empty($pinned)) $q->orWhereIn('hyperciteId', $pinned);
        });

        $hypercites = $query
            ->orderBy('hyperciteId')
            ->get()
            ->map(function ($hypercite) use ($user, $anonymousToken) {
                // Determine ownership (same prioritised logic as hyperlights)
                $isUserHypercite = false;
                if ($hypercite->creator) {
                    $isUserHypercite = $user && $hypercite->creator === $user->name;
                } elseif ($hypercite->creator_token ?? null) {
                    $isUserHypercite = $anonymousToken && $hypercite->creator_token === $anonymousToken;
                }
                // Co-author grant counts as ownership: the AI Archivist mints cites with
                // creator='AIarchivist' + access_granted={askingUser: 'co-author'} — every
                // always-show escape (gate, singles, citedIN pass, client mirror) keys off
                // is_user_hypercite, so the grant flows through them all.
                if (!$isUserHypercite && $user) {
                    $granted = json_decode($hypercite->access_granted ?? 'null', true);
                    $isUserHypercite = is_array($granted) && array_key_exists($user->name, $granted);
                }

                return [
                    'book' => $hypercite->book,
                    'hyperciteId' => $hypercite->hyperciteId,
                    'node_id' => json_decode($hypercite->node_id ?? '[]', true),
                    'charData' => json_decode($hypercite->charData ?? '{}', true),
                    'citedIN' => json_decode($hypercite->citedIN ?? '[]', true),
                    'hypercitedHTML' => $hypercite->hypercitedHTML,
                    'hypercitedText' => $hypercite->hypercitedText,
                    'relationshipStatus' => $hypercite->relationshipStatus,
                    'time_since' => $hypercite->time_since ?? null,
                    'raw_json' => json_decode($hypercite->raw_json ?? '{}', true),
                    'creator' => $hypercite->creator,
                    'is_user_hypercite' => $isUserHypercite,
                    // creator_token intentionally omitted - security sensitive
                ];
            })
            ->toArray();

        // ALWAYS-ON citedIN privacy pass: entries pointing at books this viewer cannot
        // see are stripped (they leak private/deleted book ids and navigate to a 403);
        // a cite whose EVERY citation is invisible is effectively a 'single' for this
        // viewer and is dropped entirely (owner + pinned escapes, as above).
        return $this->sanitizeCitedInForViewer($hypercites, $user, $anonymousToken, $pinned);
    }

    /**
     * Per-viewer citedIN sanitize (see getHypercites). For each non-owned, non-pinned row:
     * keep only citedIN entries whose citing book the viewer may see — the most SPECIFIC
     * library row wins (a sub-book citing location like "book_x/Fn2" is judged by its own
     * row when one exists, else by its root book's row); entries with no surviving library
     * row at all are dead citations and are stripped. Rows left with zero visible citations
     * are removed; kept rows get their DISPLAY relationshipStatus downgraded to the visible
     * count (poly with one visible citer reads as couple) and their raw_json copy scrubbed.
     *
     * Visibility is computed in PHP from a BYPASSRLS lookup (RLS would make "private row"
     * and "no row" indistinguishable): public ⇒ visible; private ⇒ visible only to its
     * creator (user name or anon token).
     */
    private function sanitizeCitedInForViewer(array $hypercites, $user, ?string $anonToken, array $pinned): array
    {
        // Collect candidate citing-book ids (full path + root segment) from rows that need the pass.
        $candidates = [];
        foreach ($hypercites as $hc) {
            if ($hc['is_user_hypercite'] || in_array($hc['hyperciteId'], $pinned, true)) continue;
            foreach ((array) ($hc['citedIN'] ?? []) as $entry) {
                $fullId = $this->citedInBookId($entry);
                if ($fullId === null) continue;
                $candidates[$fullId] = true;
                $root = explode('/', $fullId, 2)[0];
                if ($root !== '' && $root !== $fullId) $candidates[$root] = true;
            }
        }

        $rowsById = [];
        if (!empty($candidates)) {
            $rows = DB::connection('pgsql_admin')->table('library')
                ->whereIn('book', array_keys($candidates))
                ->select('book', 'visibility', 'creator', 'creator_token')
                ->get();
            foreach ($rows as $row) {
                $rowsById[$row->book] = $row;
            }
        }

        $viewerCanSee = function (?object $row) use ($user, $anonToken): bool {
            if (!$row || $row->visibility === 'deleted') return false;
            if ($row->visibility === 'public') return true;
            if ($user && $row->creator === $user->name) return true;
            if ($anonToken && $row->creator_token === $anonToken) return true;
            return false;
        };

        $out = [];
        foreach ($hypercites as $hc) {
            if ($hc['is_user_hypercite'] || in_array($hc['hyperciteId'], $pinned, true)) {
                $out[] = $hc;
                continue;
            }
            $cited = (array) ($hc['citedIN'] ?? []);
            if (empty($cited)) { // stored singles/legacy rows — already handled by the SQL filter
                $out[] = $hc;
                continue;
            }
            $kept = array_values(array_filter($cited, function ($entry) use ($rowsById, $viewerCanSee) {
                $fullId = $this->citedInBookId($entry);
                if ($fullId === null) return false;
                // Most specific row wins; fall back to the root book only when the full
                // path has NO row of its own (citing location formats vary).
                if (isset($rowsById[$fullId])) return $viewerCanSee($rowsById[$fullId]);
                $root = explode('/', $fullId, 2)[0];
                if ($root !== $fullId && isset($rowsById[$root])) return $viewerCanSee($rowsById[$root]);
                return false; // no library row anywhere — citing book deleted
            }));

            if (empty($kept)) continue; // every citation invisible → effectively single → drop

            if (count($kept) !== count($cited)) {
                $hc['citedIN'] = $kept;
                if (in_array($hc['relationshipStatus'], ['couple', 'poly'], true)) {
                    $hc['relationshipStatus'] = count($kept) >= 2 ? 'poly' : 'couple';
                }
                if (is_array($hc['raw_json'] ?? null) && isset($hc['raw_json']['citedIN'])) {
                    $hc['raw_json']['citedIN'] = $kept;
                }
            }
            $out[] = $hc;
        }

        return $out;
    }

    /**
     * Extract the citing book id from a citedIN entry ("/{book}#{hyperciteId}", possibly
     * with a sub-book path or a stale absolute origin). Returns null when unparseable.
     */
    private function citedInBookId($entry): ?string
    {
        if (!is_string($entry) || $entry === '') return null;
        $path = explode('#', $entry, 2)[0];
        if (preg_match('#^https?://#i', $path)) {
            $path = (string) (parse_url($path, PHP_URL_PATH) ?? '');
        }
        $path = rawurldecode(ltrim($path, '/'));
        return $path === '' ? null : $path;
    }

    /**
     * Parse the deep-link exemption ids from the request: the `pinned` query param (comma-separated,
     * sent by the client's gateFilter pinned set) merged with the `target` param when it is
     * hypercite-shaped (the /initial deep-link target). Ids are shape-validated and capped so the
     * param cannot be abused as a bulk unfilter.
     *
     * @return string[]
     */
    private function getPinnedHyperciteIds(): array
    {
        $candidates = [];

        $pinnedParam = request()->query('pinned');
        if (is_string($pinnedParam) && $pinnedParam !== '') {
            $candidates = explode(',', $pinnedParam);
        }

        $target = request()->query('target');
        if (is_string($target) && $target !== '') {
            $candidates[] = $target;
        }

        $valid = array_values(array_unique(array_filter(
            array_map('trim', $candidates),
            fn ($id) => is_string($id) && preg_match('/^hypercite_[A-Za-z0-9]+$/', $id) === 1
        )));

        return array_slice($valid, 0, 20);
    }

    /**
     * Get library data for a book — the LOAD wire shape for the `library` store.
     *
     * This array IS the contract. It MUST stay in sync with the TypeScript wire type
     * `ServerLibraryRow` in resources/js/indexedDB/serverSync/types.ts (→ `LibraryRecord` after
     * prepareLibraryForIndexedDB). `is_owner` is computed server-side (not a column); `creator_token`
     * is intentionally never sent and is stripped from `raw_json`. The load returns the same
     * bibliographic columns the write (DbLibraryController::upsert) accepts — symmetric round-trip.
     *
     * @return array{
     *   book: string, author: ?string, bibtex: ?string, fileName: ?string, fileType: ?string,
     *   journal: ?string, note: ?string, pages: ?string, publisher: ?string, school: ?string,
     *   volume: ?string, issue: ?string, booktitle: ?string, chapter: ?string, editor: ?string,
     *   timestamp: ?int, annotations_updated_at: int, title: ?string, type: ?string, url: ?string,
     *   year: ?string, creator: ?string, is_owner: bool, visibility: 'public'|'private'|'deleted',
     *   listed: bool, license: ?string, custom_license_text: ?string, gate_defaults: ?array, raw_json: array
     * }|null
     */
   private function getLibrary(string $bookId, bool $bypassRls = false): ?array
    {
        $connection = $bypassRls ? 'pgsql_admin' : config('database.default');
        $library = DB::connection($connection)->table('library')
            ->where('book', $bookId)
            ->first();

        if (!$library) {
            return null;
        }

        // 🔒 SECURITY: Determine if current user owns this book
        $user = Auth::user();
        $anonymousToken = request()->cookie('anon_token');
        $isOwner = false;

        if ($library->creator) {
            // Book has username - check username-based auth
            $isOwner = $user && $library->creator === $user->name;
        } elseif ($library->creator_token) {
            // Book has no username, only token - check token-based auth for anonymous
            $isOwner = !$user && $anonymousToken && hash_equals($library->creator_token, $anonymousToken);
        }

        Log::info('Library record from database', [
            'book_id' => $bookId,
            'timestamp' => $library->timestamp,
            'timestamp_type' => gettype($library->timestamp),
            'creator' => $library->creator,
            'creator_token' => $library->creator_token ? 'present' : 'null',
            'is_owner' => $isOwner
        ]);

        // 🔒 SECURITY: Never expose creator_token in API responses
        // Use is_owner boolean instead so frontend knows ownership without seeing tokens
        // Also sanitize raw_json to remove creator_token
        // Note: raw_json may be double-encoded (JSON string containing JSON string)
        $rawJson = json_decode($library->raw_json ?? '{}', true);
        if (is_string($rawJson)) {
            // Double-encoded - decode again
            $rawJson = json_decode($rawJson, true);
        }
        if (is_array($rawJson)) {
            unset($rawJson['creator_token']);
        }

        // Provenance: when linked, pull the canonical so the source panel can show the
        // verification categories (Citation Linked / Official source text) + the Librarian
        // (provider) link. Read via admin — canonical_source is not user-scoped.
        $canonical = null;
        if (!empty($library->canonical_source_id)) {
            $c = DB::connection('pgsql_admin')->table('canonical_source')
                ->where('id', $library->canonical_source_id)
                ->first();
            if ($c) {
                $canonical = [
                    'id'                => $c->id,
                    'auto_version_book' => $c->auto_version_book ?? null,
                    'foundation_source' => $c->foundation_source ?? null,
                    'openalex_id'       => $c->openalex_id ?? null,
                    'open_library_key'  => $c->open_library_key ?? null,
                    'doi'               => $c->doi ?? null,
                    'oa_url'            => $c->oa_url ?? null,
                    'source_url'        => $c->source_url ?? null,
                    'title'             => $c->title ?? null,
                    'author'            => $c->author ?? null,
                    'year'              => $c->year ?? null,
                ];
            }
        }

        return [
            'book' => $library->book,
            'author' => $library->author,
            'bibtex' => $library->bibtex,
            'fileName' => $library->fileName,
            'fileType' => $library->fileType,
            'journal' => $library->journal,
            'note' => $library->note,
            'pages' => $library->pages,
            'publisher' => $library->publisher,
            'school' => $library->school,
            // Bibliographic sub-fields — MUST be returned so the load round-trips with the write
            // (DbLibraryController::upsert writes these columns). Without them the edit form re-opens
            // blank and a re-save regenerates bibtex without them → silent data loss.
            'volume' => $library->volume,
            'issue' => $library->issue,
            'booktitle' => $library->booktitle,
            'chapter' => $library->chapter,
            'editor' => $library->editor,
            'timestamp' => $library->timestamp,
            'annotations_updated_at' => $library->annotations_updated_at ?? 0,
            'title' => $library->title,
            'type' => $library->type,
            'url' => $library->url,
            'year' => $library->year,
            'creator' => $library->creator,
            // creator_token intentionally omitted - security sensitive
            'is_owner' => $isOwner,
            'visibility' => $library->visibility ?? 'public',
            'listed' => $library->listed ?? true,
            'license' => $library->license ?? null,
            'custom_license_text' => $library->custom_license_text ?? null,
            // Content completeness of THIS version (verified_full / partial /
            // unverified) — drives the source-panel "partial copy" badge and is
            // read by citation review so a chapter/teaser isn't treated as the
            // whole work. Set by the harvester (AutoVersionCreator).
            'completeness' => $library->completeness ?? null,
            'completeness_reason' => $library->completeness_reason ?? null,
            'gate_defaults' => $library->gate_defaults ? json_decode($library->gate_defaults, true) : null,
            // E2EE (docs/e2ee.md): MUST round-trip — the client registry + the
            // upload seam key off `encrypted`, and the DEK cache is bootstrapped
            // from `wrapped_dek`. Omitting them made a pull reset the flag to
            // false, so the next push sent plaintext into an encrypted row (422).
            'encrypted' => (bool) ($library->encrypted ?? false),
            'wrapped_dek' => $library->wrapped_dek ?? null,
            'raw_json' => $rawJson,
            // Canonical / verified-source state — drives the [check source] button vs verified badge
            // in the source panel. Read-only here (set by CanonicalSourceMatcher / SourceVerificationController).
            'canonical_source_id' => $library->canonical_source_id ?? null,
            'canonical_match_method' => $library->canonical_match_method ?? null,
            'canonical_match_score' => isset($library->canonical_match_score) ? (float) $library->canonical_match_score : null,
            'canonical_metadata_score' => isset($library->canonical_metadata_score) ? (float) $library->canonical_metadata_score : null,
            'human_reviewed_at' => $library->human_reviewed_at ?? null,
            // Provenance — drives the source panel's category pills + Librarian attribution.
            'conversion_method' => $library->conversion_method ?? null,
            'foundation_source' => $library->foundation_source ?? null,
            'openalex_id' => $library->openalex_id ?? null,
            'doi' => $library->doi ?? null,
            'open_library_key' => $library->open_library_key ?? null,
            'oa_url' => $library->oa_url ?? null,
            'canonical' => $canonical,
        ];
    }

    /**
     * Get headings for a book (lightweight endpoint for TOC when not fully loaded).
     * Scans nodes.content for <h1> through <h6> with id attributes.
     */
    public function getBookHeadings(Request $request, string $bookId): JsonResponse
    {
        try {
            $bookId = BookSlugHelper::resolve($bookId);

            $authError = $this->checkBookAuthorization($request, $bookId);
            if ($authError) {
                return $authError;
            }

            $nodes = DB::table('nodes')
                ->where('book', $bookId)
                ->where('content', 'LIKE', '<h_%')
                ->select('content', 'startLine')
                ->orderBy('startLine')
                ->get();

            $headings = [];
            foreach ($nodes as $node) {
                if (preg_match('/^<(h[1-6])[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h[1-6]>/i', $node->content, $match)) {
                    $cleanText = strip_tags($match[3]);
                    $cleanText = trim(html_entity_decode($cleanText, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
                    if ($cleanText) {
                        $headings[] = [
                            'id' => $match[2],
                            'type' => strtolower($match[1]),
                            'text' => $cleanText,
                        ];
                    }
                }
            }

            return response()->json($headings);

        } catch (\Exception $e) {
            Log::error('Error fetching book headings', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'error' => 'Internal server error',
                'message' => 'Failed to fetch headings'
            ], 500);
        }
    }

    /**
     * Get a batch of nodes by chunk_id range (for batched background download).
     * Accepts ?from=0&to=49 chunk_id range (inclusive).
     * Returns same node format as getBookData but only for the requested range.
     */
    public function getBookDataBatch(Request $request, string $bookId): JsonResponse
    {
        try {
            $bookId = BookSlugHelper::resolve($bookId);

            $authError = $this->checkBookAuthorization($request, $bookId);
            if ($authError) {
                return $authError;
            }

            // parseFloat semantics: chunk_id is a double precision column (decimals from
            // fractional indexing), so the range bounds must preserve decimals too.
            $from = (float) $request->query('from', 0);
            $to = (float) $request->query('to', PHP_FLOAT_MAX);

            $cache = $this->bookCache();
            $fresh = $cache->isFresh($bookId, $cache->freshTimestamp($bookId));

            // Fetch annotations ONCE for the entire request
            $hyperlights = $this->getHyperlights($bookId);
            $hypercites = $this->getHypercites($bookId);

            $hyperlightsByNode = $this->buildHyperlightsByNodeFromProcessed($hyperlights);
            $hypercitesByNode = $this->buildHypercitesByNodeFromProcessed($hypercites);

            // Base nodes within the chunk_id range — from cache on a HIT, else Postgres.
            $base = null;
            if ($fresh) {
                $manifest = $cache->getManifest($bookId);
                if ($manifest !== null) {
                    $base = [];
                    foreach ($manifest as $entry) {
                        $cid = (float) $entry['chunk_id'];
                        if ($cid < $from || $cid > $to) {
                            continue;
                        }
                        $chunkNodes = $cache->getChunk($bookId, $cid);
                        if ($chunkNodes === null) { // incomplete cache → fall back to PG
                            $base = null;
                            break;
                        }
                        foreach ($chunkNodes as $n) {
                            $base[] = $n;
                        }
                    }
                }
            }
            if ($base === null) {
                $base = DB::table('nodes')
                    ->where('book', $bookId)
                    ->whereBetween('chunk_id', [$from, $to])
                    ->orderBy('chunk_id')
                    ->orderBy('startLine')
                    ->get()
                    ->map(fn ($row) => $this->baseNodeRow($row))
                    ->toArray();
                if (!$fresh) {
                    $this->warmAsync($bookId);
                }
            }

            $nodes = BookCache::mergeAnnotations($base, $hyperlightsByNode, $hypercitesByNode);

            return response()->json([
                'nodes' => $nodes,
                'metadata' => [
                    'book_id' => $bookId,
                    'from' => $from,
                    'to' => $to,
                    'node_count' => count($nodes),
                ]
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching book data batch', [
                'book_id' => $bookId,
                'from' => $request->query('from'),
                'to' => $request->query('to'),
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'error' => 'Internal server error',
                'message' => 'Failed to fetch book data batch'
            ], 500);
        }
    }

    /**
     * Get just library data for a specific book
     */
    public function getBookLibrary(Request $request, string $bookId): JsonResponse
    {
        try {
            $bookId = BookSlugHelper::resolve($bookId);
            Log::info('getBookLibrary called', ['book_id' => $bookId]);

            // Library records (bibliographic metadata) are publicly accessible
            // even for private books, as they may be cited in public documents.
            // The privacy restriction applies to nodes (actual content), not citations.
            $libraryRecord = DB::connection('pgsql_admin')->table('library')->where('book', $bookId)->first();

            // A missing library row is an EXPECTED, benign condition — freshly-authored
            // sub-books (footnotes/hyperlights) have no server `library` row until they sync,
            // and the per-load freshness check fetches this for every book/sub-book. Answer
            // 200 with library:null ("nothing to compare") rather than 404, so the browser
            // doesn't log a console error on every such fetch (which trips the e2e
            // no-console-errors gate). The client already maps success:false → null.
            if (!$libraryRecord) {
                return response()->json([
                    'success' => false,
                    'library' => null,
                    'book_id' => $bookId,
                    'reason' => 'not_found'
                ], 200);
            }

            $library = $this->getLibrary($bookId, true);

            if (!$library) {
                return response()->json([
                    'success' => false,
                    'library' => null,
                    'book_id' => $bookId,
                    'reason' => 'not_found'
                ], 200);
            }

            Log::info('Returning library data to client', [
                'book_id' => $bookId,
                'timestamp_in_response' => $library['timestamp'] ?? 'NOT_SET',
                'full_library_array' => $library
            ]);

            return response()->json([
                'success' => true,
                'library' => $library,
                'book_id' => $bookId
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching library data', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return response()->json([
                'error' => 'Internal server error',
                'message' => 'Failed to fetch library data'
            ], 500);
        }
    }

    /**
     * Get full sub-book data for IndexedDB import.
     * Sub-book IDs are two segments: {parentBook}/{subId} (e.g. TheBible/HL_12345).
     * Delegates to getBookData() with the reconstructed full ID.
     */
    public function getSubBookData(Request $request, string $parentBook, string $subId): JsonResponse
    {
        $parentBook = BookSlugHelper::resolve($parentBook);
        return $this->getBookData($request, $parentBook . '/' . $subId);
    }

    /**
     * Get the library record for a sub-book ({parentBook}/{subId}/library).
     * Sub-book ids contain a "/" which can't ride in the single-segment {bookId}/library
     * route, so the freshness check 404'd for every footnote/hyperlight sub-book. Reconstructs
     * the full id and delegates to getBookLibrary (which answers 200 library:null when absent).
     */
    public function getSubBookLibrary(Request $request, string $parentBook, string $subId): JsonResponse
    {
        $parentBook = BookSlugHelper::resolve($parentBook);
        return $this->getBookLibrary($request, $parentBook . '/' . $subId);
    }

    /**
     * Get annotations (hyperlights + hypercites) for a sub-book ({parentBook}/{subId}/annotations).
     * Same slash problem as getSubBookLibrary: a nested sub-book id can't ride in the
     * single-segment {bookId}/annotations route, so syncAnnotationsOnly 404'd for every nested
     * sub-book. Reconstructs the full id and delegates to getBookAnnotations.
     */
    public function getSubBookAnnotations(Request $request, string $parentBook, string $subId): JsonResponse
    {
        $parentBook = BookSlugHelper::resolve($parentBook);
        return $this->getBookAnnotations($request, $parentBook . '/' . $subId);
    }

    /**
     * Get initial chunk for fast first-render loading.
     * Returns a single chunk of nodes + chunk manifest for lazy loading the rest.
     */
    public function getInitialChunk(Request $request, string $bookId): JsonResponse
    {
        try {
            $bookId = BookSlugHelper::resolve($bookId);
            $authError = $this->checkBookAuthorization($request, $bookId);
            if ($authError) {
                return $authError;
            }

            // File-cache freshness (one cheap probe). When fresh, the manifest, base nodes,
            // footnotes and bibliography come from disk; annotations + library stay live.
            $cache = $this->bookCache();
            $fresh = $cache->isFresh($bookId, $cache->freshTimestamp($bookId));

            // Determine target chunk via priority chain (uses the cached id→chunk index on a HIT)
            $resolveResult = $this->resolveTargetChunkId($request, $bookId, $fresh ? $cache->getIndex($bookId) : null);
            $targetChunkId = $resolveResult['chunk_id'];
            $targetResolved = $resolveResult['resolved'];
            $targetReason = $resolveResult['reason'];
            $targetFallbackUsed = $resolveResult['fallbackUsed'];

            // 🎯 Deep-link serve trace: how a `?target=` (e.g. a #hypercite_/HL_/Fn link) was mapped
            // to a chunk, served directly as the initial render (no client lazy-scroll). `reason:index`
            // = resolved via the cached id→chunk map (no Postgres); `cache:hit` = node content from disk.
            Log::info('🎯 getInitialChunk resolved', [
                'book' => $bookId,
                'target' => $request->query('target') ?? $request->query('element_id'),
                'resolved_chunk_id' => $targetChunkId,
                'target_reason' => $targetReason,
                'target_resolved' => $targetResolved,
                'target_fallback_used' => $targetFallbackUsed,
                'cache' => $fresh ? 'hit' : 'live',
            ]);

            // Build chunk manifest — from cache on a HIT, else the aggregate query.
            $chunkManifest = $fresh ? $cache->getManifest($bookId) : null;
            if ($chunkManifest === null) {
                $chunkManifest = DB::table('nodes')
                    ->where('book', $bookId)
                    ->selectRaw('chunk_id, MIN("startLine") as first_line, MAX("startLine") as last_line, COUNT(*) as node_count')
                    ->groupBy('chunk_id')
                    ->orderBy('chunk_id')
                    ->get()
                    ->map(function ($row) {
                        return [
                            'chunk_id' => (float) $row->chunk_id,
                            'first_line' => (float) $row->first_line,
                            'last_line' => (float) $row->last_line,
                            'node_count' => (int) $row->node_count,
                        ];
                    })
                    ->toArray();
            }

            if (empty($chunkManifest)) {
                return response()->json([
                    'error' => 'No data found for book',
                    'book_id' => $bookId
                ], 404);
            }

            // Validate target chunk exists in manifest, fall back to 0
            $validChunkIds = array_column($chunkManifest, 'chunk_id');
            if (!in_array($targetChunkId, $validChunkIds)) {
                $targetChunkId = $validChunkIds[0] ?? 0;
            }

            // Pre-fetch all annotations ONCE for the entire request.
            //
            // SCALING NOTE: unlike nodes — which are chunked and lazy-loaded a chunk at a time
            // (initial chunk here, the rest via getSingleChunk / getBookDataBatch) — ALL of the
            // book's hyperlights and hypercites are loaded up-front in one shot, on the initial
            // render. This is intentional and fine at today's annotation volumes (annotations are
            // small relative to node content). If a book ever accumulates a very large number of
            // annotations, the natural lever is to make these per-chunk / lazy too. The same
            // full-book annotation fetch also happens in getBookData, getBookDataBatch and
            // getSingleChunk.
            $hyperlights = $this->getHyperlights($bookId);
            $hypercites = $this->getHypercites($bookId);

            $hyperlightsByNode = $this->buildHyperlightsByNodeFromProcessed($hyperlights);
            $hypercitesByNode = $this->buildHypercitesByNodeFromProcessed($hypercites);

            // Get nodes for target chunk using pre-fetched annotations
            $initialNodes = $this->getNodesForChunk($bookId, $targetChunkId, $hyperlightsByNode, $hypercitesByNode, $fresh, $cache);

            // If the target chunk is too small to fill a viewport, include adjacent chunks
            // so the user has enough content to scroll
            $minNodes = 20;
            if (count($initialNodes) < $minNodes && count($chunkManifest) > 1) {
                $chunkIds = array_column($chunkManifest, 'chunk_id');
                $targetPos = array_search($targetChunkId, $chunkIds);

                // Try next chunk first, then previous
                if ($targetPos !== false && $targetPos < count($chunkIds) - 1) {
                    $nextChunkId = $chunkIds[$targetPos + 1];
                    $nextNodes = $this->getNodesForChunk($bookId, $nextChunkId, $hyperlightsByNode, $hypercitesByNode, $fresh, $cache);
                    $initialNodes = array_merge($initialNodes, $nextNodes);
                }
                if (count($initialNodes) < $minNodes && $targetPos !== false && $targetPos > 0) {
                    $prevChunkId = $chunkIds[$targetPos - 1];
                    $prevNodes = $this->getNodesForChunk($bookId, $prevChunkId, $hyperlightsByNode, $hypercitesByNode, $fresh, $cache);
                    $initialNodes = array_merge($prevNodes, $initialNodes);
                }
            }

            // Get footnotes + library (small, needed immediately)
            $footnotes = $fresh ? $cache->getFootnotes($bookId) : $this->getFootnotes($bookId);
            $library = $this->getLibrary($bookId);
            $bibliography = $fresh ? $cache->getBibliography($bookId) : $this->getBibliography($bookId);

            if (!$fresh) {
                $this->warmAsync($bookId); // rebuild for next time, off the request path
            }

            // Get bookmark for restoration
            $bookmark = $this->getBookmarkData($request, $bookId);

            return response()->json([
                'initial_chunk' => $initialNodes,
                'chunk_manifest' => $chunkManifest,
                'target_chunk_id' => $targetChunkId,
                'target_resolved' => $targetResolved,
                'target_reason' => $targetReason,
                'target_fallback_used' => $targetFallbackUsed,
                'footnotes' => $footnotes,
                'library' => $library,
                'hyperlights' => $hyperlights,
                'hypercites' => $hypercites,
                'bibliography' => $bibliography,
                'bookmark' => $bookmark,
                'metadata' => [
                    'book_id' => $bookId,
                    'total_chunks' => count($chunkManifest),
                    'loaded_chunk' => $targetChunkId,
                    'generated_at' => now()->toISOString(),
                ]
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching initial chunk', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return response()->json([
                'error' => 'Internal server error',
                'message' => 'Failed to fetch initial chunk'
            ], 500);
        }
    }

    /**
     * Get initial chunk for a sub-book.
     */
    public function getSubBookInitialChunk(Request $request, string $parentBook, string $subId): JsonResponse
    {
        $parentBook = BookSlugHelper::resolve($parentBook);
        return $this->getInitialChunk($request, $parentBook . '/' . $subId);
    }

    /**
     * Get only annotations (hyperlights + hypercites) for a book.
     * Lightweight endpoint for annotation-only syncs — avoids downloading all nodes.
     */
    public function getBookAnnotations(Request $request, string $bookId): JsonResponse
    {
        try {
            $bookId = BookSlugHelper::resolve($bookId);
            $authError = $this->checkBookAuthorization($request, $bookId);
            if ($authError) {
                return $authError;
            }

            $hyperlights = $this->getHyperlights($bookId);
            $hypercites = $this->getHypercites($bookId);

            return response()->json([
                'hyperlights' => $hyperlights,
                'hypercites' => $hypercites,
                'metadata' => [
                    'book_id' => $bookId,
                    'total_hyperlights' => count($hyperlights),
                    'total_hypercites' => count($hypercites),
                ]
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching book annotations', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'error' => 'Internal server error',
                'message' => 'Failed to fetch annotations'
            ], 500);
        }
    }

    /**
     * Get a single chunk of nodes by chunk_id (for on-demand loading).
     */
    public function getSingleChunk(Request $request, string $bookId, string $chunkId): JsonResponse
    {
        try {
            // chunk_id can be a decimal (fractional indexing) — the route allows it, so parse
            // as float, NEVER (int), or an on-demand fetch of chunk 4.5 would hit chunk 4.
            $chunkId = (float) $chunkId;
            $bookId = BookSlugHelper::resolve($bookId);
            $authError = $this->checkBookAuthorization($request, $bookId);
            if ($authError) {
                return $authError;
            }

            $cache = $this->bookCache();
            $fresh = $cache->isFresh($bookId, $cache->freshTimestamp($bookId));

            // Pre-fetch annotations once
            $hyperlights = $this->getHyperlights($bookId);
            $hypercites = $this->getHypercites($bookId);

            $hyperlightsByNode = $this->buildHyperlightsByNodeFromProcessed($hyperlights);
            $hypercitesByNode = $this->buildHypercitesByNodeFromProcessed($hypercites);

            $nodes = $this->getNodesForChunk($bookId, $chunkId, $hyperlightsByNode, $hypercitesByNode, $fresh, $cache);

            if (empty($nodes)) {
                return response()->json([
                    'error' => 'Chunk not found',
                    'book_id' => $bookId,
                    'chunk_id' => $chunkId
                ], 404);
            }

            if (!$fresh) {
                $this->warmAsync($bookId);
            }

            // 📦 On-demand (lazy-load / background-download) chunk serve. A burst of these for
            // sequential chunk_ids = the client scrolling; a single one after a deep-link = a jump.
            Log::info('📦 getSingleChunk served', [
                'book' => $bookId,
                'chunk_id' => $chunkId,
                'cache' => $fresh ? 'hit' : 'live',
                'node_count' => count($nodes),
            ]);

            return response()->json([
                'nodes' => $nodes,
                'chunk_id' => $chunkId,
                'book_id' => $bookId,
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching single chunk', [
                'book_id' => $bookId,
                'chunk_id' => $chunkId,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'error' => 'Internal server error'
            ], 500);
        }
    }

    /**
     * Resolve which chunk_id to load first, based on request params.
     * Returns ['chunk_id' => int, 'resolved' => bool, 'reason' => string, 'fallbackUsed' => string|null].
     *
     * Unified branch order (mirrored on the client):
     *   1. chunk_id=N → direct
     *   2. hypercite_ → hypercites table
     *   3. HL_ → hyperlights table
     *   4. Fn (footnote pattern) → nodes.footnotes
     *   5. Numeric → nodes.startLine
     *   6. Anything else → content scan (id="<target>")
     *   7. fallback_target → retry 2-6
     *   8. Saved scroll position (bookmark)
     *   9. Lowest existing chunk_id
     */
    private function resolveTargetChunkId(Request $request, string $bookId, ?array $index = null): array
    {
        $target = $request->query('target');
        $elementId = $request->query('element_id');
        $resume = $request->query('resume');
        $chunkId = $request->query('chunk_id');

        // Step 1: Direct chunk_id param (for on-demand fetch)
        if ($chunkId !== null) {
            return ['chunk_id' => (float) $chunkId, 'resolved' => true, 'reason' => 'direct', 'fallbackUsed' => null];
        }

        // Merge element_id into target for unified branch handling
        // (element_id is the legacy param for numeric startLine targets)
        if (!$target && $elementId) {
            $target = $elementId;
        }

        // Steps 2-6: Try resolving the primary target
        if ($target) {
            $result = $this->resolveTargetToChunkIdWithReason($bookId, $target, $index);
            if ($result !== null) {
                return ['chunk_id' => $result['chunk_id'], 'resolved' => true, 'reason' => $result['reason'], 'fallbackUsed' => null];
            }

            // Step 7: Fallback target → retry steps 2-6
            $fallbackTarget = $request->query('fallback_target');
            if ($fallbackTarget) {
                $fallbackResult = $this->resolveTargetToChunkIdWithReason($bookId, $fallbackTarget, $index);
                if ($fallbackResult !== null) {
                    return ['chunk_id' => $fallbackResult['chunk_id'], 'resolved' => false, 'reason' => 'fallback_target', 'fallbackUsed' => $fallbackResult['reason']];
                }
            }

            // Step 8: Saved scroll position
            $bookmark = $this->getBookmarkData($request, $bookId);
            if ($bookmark) {
                return ['chunk_id' => (float) $bookmark['chunk_id'], 'resolved' => false, 'reason' => 'saved_position', 'fallbackUsed' => 'saved_position'];
            }

            // Step 9: Lowest existing chunk_id
            return ['chunk_id' => $this->getLowestChunkId($bookId), 'resolved' => false, 'reason' => 'lowest_chunk', 'fallbackUsed' => 'lowest_chunk'];
        }

        // No target provided — check resume
        if ($resume === 'true') {
            $bookmark = $this->getBookmarkData($request, $bookId);
            if ($bookmark) {
                return ['chunk_id' => (float) $bookmark['chunk_id'], 'resolved' => true, 'reason' => 'saved_position', 'fallbackUsed' => null];
            }
        }

        // Default: lowest chunk
        return ['chunk_id' => $this->getLowestChunkId($bookId), 'resolved' => true, 'reason' => 'lowest_chunk', 'fallbackUsed' => null];
    }

    /**
     * Try to resolve a single target identifier to a chunk_id.
     * Returns ['chunk_id' => int, 'reason' => string] or null.
     *
     * Covers: hypercite_, HL_, footnote, numeric startLine, content scan.
     */
    private function resolveTargetToChunkIdWithReason(string $bookId, string $target, ?array $index = null): ?array
    {
        // Step 0: Cached deep-link index — a single hash lookup, no Postgres. Covers
        // hypercite_/HL_/footnote/numeric-startLine targets; a miss falls through to the
        // per-table queries below (e.g. cold cache, or a content-scan-only target).
        if ($index !== null && isset($index[$target])) {
            return ['chunk_id' => (float) $index[$target], 'reason' => 'index'];
        }

        // Step 2: Hypercite
        if (str_starts_with($target, 'hypercite_')) {
            $hypercite = DB::table('hypercites')
                ->where('book', $bookId)
                ->where('hyperciteId', $target)
                ->first();
            if ($hypercite) {
                $nodeIds = json_decode($hypercite->node_id ?? '[]', true);
                if (!empty($nodeIds)) {
                    $node = DB::table('nodes')->where('book', $bookId)->where('node_id', $nodeIds[0])->first();
                    if ($node) {
                        return ['chunk_id' => (float) $node->chunk_id, 'reason' => 'hypercite'];
                    }
                }
            }
        }

        // Step 3: Hyperlight
        if (str_starts_with($target, 'HL_')) {
            $hyperlight = DB::table('hyperlights')
                ->where('book', $bookId)
                ->where('hyperlight_id', $target)
                ->first();
            if ($hyperlight) {
                $nodeIds = json_decode($hyperlight->node_id ?? '[]', true);
                if (!empty($nodeIds)) {
                    $node = DB::table('nodes')->where('book', $bookId)->where('node_id', $nodeIds[0])->first();
                    if ($node) {
                        return ['chunk_id' => (float) $node->chunk_id, 'reason' => 'hyperlight'];
                    }
                }
            }
        }

        // Step 4: Footnote (tightened regex: must match Fn followed by a digit)
        if (preg_match('/(^|_)Fn\d/', $target)) {
            $node = DB::table('nodes')
                ->where('book', $bookId)
                ->whereRaw('footnotes::jsonb @> ?', [json_encode([$target])])
                ->first();
            if ($node) {
                return ['chunk_id' => (float) $node->chunk_id, 'reason' => 'footnote'];
            }
        }

        // Step 5: Numeric startLine
        if (preg_match('/^\d+(\.\d+)?$/', $target)) {
            $node = DB::table('nodes')
                ->where('book', $bookId)
                ->where('startLine', (float) $target)
                ->first();
            if ($node) {
                return ['chunk_id' => (float) $node->chunk_id, 'reason' => 'startLine'];
            }
        }

        // Step 6: Content scan — find element with id="<target>" in node content
        // Rare fallback path, O(n) on server
        $likePattern = '%id="' . str_replace(['%', '_'], ['\\%', '\\_'], $target) . '"%';
        $node = DB::table('nodes')
            ->where('book', $bookId)
            ->where('content', 'LIKE', $likePattern)
            ->first();
        if ($node) {
            return ['chunk_id' => (float) $node->chunk_id, 'reason' => 'content_scan'];
        }

        return null;
    }

    /**
     * Get the lowest chunk_id for a book.
     * Falls back to 0 if no chunks exist.
     */
    private function getLowestChunkId(string $bookId): int
    {
        $minChunk = DB::table('nodes')
            ->where('book', $bookId)
            ->min('chunk_id');
        return $minChunk !== null ? (float) $minChunk : 0;
    }

    /**
     * Get node chunks for a specific chunk_id with embedded annotations.
     * Variant of getNodesWithPreFetched() filtered to a single chunk_id.
     * Accepts pre-fetched annotation lookups to avoid redundant queries.
     */
    private function getNodesForChunk(string $bookId, float $chunkId, array $hyperlightsByNode, array $hypercitesByNode, bool $cacheFresh = false, ?BookCache $cache = null): array
    {
        // Cache HIT: serve user-independent base nodes from disk, then splice in the
        // per-requester annotation arrays (which are always fetched live).
        if ($cacheFresh && $cache) {
            $base = $cache->getChunk($bookId, $chunkId);
            if ($base !== null) {
                return BookCache::mergeAnnotations($base, $hyperlightsByNode, $hypercitesByNode);
            }
        }

        $base = DB::table('nodes')
            ->where('book', $bookId)
            ->where('chunk_id', $chunkId)
            ->orderBy('startLine')
            ->get()
            ->map(fn ($row) => $this->baseNodeRow($row))
            ->toArray();

        return BookCache::mergeAnnotations($base, $hyperlightsByNode, $hypercitesByNode);
    }

    /**
     * Get bookmark data for the current user/session — the `user_reading_positions` row.
     *
     * The LOAD shape for the TS `ReadingPosition` contract (also embedded as `bookmark` in
     * `getInitialChunk`'s response). Identity is `user_name` when logged in, else the `anon_token`
     * cookie; no identity ⇒ null. `chunk_id` is cast to int here (the column is integer).
     * `updated_at` is epoch ms (the row's last-saved time) — the client compares it against a
     * per-target navigatedAt for the durable resume-vs-jump decision.
     *
     * @return array{chunk_id: int, element_id: ?string, updated_at: ?int}|null
     */
    private function getBookmarkData(Request $request, string $bookId): ?array
    {
        // Single source of truth (shared with TextController's prerender) so the server
        // prerender and this `resume` read always resolve the SAME chunk.
        return \App\Services\ReadingPosition::lookup($request, $bookId);
    }

    /**
     * Save reading position (bookmark) — the SAVE path for the TS `ReadingPosition` contract.
     *
     * Upserts the `user_reading_positions` row keyed by (book, user_name) when logged in, else
     * (book, anon_token); no identity ⇒ 401. Request body: array{chunk_id: int, element_id: ?string}.
     *
     * @return JsonResponse array{success: true} | array{error: string}
     */
    public function saveReadingPosition(Request $request, string $bookId): JsonResponse
    {
        try {
            $bookId = BookSlugHelper::resolve($bookId);
            $user = Auth::user();
            $anonymousToken = $request->cookie('anon_token');

            // float, NOT (int): a scroll position can sit in a decimal (fractional) chunk —
            // the user_reading_positions.chunk_id column is double precision to preserve it.
            $chunkId = (float) $request->input('chunk_id', 0);
            $elementId = $request->input('element_id');

            if ($user) {
                DB::table('user_reading_positions')
                    ->updateOrInsert(
                        ['book' => $bookId, 'user_name' => $user->name],
                        [
                            'chunk_id' => $chunkId,
                            'element_id' => $elementId,
                            'anon_token' => null,
                            'updated_at' => now(),
                        ]
                    );
            } elseif ($anonymousToken) {
                DB::table('user_reading_positions')
                    ->updateOrInsert(
                        ['book' => $bookId, 'anon_token' => $anonymousToken],
                        [
                            'chunk_id' => $chunkId,
                            'element_id' => $elementId,
                            'user_name' => null,
                            'updated_at' => now(),
                        ]
                    );
            } else {
                return response()->json(['error' => 'No user identity'], 401);
            }

            return response()->json(['success' => true]);

        } catch (\Exception $e) {
            Log::error('Error saving reading position', [
                'book_id' => $bookId,
                'error' => $e->getMessage()
            ]);

            return response()->json(['error' => 'Internal server error'], 500);
        }
    }

    /**
     * Get reading position (bookmark) — the standalone LOAD endpoint for the TS `ReadingPosition`.
     *
     * Thin wrapper over getBookmarkData(); the same bookmark is also delivered inline by getInitialChunk.
     *
     * @return JsonResponse array{bookmark: array{chunk_id: int, element_id: ?string}|null}
     */
    public function getReadingPosition(Request $request, string $bookId): JsonResponse
    {
        try {
            $bookId = BookSlugHelper::resolve($bookId);
            $bookmark = $this->getBookmarkData($request, $bookId);

            if (!$bookmark) {
                return response()->json(['bookmark' => null]);
            }

            return response()->json(['bookmark' => $bookmark]);

        } catch (\Exception $e) {
            Log::error('Error getting reading position', [
                'book_id' => $bookId,
                'error' => $e->getMessage()
            ]);

            return response()->json(['error' => 'Internal server error'], 500);
        }
    }
}