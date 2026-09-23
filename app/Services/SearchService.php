<?php

namespace App\Services;

use App\Services\CanonicalVersions\BestVersionService;
use Illuminate\Support\Facades\DB;

class SearchService
{
    /**
     * Connection for the read-only search queries. Defaults to the BYPASSRLS
     * admin connection — see config/database.php 'search_read_connection' and
     * deploy/search-performance.md for the full rationale (GIN indexes are
     * unusable under RLS because ts_match is not LEAKPROOF, and managed
     * Postgres has no superuser to change that). Visibility is enforced
     * explicitly in every query here, NOT by RLS; the privacy contract is
     * locked by tests/Feature/AiBrain/RetrievalScopeTest.php +
     * tests/Feature/Citations/CitationSearchTest.php.
     */
    private function searchConnection(): \Illuminate\Database\ConnectionInterface
    {
        return DB::connection(config('database.search_read_connection'));
    }

    /**
     * The node FTS expression. Since 2026-08 the tsvectors are NOT stored
     * columns — only expression GIN indexes (nodes_fts_english_idx /
     * nodes_fts_simple_idx) exist, so every WHERE / ts_rank must use this
     * exact expression or the planner falls back to a seq scan. plainText
     * only, no content fallback: content is ciphertext for E2EE books, and
     * every non-encrypted row has plainText (backfilled in the
     * replace_stored_tsvectors migration; PgNode::saving keeps it that way).
     *
     * Also the single whitelist for interpolating a config name into SQL.
     */
    public static function nodeTsExpression(string $config, string $alias = 'nodes'): string
    {
        if (!in_array($config, ['simple', 'english'], true)) {
            throw new \InvalidArgumentException("Invalid search config: {$config}");
        }

        return "to_tsvector('{$config}', COALESCE({$alias}.\"plainText\", ''))";
    }

    /**
     * Convert user query to PostgreSQL tsquery format.
     * Handles phrase search with quotes and joins terms with &.
     */
    public function buildTsQuery(string $query, string $operator = '&'): string
    {
        $query = trim($query);

        if (empty($query)) {
            return '';
        }

        $parts = [];

        // 1. Extract quoted phrases → "(word1 <-> word2 <-> ...)"
        $remaining = preg_replace_callback('/"([^"]+)"/', function ($match) use (&$parts) {
            $words = preg_split('/[\s\-]+/', trim($match[1]));
            $words = array_map(fn($w) => preg_replace('/[^\w]/', '', $w), $words);
            $words = array_filter($words, fn($w) => strlen($w) >= 1);
            if (count($words) === 1) {
                $parts[] = reset($words);
            } elseif (count($words) > 1) {
                $parts[] = '(' . implode(' <-> ', $words) . ')';
            }
            return '';
        }, $query);

        // 2. Extract remaining unquoted terms
        $remaining = trim($remaining);
        if (!empty($remaining)) {
            $terms = preg_split('/\s+/', $remaining);
            foreach ($terms as $term) {
                $term = preg_replace('/[^\w]/', '', $term);
                if (strlen($term) >= 1) {
                    $parts[] = $term;
                }
            }
        }

        if (empty($parts)) {
            return '';
        }

        // 3. Cap at 6 parts to prevent overly complex queries
        $parts = array_slice($parts, 0, 6);

        // 4. Add prefix matching to last part (if it's a plain term, not a phrase group)
        $lastIndex = count($parts) - 1;
        if (!str_contains($parts[$lastIndex], '<->')) {
            $parts[$lastIndex] .= ':*';
        }

        return implode(" {$operator} ", $parts);
    }

