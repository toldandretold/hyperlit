<?php

namespace App\Services\Connections;

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\BestVersionService;
use Illuminate\Support\Facades\DB;

/**
 * "How wired into the docuverse is this text" — the aggregate the Most
 * Connected / Most Lit feeds rank on, and the writer of the three library
 * columns they read (`hypercite_connections`, `reference_connections`,
 * `total_highlights`).
 *
 * TWO FAMILIES OF EDGE, both counted in both directions:
 *
 *  - HYPERCITE edges — minted links. There is one `hypercites` row per edge and
 *    it lives on the CITED book: `hypercites.book` is the quoted text and each
 *    `citedIN` entry is a "/{citingBook}#{anchor}" string. The citing book holds
 *    only an <a class="open-icon">↗</a> in its node HTML, so OUTBOUND links are
 *    invisible unless you expand `citedIN` — which is why the old
 *    `library.total_citations` scored a text that cites a hundred others at zero.
 *  - REFERENCE edges — a bibliography/footnote reference resolving to a book
 *    actually held here. Real docuverse links that simply have not been minted
 *    into hypercites yet. Populated by `citation:scan-bibliography`, which
 *    `journal:harvest` never runs but the hypercite console's detect run does on
 *    demand (CandidateDetector), so coverage grows with maintainer work.
 *
 * COUNTING RULES (all applied to both families):
 *
 *  - DISTINCT counterpart texts, not raw edges. Being quoted five times by one
 *    book is one connection — otherwise bulk-quoting one text inflates a score.
 *  - INBOUND counts double (INBOUND_WEIGHT). Outbound is something you control;
 *    inbound is something others chose to do.
 *  - Both endpoints must be PUBLIC and content-bearing (`has_nodes`). An edge to
 *    a private or empty book is not a connection to the shared docuverse, and
 *    admitting them would let a pile of junk private books inflate a ranking.
 *  - SELF-LOOPS excluded, and SAME-OWNER edges excluded — two books with the
 *    same real creator (or the same anonymous creator_token) do not connect each
 *    other. The pre-existing self-citation check only caught a book citing
 *    ITSELF, so a user ring-citing their own books scored in full; `library.listed`
 *    defaults to TRUE, so those books reach the homepage ranking with no review.
 *    Harvested articles all share AutoVersionResolver::CREATOR and are treated as
 *    owner-less commons books, so they are exempt and journal↔journal edges count.
 *  - SUB-BOOK ROLLUP: a `book_X/Fn123` endpoint credits its parent `book_X`.
 *    Rollup happens BEFORE the self/owner filters, so a parent citing its own
 *    footnote is a self-loop and drops out.
 *  - `foundation_source = 'unknown'` is the scan's UNRESOLVED sentinel, not a
 *    target — `IS NOT NULL` alone overcounts.
 *
 * A pair that is both a minted hypercite AND a resolved reference counts once in
 * each family. That is deliberate: the two scores are separate columns and the
 * feed tiers on hypercites first, so there is no double-count within a tier.
 */
class ConnectionCountQuery
{
    /** Being cited is worth more than citing: it is the one direction you cannot self-inflate. */
    public const INBOUND_WEIGHT = 2;

    public const OUTBOUND_WEIGHT = 1;

    /** The scan's "tried and failed to resolve" sentinel — never a real target. */
    private const UNRESOLVED = 'unknown';

    /**
     * Raw directional components per book, for the books that have any edge.
     * Books with no edges are simply absent — callers wanting a dense map
     * should COALESCE to zero (recompute() does this in SQL).
     *
     * @param  ?string[]  $books  Restrict to these root book ids; null = whole corpus.
     * @return array<string, array{hc_in:int, hc_out:int, ref_in:int, ref_out:int, hypercite:int, reference:int}>
     */
    public function forBooks(?array $books = null): array
    {
        if ($books !== null && $books === []) {
            return [];
        }

        [$sql, $bindings] = $this->aggregateSql($books);

        $rows = DB::connection('pgsql_admin')->select($sql, $bindings);

        $out = [];
        foreach ($rows as $r) {
            $out[$r->book] = [
                'hc_in'     => (int) $r->hc_in,
                'hc_out'    => (int) $r->hc_out,
                'ref_in'    => (int) $r->ref_in,
                'ref_out'   => (int) $r->ref_out,
                'hypercite' => self::score((int) $r->hc_in, (int) $r->hc_out),
                'reference' => self::score((int) $r->ref_in, (int) $r->ref_out),
            ];
        }

        return $out;
    }

