<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

class SearchService
{
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
        $simpleCount = DB::selectOne("
            SELECT COUNT(*) as cnt FROM (
                SELECT 1 FROM nodes
                WHERE search_vector_simple @@ to_tsquery('simple', ?)
                AND book NOT IN ('most-recent', 'most-connected', 'most-lit')
                LIMIT 101
            ) sub
        ", [$tsQuery]);

        if (($simpleCount->cnt ?? 0) > 0) {
            $config = 'simple';
            $vectorColumn = 'search_vector_simple';
        } else {
            $config = 'english';
            $vectorColumn = 'search_vector';
        }

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
            $shelfJoin = 'JOIN shelf_items ON shelf_items.book = nodes.book AND shelf_items.shelf_id = ?';
            $shelfParams = [$shelfId];
        }

        $excludeClause = '';
        $excludeParams = [];
        if ($excludeBook) {
            $excludeClause = 'AND nodes.book != ?';
            $excludeParams = [$excludeBook];
        }

        $orderClause = $tsOperator === '|'
            ? "ORDER BY ts_rank(nodes.{$vectorColumn}, to_tsquery('{$config}', ?)) DESC"
            : "ORDER BY library.created_at DESC";
        $rankParams = $tsOperator === '|' ? [$tsQuery] : [];

        $sql = "
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
                    nodes.id,
                    nodes.book,
                    nodes.node_id,
                    nodes.\"plainText\",
                    nodes.content,
                    library.title,
                    library.author,
                    library.year,
                    library.bibtex,
                    COALESCE(nodes.\"plainText\", nodes.content, '') as text_content
                FROM nodes
                JOIN library ON nodes.book = library.book
                {$shelfJoin}
                WHERE nodes.{$vectorColumn} @@ to_tsquery('{$config}', ?)
                    AND nodes.book NOT IN ('most-recent', 'most-connected', 'most-lit')
                    AND library.type != 'sub_book'
                    AND {$visibilityClause}
                    {$excludeClause}
                {$orderClause}
                LIMIT ?
            ) sub
        ";

        $params = array_merge(
            [$tsQuery],
            $shelfParams,
            [$tsQuery],
            $visibilityParams,
            $excludeParams,
            $rankParams,
            [$limit]
        );

        $results = DB::select($sql, $params);

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
        ?string $shelfId = null
    ): array {
        $tsQuery = $this->buildTsQuery($query);

        if (empty($tsQuery)) {
            return [];
        }

        $dbQuery = DB::table('library')
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
        if ($sourceScope === 'shelf' && $shelfId) {
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
        $sql = "
            SELECT * FROM (
                (
                    SELECT
                        'canonical'::text AS row_type,
                        c.id::text AS id,
                        c.title,
                        c.author,
                        c.year::text AS year,
                        c.journal,
                        NULL::text AS bibtex,
                        COALESCE(
                            c.author_version_book,
                            c.publisher_version_book,
                            c.commons_version_book,
                            c.auto_version_book
                        ) AS best_version_book,
                        (
                            COALESCE(c.author_version_book, c.publisher_version_book, c.commons_version_book, c.auto_version_book) IS NOT NULL
                            OR EXISTS (SELECT 1 FROM library WHERE canonical_source_id = c.id LIMIT 1)
                        ) AS has_version,
                        (lv.visibility = 'private') AS is_private,
                        ts_rank('{0.05, 0.1, 0.3, 1.0}', c.search_vector, to_tsquery('simple', ?)) AS relevance
                    FROM canonical_source c
                    LEFT JOIN library lv ON lv.book = COALESCE(
                        c.author_version_book,
                        c.publisher_version_book,
                        c.commons_version_book,
                        c.auto_version_book
                    )
                    WHERE c.search_vector @@ to_tsquery('simple', ?)
                      AND {$canonScopeSql}
                    ORDER BY relevance DESC
                    LIMIT ?
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

        $rows = DB::select($sql, $params);

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
        $author = $sanitize($row->author ?? 'Unknown');
        $year   = $sanitize($row->year ?? 'n.d.');
        $title  = $sanitize($row->title ?? 'Untitled');
        $key    = 'cite_' . substr(md5((string) ($row->id ?? '')), 0, 8);
        return "@misc{{$key}, author = {{$author}}, year = {{$year}}, title = {{$title}}}";
    }
}