    /**
     * Search nodes by keyword using PostgreSQL full-text search.
     * Returns flat array of stdClass results with node data + library metadata.
     *
     * 🔒 Privacy contract: NO private book is ever returned, regardless of scope.
     * Locked by tests/Feature/AiBrain/RetrievalScopeTest.php:
     *   - "searchNodesByKeyword: public scope excludes private books"
     *   - "searchNodesByKeyword: mine scope returns only callers own PUBLIC books"
     *   - "searchNodesByKeyword: shelf scope restricts to shelf members"
     *   - "searchNodesByKeyword: shelf scope excludes private books even when they are in the shelf"
     *   - "searchNodesByKeyword: shelf scope with empty shelf returns nothing"
     */
    public function searchNodesByKeyword(
        string $query,
        int $limit = 10,
        ?string $excludeBook = null,
        string $sourceScope = 'public',
        ?string $creatorName = null,
        string $tsOperator = '&',
        ?string $shelfId = null
    ): array {
        $tsQuery = $this->buildTsQuery($query, $tsOperator);

        if (empty($tsQuery)) {
            return [];
        }

        // Try exact (simple) first, fall back to stemmed (english)
        $probeExpr = self::nodeTsExpression('simple');
        $simpleCount = $this->searchConnection()->selectOne("
            SELECT COUNT(*) as cnt FROM (
                SELECT 1 FROM nodes
                WHERE {$probeExpr} @@ to_tsquery('simple', ?)
                AND book NOT IN ('most-recent', 'most-connected', 'most-lit')
                LIMIT 101
            ) sub
        ", [$tsQuery]);

        $config = ($simpleCount->cnt ?? 0) > 0 ? 'simple' : 'english';
        $tsExpr = self::nodeTsExpression($config);

        // Visibility — private books are NEVER returned, regardless of scope.
        // `mine` narrows further to the user's own public books; `shelf` narrows via join.
        if ($sourceScope === 'mine' && $creatorName) {
            $visibilityClause = "(library.creator = ? AND library.visibility = 'public')";
            $visibilityParams = [$creatorName];
        } else {
            // Default ('public') and 'shelf' (shelf join applied separately) both restrict to public
            $visibilityClause = "(library.visibility = 'public')";
            $visibilityParams = [];
        }

        $shelfJoin = '';
        $shelfParams = [];
        if ($sourceScope === 'shelf' && $shelfId) {
            $shelfJoin = 'JOIN shelf_items ON shelf_items.book = hits.book AND shelf_items.shelf_id = ?';
            $shelfParams = [$shelfId];
        }

        $excludeClause = '';
        $excludeParams = [];
        if ($excludeBook) {
            $excludeClause = 'AND hits.book != ?';
            $excludeParams = [$excludeBook];
        }

        $orderClause = $tsOperator === '|'
            ? "ORDER BY ts_rank(hits.vec, to_tsquery('{$config}', ?)) DESC"
            : "ORDER BY library.created_at DESC";
        $rankParams = $tsOperator === '|' ? [$tsQuery] : [];

        // hits is a MATERIALIZED CTE over nodes only, capped, so the GIN
        // expression index drives the plan and the tsvector (vec) is computed
        // at most $candidateCap times for ranking — same fence-and-cap shape
        // (and same caveat: candidates that fail the visibility/exclude
        // filters below consume cap slots) as buildNodeSearchQuery.
        $candidateCap = max($limit * 20, 300);

        $sql = "
            WITH hits AS MATERIALIZED (
                SELECT
                    nodes.id,
                    nodes.book,
                    nodes.node_id,
                    nodes.\"plainText\",
                    nodes.content,
                    COALESCE(nodes.\"plainText\", nodes.content, '') as text_content,
                    {$tsExpr} AS vec
                FROM nodes
                WHERE {$tsExpr} @@ to_tsquery('{$config}', ?)
                    AND nodes.book NOT IN ('most-recent', 'most-connected', 'most-lit')
                LIMIT {$candidateCap}
            )
            SELECT
                sub.id,
                sub.book,
                sub.node_id,
                sub.\"plainText\",
                sub.content,
                sub.title AS book_title,
                sub.author AS book_author,
                sub.year AS book_year,
                sub.bibtex,
                ts_headline('{$config}', sub.text_content,
                    to_tsquery('{$config}', ?),
                    'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'
                ) as headline
            FROM (
                SELECT
                    hits.*,
                    library.title,
                    library.author,
                    library.year,
                    library.bibtex
                FROM hits
                JOIN library ON hits.book = library.book
                {$shelfJoin}
                WHERE library.type != 'sub_book'
                    AND {$visibilityClause}
                    {$excludeClause}
                {$orderClause}
                LIMIT ?
            ) sub
        ";

        $params = array_merge(
            [$tsQuery, $tsQuery],
            $shelfParams,
            $visibilityParams,
            $excludeParams,
            $rankParams,
            [$limit]
        );

        $results = $this->searchConnection()->select($sql, $params);

        // Normalize to stdClass with consistent field names
        return array_map(function ($row) {
            $row->similarity = 0.5; // Fixed similarity for keyword matches
            return $row;
        }, $results);
    }

    /**
     * Search library metadata (title/author/year) by keyword.
     * Returns array of stdClass results with library metadata.
     *
     * 🔒 Privacy contract: NO private book is ever returned, regardless of scope.
     * Locked by tests/Feature/AiBrain/RetrievalScopeTest.php:
     *   - "searchLibraryByKeyword: public scope excludes private books"
     *   - "searchLibraryByKeyword: mine scope excludes private and other users books"
     *   - "searchLibraryByKeyword: shelf scope is constrained to public books in shelf"
     */
    public function searchLibraryByKeyword(
        string $query,
        int $limit = 10,
        string $sourceScope = 'public',
        ?string $creatorName = null,
        ?string $shelfId = null,
        ?array $books = null
    ): array {
        $tsQuery = $this->buildTsQuery($query);

        if (empty($tsQuery)) {
            return [];
        }

        $dbQuery = $this->searchConnection()->table('library')
            ->selectRaw("
                library.book,
                library.title,
                library.author,
                library.year,
                library.bibtex,
                library.has_nodes,
                ts_rank('{0.05, 0.1, 0.3, 1.0}', library.search_vector, to_tsquery('simple', ?)) as relevance
            ", [$tsQuery])
            ->whereRaw("library.search_vector @@ to_tsquery('simple', ?)", [$tsQuery])
            ->where('library.type', '!=', 'sub_book');

        // Scope filtering — private books are NEVER returned, regardless of scope
        if ($sourceScope === 'books' && $books !== null) {
            // Caller-resolved book list (e.g. ShelfController::publicSearch,
            // which resolves a PUBLIC shelf's books via pgsql_admin — the
            // 'shelf' scope below joins shelf_items on the RLS'd connection,
            // whose select policy is OWNER-ONLY, so it returns nothing for
            // guests even on public shelves).
            $dbQuery->whereIn('library.book', $books)
                ->where('library.visibility', 'public');
        } elseif ($sourceScope === 'shelf' && $shelfId) {
            $dbQuery->join('shelf_items', 'shelf_items.book', '=', 'library.book')
                ->where('shelf_items.shelf_id', $shelfId)
                ->where('library.visibility', 'public');
        } elseif ($sourceScope === 'mine' && $creatorName) {
            $dbQuery->where('library.creator', $creatorName)
                ->where('library.visibility', 'public');
        } else {
            // Default: public
            $dbQuery->where('library.visibility', 'public')
                ->where('library.listed', true);
        }

        return $dbQuery
            ->orderByDesc('relevance')
            ->limit($limit)
            ->get()
            ->toArray();
    }

    /**
     * Hybrid citation search: UNION of canonical_source rows (citation identities)
     * and orphan library rows (user imports with no canonical link).
     *
     * Test coverage: tests/Feature/Citations/CitationSearchTest.php
     *   — privacy contract (public/mine/shelf), hybrid row shapes (canonical /
     *     canonical-only / orphan-library), is_private flag, scope leak regressions.
     *
     * On public scope the canonical branch is unrestricted (canonical metadata is
     * intentionally global). On mine/shelf scope BOTH branches are scope-filtered —
     * a canonical only shows up if its resolved best-version (or any linked version)
     * passes the same membership check as the orphan branch. This prevents the
     * "I picked a 2-book shelf and got 50 results" leak where the canonical branch
     * surfaces global metadata that has nothing to do with the user's shelf.
     *
     * Each branch limits to $limit candidates BEFORE the outer sort, so the worst
     * case is 2*$limit rows getting ranked.
     *
     * Returns array of stdClass with: row_type ('canonical'|'library'), id, title,
     * author, year, journal, bibtex, best_version_book, has_version, is_private,
     * relevance.
     */
    public function searchForCitations(
        string $query,
        int $limit = 15,
        int $offset = 0,
        string $sourceScope = 'public',
        ?string $creatorName = null,
        ?string $shelfId = null,
    ): array {
        $tsQuery = $this->buildTsQuery($query);
        if (empty($tsQuery)) {
            return [];
        }

        [$sql, $params] = $this->buildCitationSearchQuery($tsQuery, $limit, $offset, $sourceScope, $creatorName, $shelfId);

        $rows = $this->searchConnection()->select($sql, $params);

        // Generate synthetic bibtex for canonical rows so the frontend's
        // parseAuthorYear gives a sensible inline (Author Year) citation.
        foreach ($rows as $row) {
            if (empty($row->bibtex) && !empty($row->title)) {
                $row->bibtex = $this->buildSyntheticBibtex($row);
            }
        }

        return $rows;
    }

    /**
     * Assemble the hybrid citation-search SQL + params for a pre-built tsquery.
     * Split from searchForCitations so `php artisan search:profile` can EXPLAIN
     * the exact production query without duplicating it.
     *
     * @return array{0: string, 1: array} [sql, params]
     */
    public function buildCitationSearchQuery(
        string $tsQuery,
        int $limit = 15,
        int $offset = 0,
        string $sourceScope = 'public',
        ?string $creatorName = null,
        ?string $shelfId = null,
    ): array {
        [$libScopeSql, $libScopeParams, $libJoinSql, $libJoinParams] = $this->buildLibraryScopeClauseForCitations($sourceScope, $creatorName, $shelfId);
        [$canonScopeSql, $canonScopeParams] = $this->buildCanonicalScopeClauseForCitations($sourceScope, $creatorName, $shelfId);

        // In shelf scope we want ALL shelf members (including canonicalized ones),
        // not just orphan library rows — the user picked these specific versions.
        // In public/mine we exclude canonicalized library rows so they don't
        // duplicate their own canonical entry from the other branch.
        $libOrphanFilter = ($sourceScope === 'shelf') ? 'TRUE' : 'l.canonical_source_id IS NULL';

        // Inner branches each cap to $limit so the outer sort is cheap.
        // ts_rank's weight array is identical to the one library searches use.
        // LEFT JOIN library-on-best-version in the canonical branch so we can
        // surface a private-lock badge when the version we'd resolve to is one
        // of the caller's private books (per the attribution-first contract).
        // Pointer precedence comes from VersionPointerRegistry via this
        // expression — never hard-code the version_book columns here.
        $bestVersionSql = BestVersionService::sqlCoalesceExpression('c');

        // The lv join + has_version EXISTS live OUTSIDE the LIMITed inner
        // select, on the MATERIALIZED best_version_book column. Joining on the
        // raw COALESCE expression prevented index use on library.book — the
        // planner materialized the whole RLS-filtered library table per scan
        // (~200ms measured). Post-restructure it's ≤ $limit index lookups.
        $sql = "
            SELECT * FROM (
                (
                    SELECT
                        'canonical'::text AS row_type,
                        cb.raw_id::text AS id,
                        cb.title,
                        cb.author,
                        cb.year::text AS year,
                        cb.journal,
                        NULL::text AS bibtex,
                        cb.best_version_book,
                        (
                            cb.best_version_book IS NOT NULL
                            OR EXISTS (SELECT 1 FROM library WHERE canonical_source_id = cb.raw_id LIMIT 1)
                        ) AS has_version,
                        (lv.visibility = 'private') AS is_private,
                        cb.relevance
                    FROM (
                        SELECT
                            c.id AS raw_id,
                            c.title,
                            c.author,
                            c.year,
                            c.journal,
                            {$bestVersionSql} AS best_version_book,
                            ts_rank('{0.05, 0.1, 0.3, 1.0}', c.search_vector, to_tsquery('simple', ?)) AS relevance
                        FROM canonical_source c
                        WHERE c.search_vector @@ to_tsquery('simple', ?)
                          AND {$canonScopeSql}
                        ORDER BY relevance DESC
                        LIMIT ?
                    ) cb
                    LEFT JOIN library lv ON lv.book = cb.best_version_book
                )
                UNION ALL
                (
                    SELECT
                        'library'::text AS row_type,
                        l.book::text AS id,
                        l.title,
                        l.author,
                        l.year::text AS year,
                        NULL::text AS journal,
                        l.bibtex,
                        l.book::text AS best_version_book,
                        true AS has_version,
                        (l.visibility = 'private') AS is_private,
                        ts_rank('{0.05, 0.1, 0.3, 1.0}', l.search_vector, to_tsquery('simple', ?)) AS relevance
                    FROM library l
                    {$libJoinSql}
                    WHERE {$libOrphanFilter}
                      AND l.search_vector @@ to_tsquery('simple', ?)
                      AND l.type IS DISTINCT FROM 'sub_book'
                      AND {$libScopeSql}
                    ORDER BY relevance DESC
                    LIMIT ?
                )
            ) combined
            ORDER BY relevance DESC
            LIMIT ? OFFSET ?
        ";

        // Param order MUST match placeholder appearance in the SQL string:
        //   canonical: ts_rank(SELECT) ?, to_tsquery(WHERE) ?, [scope EXISTS ?], LIMIT ?
        //   library:   ts_rank(SELECT) ?, [JOIN shelf_id ?], to_tsquery(WHERE) ?,
        //              [mine scope creator ?], LIMIT ?
        //   outer:     LIMIT ?, OFFSET ?
        // The library ts_rank placeholder appears BEFORE the JOIN's placeholder
        // in the SQL string (SELECT comes before FROM), so it must come first
        // in the params list — even though semantically the JOIN ID is "earlier."
        $params = array_merge(
            [$tsQuery, $tsQuery],            // canonical: rank, where
            $canonScopeParams,               // canonical: scope (EXISTS shelf/mine)
            [$limit],                        // canonical: LIMIT
            [$tsQuery],                      // library: ts_rank (SELECT) — BEFORE join
            $libJoinParams,                  // library: shelf_id (FROM JOIN)
            [$tsQuery],                      // library: to_tsquery (WHERE)
            $libScopeParams,                 // library: mine creator (WHERE)
            [$limit, $limit, $offset],      // library limit, outer limit, outer offset
        );

        return [$sql, $params];
    }

    /**
     * Assemble the /api/search/nodes SQL + params for a pre-built tsquery.
     *
     * Extracted from SearchController::executeNodeSearch so the controller and
     * `php artisan search:profile` share one copy of the query. The config is
     * validated (whitelisted) by nodeTsExpression before interpolation.
     *
     * Two-stage: inner subquery uses no ORDER BY so the GIN scan can
     * stream-and-stop at LIMIT (cheap regardless of match cardinality).
     * Outer query computes ts_headline + ts_rank_cd on just those rows
     * and orders them by relevance (cheap — only $limit rows).
     *
     * @return array{0: string, 1: array} [sql, params]
     */
    public function buildNodeSearchQuery(
        string $tsQuery,
        string $config,
        int $limit,
        ?string $creatorName = null,
        ?string $anonToken = null,
    ): array {
        $tsExpr = self::nodeTsExpression($config);
        [$visibilityClause, $visibilityParams] = $this->nodeVisibilityClause($creatorName, $anonToken);

        // Shape notes (each stage measured via `php artisan search:profile -v`):
        //
        // 1. This runs on the search connection (BYPASSRLS everywhere — GIN
        //    indexes are unusable under RLS because ts_match_vq is not
        //    LEAKPROOF and managed Postgres has no superuser to change that:
        //    seq scans of 2.2M rows, seconds per query). Visibility is
        //    enforced by the explicit clause below, not RLS.
        // 2. `hits` is a MATERIALIZED CTE over nodes ONLY, so the plan ALWAYS
        //    drives from the GIN index. Without the fence the planner sometimes
        //    drives from library instead (585 visible books × bitmap probe each
        //    ≈ 800ms for single-term queries); fenced, every query class
        //    measures 2-50ms.
        // 3. The candidate cap bounds the CTE. Candidates that fail the
        //    visibility clause below (private/unlisted books) consume cap
        //    slots, so pathological corpora could theoretically starve the
        //    final page — 20× limit keeps that risk negligible.
        // 4. parent_lib joins on the MATERIALIZED sub.parent_book AFTER the
        //    LIMIT. Joining on split_part(...) inside the scan seq-scanned the
        //    whole RLS-filtered library per candidate row (~1.3s measured);
        //    materialized it's ≤ $limit index lookups.
        $candidateCap = max($limit * 20, 300);

        $sql = "
            WITH hits AS MATERIALIZED (
                SELECT
                    nodes.book,
                    nodes.node_id,
                    nodes.\"startLine\",
                    COALESCE(nodes.\"plainText\", nodes.content, '') as text_content,
                    {$tsExpr} AS vec
                FROM nodes
                WHERE {$tsExpr} @@ to_tsquery('{$config}', ?)
                    AND nodes.book NOT IN ('most-recent', 'most-connected', 'most-lit')
                LIMIT {$candidateCap}
            )
            SELECT
                sub.book,
                sub.node_id,
                sub.\"startLine\",
                sub.title,
                sub.author,
                sub.is_subbook,
                sub.subbook_kind,
                sub.parent_book,
                parent_lib.title AS parent_title,
                parent_lib.author AS parent_author,
                ts_headline('{$config}', sub.text_content,
                    to_tsquery('{$config}', ?),
                    'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'
                ) as headline
            FROM (
                SELECT
                    hits.book,
                    hits.node_id,
                    hits.\"startLine\",
                    library.title,
                    library.author,
                    (hits.book LIKE '%/%') AS is_subbook,
                    CASE WHEN hits.book ~ 'HL_[^/]*\$' THEN 'highlight' ELSE 'footnote' END AS subbook_kind,
                    split_part(hits.book, '/', 1) AS parent_book,
                    hits.text_content,
                    hits.vec
                FROM hits
                JOIN library ON hits.book = library.book
                WHERE {$visibilityClause}
                LIMIT ?
            ) sub
            LEFT JOIN library AS parent_lib
                ON sub.is_subbook
                AND parent_lib.book = sub.parent_book
            ORDER BY ts_rank_cd(sub.vec, to_tsquery('{$config}', ?)) DESC
        ";

        $params = array_merge(
            [$tsQuery, $tsQuery],
            $visibilityParams,
            [$limit, $tsQuery]
        );

        return [$sql, $params];
    }

    /**
     * The homepage-search visibility contract, single-sourced for both the
     * full-text and semantic node builders: public listed books, plus the
     * caller's own non-deleted books (by creator name or anon token).
     * Expects the joined library table to be addressable as `library`.
     *
     * @return array{0: string, 1: array} [whereClause, params]
     */
    private function nodeVisibilityClause(?string $creatorName, ?string $anonToken): array
    {
        $conditions = ["(library.listed = true AND library.visibility NOT IN ('private', 'deleted'))"];
        $params = [];

        if ($creatorName) {
            $conditions[] = "(library.creator = ? AND library.visibility != 'deleted')";
            $params[] = $creatorName;
        }

        if ($anonToken) {
            $conditions[] = "(library.creator_token = ? AND library.visibility != 'deleted')";
            $params[] = $anonToken;
        }

        return ['(' . implode(' OR ', $conditions) . ')', $params];
    }

    /**
     * The book set the semantic node search may surface: non-sub_book rows
     * passing the homepage visibility contract. Fetched as a SEPARATE cheap
     * query (library_listed_visible_idx) and pushed INTO the HNSW scan as a
     * nodes-local filter — see buildSemanticNodeSearchQuery for why a
     * post-scan visibility join is not merely slower but WRONG.
     *
     * @return string[] book ids
     */
    public function getVisibleSemanticSearchBooks(?string $creatorName, ?string $anonToken): array
    {
        [$visibilityClause, $visibilityParams] = $this->nodeVisibilityClause($creatorName, $anonToken);

        $rows = DB::connection(config('database.search_read_connection'))->select(
            "SELECT library.book FROM library WHERE library.type != 'sub_book' AND {$visibilityClause}",
            $visibilityParams,
        );

        return array_map(fn ($r) => $r->book, $rows);
    }

    /**
     * Assemble the /api/search/semantic SQL + params for a pre-computed query
     * embedding and a pre-computed visible-book set (from
     * getVisibleSemanticSearchBooks). Lives here (not the controller) for the
     * same reason as buildNodeSearchQuery: `php artisan search:profile`
     * EXPLAINs the exact production query.
     *
     * Shape notes:
     * - Runs on the search connection (BYPASSRLS): pgvector's distance
     *   operators are not LEAKPROOF, so under RLS the planner refuses the
     *   HNSW ordered scan (see EmbeddingService::searchConnection). The
     *   book-set filter below is the ONLY access guard.
     * - `hits` is a MATERIALIZED CTE over nodes ONLY with the ordered scan +
     *   LIMIT inside the fence — the same trick as buildNodeSearchQuery, and
     *   for the same measured reason: joined to library in one query, the
     *   planner drives from library and brute-force sorts EVERY visible
     *   node's distance (no HNSW; ~425ms on a 165k-node dev DB, seconds at
     *   prod scale). Fenced, the CTE is the canonical HNSW shape.
     * - Visibility MUST be a nodes-local filter (book = ANY(visible set))
     *   INSIDE the scan, not a post-scan join, and the CALLER MUST run this
     *   with `SET LOCAL hnsw.iterative_scan = relaxed_order` (in a
     *   transaction — see SearchController::searchSemantic). Measured failure
     *   ("marxism" on the dev DB): with post-scan filtering, the top
     *   candidates were ALL nodes of five private copies of one relevant
     *   book, every candidate died at the visibility join, and the search
     *   returned zero rows despite visible matches existing. Filtering inside
     *   the iterative scan streams until the cap is filled with VISIBLE rows.
     * - No distance predicate in the CTE WHERE — that would force pgvector
     *   post-filtering; the caller applies the max-distance cutoff in PHP.
     * - Sub-books are excluded (via the book set, matching
     *   EmbeddingService::searchSimilar): highlight/footnote fragments are
     *   short and embed weakly. NOTE this is an asymmetry with full-text
     *   search, which includes them.
     *
     * @param array $queryEmbedding 768-dim query vector
     * @param string[] $visibleBooks from getVisibleSemanticSearchBooks
     * @return array{0: string, 1: array} [sql, params]
     */
    public function buildSemanticNodeSearchQuery(
        array $queryEmbedding,
        int $limit,
        array $visibleBooks,
    ): array {
        $vectorStr = '[' . implode(',', $queryEmbedding) . ']';
        $booksArrayLiteral = '{' . implode(',', array_map(
            fn (string $b) => '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $b) . '"',
            $visibleBooks,
        )) . '}';
        $candidateCap = max($limit * 3, 60);

        $sql = "
            WITH hits AS MATERIALIZED (
                SELECT
                    nodes.book,
                    nodes.node_id,
                    nodes.\"startLine\",
                    LEFT(COALESCE(nodes.\"plainText\", ''), 300) AS excerpt,
                    (nodes.embedding <=> ?::halfvec) AS distance
                FROM nodes
                WHERE nodes.embedding IS NOT NULL
                    AND nodes.book = ANY(?::text[])
                    AND nodes.book NOT IN ('most-recent', 'most-connected', 'most-lit')
                ORDER BY nodes.embedding <=> ?::halfvec
                LIMIT {$candidateCap}
            )
            SELECT
                hits.book,
                hits.node_id,
                hits.\"startLine\",
                hits.excerpt,
                hits.distance,
                library.title,
                library.author
            FROM hits
            JOIN library ON hits.book = library.book
            ORDER BY hits.distance
            LIMIT ?
        ";

        $params = [$vectorStr, $booksArrayLiteral, $vectorStr, $limit];

        return [$sql, $params];
    }

    /**
     * Execute the semantic node search end-to-end for a pre-computed query
     * vector and book set: run the builder's SQL with iterative scan enabled,
     * apply the distance cutoff, and shape rows for the search UIs. Shared by
     * the homepage endpoint (global visible set) and the journal/shelf
     * endpoint (shelf's public members) so cutoff/match semantics can't drift.
     *
     * `match` is the user-facing floor-rescaled percentage; `similarity` is
     * the raw cosine (see the config comments on semantic_match_floor).
     *
     * @param string[] $books the visibility scope — the ONLY access guard
     * @return \Illuminate\Support\Collection<int, array>
     */
    public function runSemanticNodeSearch(array $queryEmbedding, int $limit, array $books)
    {
        [$sql, $params] = $this->buildSemanticNodeSearchQuery($queryEmbedding, $limit, $books);

        // iterative_scan (pgvector ≥0.8) is REQUIRED for correctness, not a
        // tuning knob: without it the HNSW scan emits at most hnsw.ef_search
        // (40) tuples, so a query whose nearest raw neighbours are dominated
        // by out-of-scope nodes under-fills — see buildSemanticNodeSearchQuery.
        // relaxed_order is fine (the outer query re-orders by distance);
        // SET LOCAL needs the transaction.
        $conn = DB::connection(config('database.search_read_connection'));
        $rows = $conn->transaction(function () use ($conn, $sql, $params) {
            $conn->statement('SET LOCAL hnsw.iterative_scan = relaxed_order');
            return $conn->select($sql, $params);
        });

        // Distance cutoff applied here, not in SQL, to keep the HNSW ordered
        // scan clean. Match% = floor-only rescale: zero point at the measured
        // cosine noise floor, top unclamped (identical = a true 100).
        $maxDistance = (float) config('services.llm.semantic_max_distance');
        $matchFloor = min((float) config('services.llm.semantic_match_floor'), 0.99);

        return collect($rows)
            ->filter(fn ($r) => (float) $r->distance <= $maxDistance)
            ->map(function ($r) use ($matchFloor) {
                $sim = 1 - (float) $r->distance;
                return [
                    'book' => $r->book,
                    'node_id' => $r->node_id,
                    'startLine' => $r->startLine,
                    'title' => $r->title,
                    'author' => $r->author,
                    'excerpt' => $r->excerpt,
                    'similarity' => round($sim, 3),
                    'match' => (int) round(max(0, ($sim - $matchFloor) / (1 - $matchFloor)) * 100),
                ];
            })->values();
    }

    /**
     * THE single definition of "rank ONE book's nodes by meaning" — the
     * reader's in-book semantic search and the citation reviewer's semantic
     * fallback (PassageSearcher::semanticSearchByVector) both assemble their
     * SQL here. Static for the same reason as nodeTsExpression: pure string
     * assembly, no state, callable from a phase class with no DI.
     *
     * Shape notes — deliberately NOT buildSemanticNodeSearchQuery's shape:
     * - NO MATERIALIZED CTE fence and NO visible-book array. The homepage fence
     *   exists to FORCE the HNSW scan (joined to `library` the planner drives
     *   from library and brute-forces every visible node's distance, ~425ms on
     *   a 165k-node dev DB). Here there is no join to confuse it: with
     *   `book = ?` alone the planner picks idx_nodes_embedding on its own.
     * - 🔑 `SET LOCAL hnsw.iterative_scan = relaxed_order` in the caller is
     *   therefore LOAD-BEARING, not a belt (see runBookScopedSemanticSearch).
     *   MEASURED on the dev DB's largest book (`capital`, 5243 embedded nodes
     *   of ~165k): the plan is `Index Scan using idx_nodes_embedding` with
     *   `Rows Removed by Filter: 92` — i.e. the scan streams past out-of-book
     *   tuples until the LIMIT fills with this book's. A single-book filter is
     *   the selective case HNSW handles worst, so without iterative scan it
     *   would emit at most ef_search (40) tuples and silently UNDER-FILL.
     *   The scary case is the opposite of the big book — a TINY one in a large
     *   corpus, where almost every global neighbour is out of scope. Measured:
     *   an 8-node book among 726k embedded nodes, probed with a vector taken
     *   from a DIFFERENT book (so the whole neighbourhood is out of scope),
     *   still returns all 8 rows in ~2ms. That is the harvested-web-stub shape,
     *   and it holds.
     * - The ranking is consequently APPROXIMATE, and that is the deliberate
     *   trade. The exact alternative (book rows in a MATERIALIZED CTE, sorted
     *   outside the fence) was measured against this one: 52ms vs 13.6ms for
     *   top-20, agreeing on 19 of 20 hits but not their order — and the exact
     *   scan's cost grows linearly with book length, so a 20k-node monograph
     *   would push a find-bar keystroke past 200ms. 4× the latency on every
     *   keystroke is not worth one swapped result in twenty. Do not "fix" this
     *   by adding a fence without re-measuring.
     * - Sub-books are not excluded here the way they are in the homepage
     *   builder: `book = ?` is an exact match, so a sub-book's nodes can only
     *   appear if the sub-book IS the requested book — which
     *   bookSemanticallySearchable already refuses.
     * - chunk_id is selected because the reader's search toolbar needs it to
     *   decide whether a hit's chunk is already lazy-loaded.
     * - NO distance predicate in the WHERE: that would force pgvector
     *   post-filtering. Callers apply their own similarity floor afterwards.
     * - `distance` is returned raw, not as `1 - distance`; a caller wanting a
     *   similarity converts it (cheaper to read than two conventions in one
     *   codebase).
     *
     * @param array $queryEmbedding 768-dim query vector
     * @param bool $withContent also select `content` — the citation reviewer
     *        needs the node HTML; the reader UI only needs plainText
     * @return array{0: string, 1: array} [sql, params]
     */
    public static function buildBookScopedSemanticQuery(
        string $book,
        array $queryEmbedding,
        int $limit,
        bool $withContent = false,
    ): array {
        $vectorStr = '[' . implode(',', $queryEmbedding) . ']';
        $contentColumn = $withContent ? "nodes.content,\n                " : '';

        $sql = "
            SELECT
                nodes.node_id,
                nodes.\"startLine\",
                nodes.chunk_id,
                nodes.\"plainText\",
                {$contentColumn}(nodes.embedding <=> ?::halfvec) AS distance
            FROM nodes
            WHERE nodes.book = ?
                AND nodes.embedding IS NOT NULL
            ORDER BY nodes.embedding <=> ?::halfvec
            LIMIT ?
        ";

        return [$sql, [$vectorStr, $book, $vectorStr, $limit]];
    }

    /**
     * Execute the reader's in-book semantic search end-to-end: rank one book's
     * nodes, drop the clearly-unrelated tail, and shape rows for the search
     * toolbar. Lives here (not the controller) for the same reason as the
     * homepage runner — one place for the cutoff/match semantics.
     *
     * 🔑 IN-BOOK CALIBRATION IS ITS OWN THING. Do NOT reuse
     * services.llm.semantic_max_distance / semantic_match_floor here: cosine's
     * noise floor is far higher WITHIN one document than across the corpus.
     * Measured on chacko c128 (see PassageSearcher::MIN_SEMANTIC_SIMILARITY),
     * the passage that PROVED the citation scored 0.73 while unrelated
     * paragraphs OF THE SAME DOCUMENT sat at ~0.67. The homepage floor (0.55)
     * would badge those unrelated paragraphs at ~27%, and the homepage cutoff
     * (0.6 distance = 0.4 similarity) would admit literally every node in the
     * book. As there, the ORDERING does the real work; the floor only guards
     * against degenerate matches.
     *
     * @return \Illuminate\Support\Collection<int, array>
     */
    public function runBookScopedSemanticSearch(string $book, array $queryEmbedding, int $limit)
    {
        [$sql, $params] = self::buildBookScopedSemanticQuery($book, $queryEmbedding, $limit);

        // iterative_scan is REQUIRED, not tuning: the planner takes
        // idx_nodes_embedding for this shape (measured — see the builder), and a
        // one-book filter is exactly the selective case a plain HNSW scan
        // under-fills, capping out at ef_search tuples before the LIMIT is met.
        // SET LOCAL needs the transaction.
        $conn = $this->searchConnection();
        $rows = $conn->transaction(function () use ($conn, $sql, $params) {
            $conn->statement('SET LOCAL hnsw.iterative_scan = relaxed_order');
            return $conn->select($sql, $params);
        });

        $minSimilarity = (float) config('services.llm.semantic_in_book_min_similarity');
        $matchFloor = min((float) config('services.llm.semantic_in_book_match_floor'), 0.99);

        return collect($rows)
            ->map(fn ($r) => [$r, 1 - (float) $r->distance])
            ->filter(fn (array $hit) => $hit[1] >= $minSimilarity)
            ->map(function (array $hit) use ($matchFloor) {
                [$r, $sim] = $hit;

                return [
                    'node_id' => $r->node_id,
                    'startLine' => $r->startLine,
                    'chunk_id' => $r->chunk_id,
                    'excerpt' => mb_substr((string) ($r->plainText ?? ''), 0, 300),
                    'similarity' => round($sim, 3),
                    'match' => (int) round(max(0, ($sim - $matchFloor) / (1 - $matchFloor)) * 100),
                ];
            })->values();
    }

    /**
     * How far along is this book's embedding backfill?
     *
     * The in-book query filters `embedding IS NOT NULL`, so a book whose
     * embeddings lane hasn't drained yet returns an EMPTY success — which the
     * find bar would render as "0 of 0", indistinguishable from "no matches".
     * This counts the same node population the jobs embed (the ONE shared
     * definition — EmbeddingEligibility::nodeSql), so "pending = 0" and "the
     * queue is done" can never drift apart.
     *
     * @return array{embedded:int, eligible:int, pending:int}
     */
    public function bookEmbeddingProgress(string $book): array
    {
        $row = $this->searchConnection()->selectOne(
            'SELECT COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
                    COUNT(*) AS eligible
             FROM nodes
             WHERE book = ? AND ' . EmbeddingEligibility::nodeSql('nodes'),
            [$book],
        );

        $embedded = (int) ($row->embedded ?? 0);
        $eligible = (int) ($row->eligible ?? 0);

        return [
            'embedded' => $embedded,
            'eligible' => $eligible,
            'pending' => max(0, $eligible - $embedded),
        ];
    }

    /**
     * May this requester run an in-book semantic search over $book?
     *
     * 🔒 Deliberately NOT App\Services\BookAccess::canAccessBookContent(): that
     * reads `library` on the DEFAULT (RLS-enforced) connection, so another
     * user's private book arrives as NO ROW and it returns true ("legacy or
     * public content"). Harmless where RLS still guards the data underneath —
     * but this search runs on the BYPASSRLS connection, where that default
     * would hand back the book's node text. Fetching the row on the search
     * connection closes the hole: an RLS-invisible row is a PRESENT row we can
     * actually judge.
     *
     * Also deliberately NOT nodeVisibilityClause(): that requires
     * `listed = true`, which answers the HOMEPAGE-FEED question. Harvested
     * journal articles are minted unlisted and the reader is looking at one —
     * "may I read this book" is the right question here, so this mirrors
     * BookAccess's contract (public, or mine by name or anon token) exactly.
     *
     * EmbeddingEligibility is the other half: a book whose nodes are never
     * embedded (sub-book, E2EE, deleted, system feed book, generated card
     * list) can only ever return an empty result, so it is refused up front
     * instead of costing an embedding round-trip to prove it.
     */
    public function bookSemanticallySearchable(string $book, ?string $creatorName, ?string $anonToken): bool
    {
        $row = $this->searchConnection()->selectOne(
            'SELECT book, type, encrypted, visibility, creator, creator_token, raw_json
             FROM library WHERE book = ? LIMIT 1',
            [$book],
        );

        if (!$row || !EmbeddingEligibility::bookEligible($row, $book)) {
            return false;
        }

        if (($row->visibility ?? '') === 'public') {
            return true;
        }

        if ($creatorName && $row->creator === $creatorName) {
            return true;
        }

        return (bool) ($anonToken
            && $row->creator_token
            && hash_equals((string) $row->creator_token, (string) $anonToken));
    }

    /**
     * Scope clause for the canonical branch of searchForCitations.
     * Returns [whereClause, params].
     *
     *   public: no extra restriction — canonical metadata is intentionally global
     *   mine: canonical must have at least one linked library row owned by the caller
     *         (also drops canonical-only results — they're not "yours")
     *   shelf: canonical must have at least one linked library row IN the shelf
     *          (drops canonical-only — they have no version that could be shelved)
     *
     * Without this, a 2-book shelf could surface 50 unrelated canonical results
     * from the global metadata pool — the leak the user hit.
     */
    private function buildCanonicalScopeClauseForCitations(string $sourceScope, ?string $creatorName, ?string $shelfId): array
    {
        if ($sourceScope === 'shelf' && $shelfId) {
            // Shelves are explicit user curation — they picked the exact versions
            // they want available. Don't muddy that with canonical hops; the
            // library branch surfaces every shelf member directly.
            return ["FALSE", []];
        }
        if ($sourceScope === 'mine' && $creatorName) {
            return [
                "EXISTS (
                    SELECT 1 FROM library l_inner
                    WHERE l_inner.canonical_source_id = c.id
                      AND l_inner.creator = ?
                      AND l_inner.visibility != 'deleted'
                )",
                [$creatorName],
            ];
        }
        // public — no restriction
        return ["TRUE", []];
    }

    /**
     * Citation-search scope clauses. Returns [whereClause, whereParams,
     * joinClause, joinParams] for placement in the orphan-library branch.
     *
     * NB: this is INTENTIONALLY laxer than searchLibraryByKeyword's privacy
     * contract. Citation is about attribution — a user must be able to cite
     * their OWN private books from their own writing. The read-side privacy
     * check (whether someone else can navigate to that source) is enforced
     * at click-time in displayCitations.js + CanonicalSourceController, not
     * at search time. AiBrain retrieval is the opposite (privacy first; see
     * RetrievalScopeTest) — do not unify these without thinking through the
     * threat model.
     */
    private function buildLibraryScopeClauseForCitations(string $sourceScope, ?string $creatorName, ?string $shelfId): array
    {
        if ($sourceScope === 'shelf' && $shelfId) {
            // Public books in the shelf, PLUS the caller's own non-deleted
            // private books they've curated into the shelf.
            $where = $creatorName
                ? "(l.visibility = 'public' OR (l.creator = ? AND l.visibility != 'deleted'))"
                : "l.visibility = 'public'";
            $params = $creatorName ? [$creatorName] : [];
            return [
                $where,
                $params,
                "INNER JOIN shelf_items si ON si.book = l.book AND si.shelf_id = ?",
                [$shelfId],
            ];
        }
        if ($sourceScope === 'mine' && $creatorName) {
            // All the caller's non-deleted books — public AND private. The
            // citation marker can point at a private book; navigation to it
            // is gated separately at click time.
            return [
                "(l.creator = ? AND l.visibility != 'deleted')",
                [$creatorName],
                "",
                [],
            ];
        }
        return [
            "(l.visibility = 'public' AND l.listed = true)",
            [],
            "",
            [],
        ];
    }

    private function buildSyntheticBibtex(\stdClass $row): string
    {
        $sanitize = fn($s) => str_replace(['{', '}'], '', (string) $s);
        // Flat author strings are "; "-joined; the bibtex field uses " and "
        // (this string feeds the citation picker's parseAuthorYear directly).
        $author = \App\Support\AuthorList::toBibtexField($sanitize($row->author ?? 'Unknown'));
        $year   = $sanitize($row->year ?? 'n.d.');
        $title  = $sanitize($row->title ?? 'Untitled');
        $key    = 'cite_' . substr(md5((string) ($row->id ?? '')), 0, 8);
        return "@misc{{$key}, author = {{$author}}, year = {{$year}}, title = {{$title}}}";
    }
}