    /** The weighted score for one family's in/out counts. */
    public static function score(int $inbound, int $outbound): int
    {
        return self::INBOUND_WEIGHT * $inbound + self::OUTBOUND_WEIGHT * $outbound;
    }

    /**
     * "Most Connected" order for a collection of library rows carrying
     * hypercite_connections / reference_connections / created_at.
     *
     * Minted hypercite edges first, not-yet-minted reference edges second, so
     * any text with a hypercite outranks every text without one. Stable sorts
     * applied in REVERSE key order (the idiom the `published` sort uses) —
     * PHP 8's arsort is stable, so the last sort applied is the primary key.
     * created_at is the final tiebreaker: without it, equal-scoring books came
     * back in whatever arbitrary order the join produced, which is what made
     * the feed look randomly shuffled.
     *
     * @template T of \Illuminate\Support\Collection
     *
     * @param  T  $items
     * @return T
     */
    public static function sortConnected($items)
    {
        return $items->sortByDesc('created_at')
            ->sortByDesc(fn ($i) => (int) ($i->reference_connections ?? 0))
            ->sortByDesc(fn ($i) => (int) ($i->hypercite_connections ?? 0));
    }

    /**
     * "Most Lit" order: human annotation activity — hypercite edges plus
     * hyperlights. Machine-detected reference edges are deliberately excluded,
     * so this ranks differently from sortConnected() rather than shadowing it.
     *
     * @template T of \Illuminate\Support\Collection
     *
     * @param  T  $items
     * @return T
     */
    public static function sortLit($items)
    {
        return $items->sortByDesc('created_at')
            ->sortByDesc(fn ($i) => (int) ($i->hypercite_connections ?? 0) + (int) ($i->total_highlights ?? 0));
    }

    /**
     * Recompute and PERSIST the three ranking columns. Set-based: one statement
     * for the connection pair and one for the highlight count, whatever the
     * corpus size — this runs inline on a homepage cache miss, so it must never
     * become a per-book loop.
     *
     * Deliberately NOT filtered by `listed`: the harvested journal corpus is
     * minted `listed = false`, and it was that filter on the old recompute that
     * left every journal article's count NULL forever. Which books the HOMEPAGE
     * ranks is a separate decision, made where the homepage selects its records.
     *
     * @param  ?string[]  $books  Restrict to these root book ids; null = whole corpus.
     * @return int Rows whose values actually changed.
     */
    public function recompute(?array $books = null): int
    {
        if ($books !== null) {
            $books = array_values(array_unique(array_map(self::rootBook(...), $books)));
            if ($books === []) {
                return 0;
            }
        }

        return $this->writeConnections($books) + $this->writeHighlights($books);
    }

    /**
     * Just the hyperlight half of the recompute — for the highlight write path,
     * which is high-frequency (every save) and cannot change a connection
     * count. A GROUP BY over `hyperlights`; it does NOT touch hypercites or
     * bibliography, so it is cheap enough to run per save.
     *
     * @param  ?string[]  $books
     */
    public function recomputeHighlights(?array $books = null): int
    {
        if ($books !== null) {
            $books = array_values(array_unique(array_map(self::rootBook(...), $books)));
            if ($books === []) {
                return 0;
            }
        }

        return $this->writeHighlights($books);
    }

    /**
     * The parent book id an edge endpoint credits: `book_X/Fn12` → `book_X`.
     * The SQL does this with split_part; PHP callers recomputing after a write
     * need the same normalisation before passing ids in.
     */
    public static function rootBook(string $book): string
    {
        return explode('/', $book, 2)[0];
    }

    // ── internals ────────────────────────────────────────────────────────────

