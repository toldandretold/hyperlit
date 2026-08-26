<?php

namespace App\Services\Hypercites;

use App\Models\JournalSource;
use App\Services\CanonicalVersions\BestVersionService;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * The "which works does this scope cite" aggregate behind the hypercite
 * console's most-cited tab AND the bulk import job — one query so the button's
 * work-list is exactly what the tab shows.
 *
 * The union mirrors HarvestEligibility::reachedCanonicalIdsSubquery's three
 * branches, rooted on every held book of the scope at once and keeping the
 * citing book for the COUNT(DISTINCT). Counts undercount until
 * citation:scan-bibliography has run per book — the detect run does that, so
 * the console nudges "run detection first".
 *
 * A scope is the console's array shape ({type, column, id, ...}) — see
 * HyperciteConsoleController::journalScope() / shelfScope().
 */
class CitedWorksQuery
{
    /** The most-cited tab shows (and the bulk import covers) at most this many works. */
    public const LIMIT = 150;

    /**
     * Cited works for a scope, most-cited first, each row carrying the flags
     * that make it actionable: is_internal / held / is_oa / fetchable /
     * importable.
     *
     * @param array{type:string, column:string, id:string} $scope
     * @return Collection<int, array<string, mixed>>
     */
    public function rows(array $scope, int $limit = self::LIMIT): Collection
    {
        if ($scope['type'] === 'journal') {
            $best = BestVersionService::sqlCoalesceExpression('a');
            $articlesCte = <<<SQL
                SELECT l.book
                FROM canonical_source a
                JOIN library l ON l.book = ({$best})
                WHERE a.journal_source_id = :scope
                  AND l.has_nodes = true
            SQL;
            $internalExpr = '(cs.journal_source_id = :scope2)';
        } else {
            $articlesCte = <<<SQL
                SELECT l.book
                FROM shelf_items si
                JOIN library l ON l.book = si.book
                WHERE si.shelf_id = :scope
                  AND l.has_nodes = true
            SQL;
            $internalExpr = <<<SQL
                EXISTS (
                    SELECT 1 FROM shelf_items si2
                    JOIN library lb ON lb.book = si2.book
                    WHERE si2.shelf_id = :scope2 AND lb.canonical_source_id = cs.id
                )
            SQL;
        }

        $sql = <<<SQL
            WITH articles AS (
                {$articlesCte}
            ),
            cited AS (
                SELECT b.book AS citing_book, b.canonical_source_id AS cited_id
                FROM bibliography b JOIN articles ar ON ar.book = b.book
                WHERE b.canonical_source_id IS NOT NULL
                UNION
                SELECT b.book, l.canonical_source_id
                FROM bibliography b
                JOIN library l ON l.book = b.foundation_source
                JOIN articles ar ON ar.book = b.book
                WHERE l.canonical_source_id IS NOT NULL
                UNION
                SELECT f.book, l.canonical_source_id
                FROM footnotes f
                JOIN library l ON l.book = f.foundation_source
                JOIN articles ar ON ar.book = f.book
                WHERE f.is_citation = true AND l.canonical_source_id IS NOT NULL
            )
            SELECT
                cs.id, cs.title, cs.author, cs.year, cs.journal, cs.doi,
                cs.is_oa, cs.oa_status, cs.pdf_url, cs.oa_url, cs.cited_by_count,
                {$internalExpr} AS is_internal,
                COUNT(DISTINCT c.citing_book) AS citing_count,
                EXISTS (
                    SELECT 1 FROM library lv
                    WHERE lv.canonical_source_id = cs.id
                      AND lv.has_nodes = true AND lv.visibility = 'public'
                ) AS held
            FROM cited c
            JOIN canonical_source cs ON cs.id = c.cited_id
            GROUP BY cs.id
            ORDER BY citing_count DESC, cs.cited_by_count DESC NULLS LAST
            LIMIT {$limit}
        SQL;

        return collect(DB::connection('pgsql_admin')->select($sql, [
            'scope'  => $scope['id'],
            'scope2' => $scope['id'],
        ]))->map(function ($r) {
            $fetchable = (bool) ($r->pdf_url || $r->oa_url || $r->doi);

            return [
                'canonical_id'   => $r->id,
                'title'          => $r->title,
                'author'         => $r->author,
                'year'           => $r->year,
                'journal'        => $r->journal,
                'doi'            => $r->doi,
                'citing_count'   => (int) $r->citing_count,
                'cited_by_count' => $r->cited_by_count,   // OpenAlex world count, context only
                'is_internal'    => (bool) $r->is_internal,
                'held'           => (bool) $r->held,
                'is_oa'          => (bool) $r->is_oa,
                'fetchable'      => $fetchable,
                'importable'     => (bool) ($r->is_oa && $fetchable && ! $r->held),
            ];
        });
    }

    /**
     * The bulk-import work-list: external works that are importable right now
     * (OA, fetchable, not yet held), in citing-count order. `held` flips true
     * as imports land, so a re-run naturally continues down the list.
     *
     * @param array{type:string, column:string, id:string} $scope
     * @return Collection<int, array<string, mixed>>
     */
    public function importableExternal(array $scope): Collection
    {
        return $this->rows($scope)
            ->filter(fn (array $r) => ! $r['is_internal'] && $r['importable'])
            ->values();
    }

    /**
     * Rebuild a queue-safe scope array (+ human label) from a hypercite_runs
     * row — jobs carry only the run id, and the run row carries exactly one of
     * the two scope columns.
     *
     * @return ?array{type:string, column:string, id:string, label:string}
     */
    public static function scopeFromRun(object $run): ?array
    {
        if (! empty($run->journal_source_id)) {
            $journal = JournalSource::find($run->journal_source_id);

            return $journal ? [
                'type'   => 'journal',
                'column' => 'journal_source_id',
                'id'     => $journal->id,
                'label'  => (string) $journal->display_name,
            ] : null;
        }

        if (! empty($run->shelf_id)) {
            $shelf = DB::connection('pgsql_admin')->table('shelves')
                ->where('id', $run->shelf_id)
                ->first(['id', 'name']);

            return $shelf ? [
                'type'   => 'shelf',
                'column' => 'shelf_id',
                'id'     => $shelf->id,
                'label'  => (string) $shelf->name,
            ] : null;
        }

        return null;
    }
}