    private function writeConnections(?array $books): int
    {
        [$cte, $bindings] = $this->edgeCte($books);

        $scope = '';
        if ($books !== null) {
            $scope = ' AND l2.book IN (' . $this->placeholders($books) . ')';
            $bindings = array_merge($bindings, $books);
        }

        $in  = self::INBOUND_WEIGHT;
        $out = self::OUTBOUND_WEIGHT;

        // Sub-books never carry their own score (their edges credit the parent),
        // and `visibility = 'deleted'` rows are corpses. Everything else gets a
        // number, including books with no edges at all — COALESCE turns "absent
        // from the aggregate" into a genuine 0, distinguishable from a NULL that
        // means "never computed".
        $sql = <<<SQL
            {$cte},
            agg AS (
                SELECT
                    book,
                    COUNT(DISTINCT counterpart) FILTER (WHERE kind = 'hypercite' AND dir = 'in')  AS hc_in,
                    COUNT(DISTINCT counterpart) FILTER (WHERE kind = 'hypercite' AND dir = 'out') AS hc_out,
                    COUNT(DISTINCT counterpart) FILTER (WHERE kind = 'reference' AND dir = 'in')  AS ref_in,
                    COUNT(DISTINCT counterpart) FILTER (WHERE kind = 'reference' AND dir = 'out') AS ref_out
                FROM directed
                GROUP BY book
            ),
            target AS (
                SELECT
                    l2.book,
                    ({$in} * COALESCE(a.hc_in, 0)  + {$out} * COALESCE(a.hc_out, 0))  AS hypercite_connections,
                    ({$in} * COALESCE(a.ref_in, 0) + {$out} * COALESCE(a.ref_out, 0)) AS reference_connections
                FROM library l2
                LEFT JOIN agg a ON a.book = l2.book
                WHERE l2.book NOT LIKE '%/%'
                  AND COALESCE(l2.visibility, 'public') <> 'deleted'
                  {$scope}
            )
            UPDATE library l
            SET hypercite_connections = t.hypercite_connections,
                reference_connections = t.reference_connections
            FROM target t
            WHERE l.book = t.book
              AND (l.hypercite_connections IS DISTINCT FROM t.hypercite_connections
                   OR l.reference_connections IS DISTINCT FROM t.reference_connections)
        SQL;

        // The IS DISTINCT FROM guard is not an optimisation flourish: without it
        // the 15-minute job rewrites every library row forever, churning dead
        // tuples for no change.
        return DB::connection('pgsql_admin')->update($sql, $bindings);
    }

    private function writeHighlights(?array $books): int
    {
        $bindings = [];
        $scope = '';
        if ($books !== null) {
            $scope = ' AND l2.book IN (' . $this->placeholders($books) . ')';
            $bindings = $books;
        }

        $sql = <<<SQL
            WITH counted AS (
                SELECT split_part(book, '/', 1) AS book, COUNT(*) AS n
                FROM hyperlights
                GROUP BY split_part(book, '/', 1)
            ),
            target AS (
                SELECT l2.book, COALESCE(c.n, 0)::int AS total_highlights
                FROM library l2
                LEFT JOIN counted c ON c.book = l2.book
                WHERE l2.book NOT LIKE '%/%'
                  AND COALESCE(l2.visibility, 'public') <> 'deleted'
                  {$scope}
            )
            UPDATE library l
            SET total_highlights = t.total_highlights
            FROM target t
            WHERE l.book = t.book
              AND l.total_highlights IS DISTINCT FROM t.total_highlights
        SQL;

        return DB::connection('pgsql_admin')->update($sql, $bindings);
    }

    /**
     * The shared `WITH … directed` chain: every qualifying edge, rolled up,
     * filtered, and exploded into one row per (book, direction).
     *
     * @return array{0:string, 1:array<int, mixed>}
     */
    private function edgeCte(?array $books): array
    {
        $bestVersion = BestVersionService::sqlCoalesceExpression('cs');
        $bindings = [];

        // Prune early when scoped: an edge can only affect a book it touches.
        $prune = '';
        if ($books !== null) {
            $ph = $this->placeholders($books);
            $prune = " AND (e.citing_book IN ({$ph}) OR e.cited_book IN ({$ph}))";
            $bindings = array_merge($books, $books);
        }

        $unresolved = self::UNRESOLVED;
        $systemCreator = AutoVersionResolver::CREATOR;

        $sql = <<<SQL
            WITH hypercite_edges AS (
                -- citedIN entries are "/{citingBook}#{anchor}"; the CASE keeps a
                -- malformed/null value from erroring the whole set expansion.
                SELECT
                    split_part(h.book, '/', 1) AS cited_book,
                    split_part(split_part(ltrim(e.val, '/'), '#', 1), '/', 1) AS citing_book
                FROM hypercites h
                CROSS JOIN LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(h."citedIN") = 'array' THEN h."citedIN" ELSE '[]'::jsonb END
                ) AS e(val)
            ),
            reference_edges AS (
                SELECT split_part(b.book, '/', 1) AS citing_book,
                       split_part(lt.book, '/', 1) AS cited_book
                FROM bibliography b
                JOIN canonical_source cs ON cs.id = b.canonical_source_id
                JOIN library lt ON lt.book = ({$bestVersion})
                WHERE b.canonical_source_id IS NOT NULL
                UNION
                SELECT split_part(b.book, '/', 1), split_part(lt.book, '/', 1)
                FROM bibliography b
                JOIN library lt ON lt.book = b.foundation_source
                WHERE b.foundation_source IS NOT NULL
                  AND b.foundation_source <> '{$unresolved}'
                UNION
                SELECT split_part(f.book, '/', 1), split_part(lt.book, '/', 1)
                FROM footnotes f
                JOIN library lt ON lt.book = f.foundation_source
                WHERE f.is_citation = true
                  AND f.foundation_source IS NOT NULL
                  AND f.foundation_source <> '{$unresolved}'
            ),
            all_edges AS (
                SELECT 'hypercite'::text AS kind, citing_book, cited_book FROM hypercite_edges
                UNION
                SELECT 'reference'::text, citing_book, cited_book FROM reference_edges
            ),
            edges AS (
                SELECT e.kind, e.citing_book, e.cited_book
                FROM all_edges e
                JOIN library ls ON ls.book = e.citing_book
                JOIN library lt ON lt.book = e.cited_book
                WHERE e.citing_book <> e.cited_book
                  AND e.citing_book <> ''
                  AND e.cited_book <> ''
                  AND ls.has_nodes = true AND ls.visibility = 'public'
                  AND lt.has_nodes = true AND lt.visibility = 'public'
                  AND NOT (
                      (ls.creator IS NOT NULL
                       AND ls.creator = lt.creator
                       AND ls.creator <> '{$systemCreator}')
                      OR (ls.creator_token IS NOT NULL AND ls.creator_token = lt.creator_token)
                  )
                  {$prune}
            ),
            directed AS (
                SELECT cited_book  AS book, kind, 'in'::text  AS dir, citing_book AS counterpart FROM edges
                UNION ALL
                SELECT citing_book AS book, kind, 'out'::text AS dir, cited_book  AS counterpart FROM edges
            )
        SQL;

        return [$sql, $bindings];
    }

    /** @return array{0:string, 1:array<int, mixed>} */
    private function aggregateSql(?array $books): array
    {
        [$cte, $bindings] = $this->edgeCte($books);

        $scope = '';
        if ($books !== null) {
            $scope = ' WHERE book IN (' . $this->placeholders($books) . ')';
            $bindings = array_merge($bindings, $books);
        }

        $sql = <<<SQL
            {$cte}
            SELECT
                book,
                COUNT(DISTINCT counterpart) FILTER (WHERE kind = 'hypercite' AND dir = 'in')  AS hc_in,
                COUNT(DISTINCT counterpart) FILTER (WHERE kind = 'hypercite' AND dir = 'out') AS hc_out,
                COUNT(DISTINCT counterpart) FILTER (WHERE kind = 'reference' AND dir = 'in')  AS ref_in,
                COUNT(DISTINCT counterpart) FILTER (WHERE kind = 'reference' AND dir = 'out') AS ref_out
            FROM directed
            {$scope}
            GROUP BY book
        SQL;

        return [$sql, $bindings];
    }

    /** @param  array<int, string>  $values */
    private function placeholders(array $values): string
    {
        return implode(', ', array_fill(0, max(1, count($values)), '?'));
    }
}
