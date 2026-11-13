<?php

namespace App\Services\Hypercites;

use App\Services\Licensing\HostingPolicy;
use App\Services\Licensing\WorkLicenseResolver;
use App\Support\Licenses;
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
            // A shelf owner's view (scope['viewer']) is bounded to public books and
            // their own — same rule as DetectionScope::visibleTo(). No viewer = operator.
            $viewer = $scope['viewer'] ?? null;
            $viewerClause = $viewer !== null
                ? "AND (l.visibility = 'public' OR l.creator = :viewer)"
                : '';
            $articlesCte = <<<SQL
                SELECT l.book
                FROM shelf_items si
                JOIN library l ON l.book = si.book
                WHERE si.shelf_id = :scope
                  AND l.has_nodes = true
                  {$viewerClause}
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
                cs.is_oa, cs.oa_status, cs.work_license, cs.pdf_url, cs.oa_url, cs.cited_by_count,
                {$internalExpr} AS is_internal,
                COUNT(DISTINCT c.citing_book) AS citing_count,
                EXISTS (
                    SELECT 1 FROM library lv
                    WHERE lv.canonical_source_id = cs.id
                      AND lv.has_nodes = true AND lv.visibility = 'public'
                ) AS held,
                (
                    SELECT lv.book FROM library lv
                    WHERE lv.canonical_source_id = cs.id
                      AND lv.has_nodes = true AND lv.visibility = 'public'
                    ORDER BY lv.book LIMIT 1
                ) AS held_book
            FROM cited c
            JOIN canonical_source cs ON cs.id = c.cited_id
            GROUP BY cs.id
            ORDER BY citing_count DESC, cs.cited_by_count DESC NULLS LAST
            LIMIT {$limit}
        SQL;

        $bindings = ['scope' => $scope['id'], 'scope2' => $scope['id']];
        if ($scope['type'] !== 'journal' && ($scope['viewer'] ?? null) !== null) {
            $bindings['viewer'] = $scope['viewer'];
        }

        $found = collect(DB::connection('pgsql_admin')->select($sql, $bindings));
        $alsoHeld = $this->heldOutsideTheLink($found, $scope['viewer'] ?? null);

        return $found->map(function ($r) use ($alsoHeld) {
            $fetchable = (bool) ($r->pdf_url || $r->oa_url || $r->doi);
            $heldBook = $r->held_book ?: ($alsoHeld[$r->id] ?? null);
            $held = (bool) $r->held || $heldBook !== null;

            // "Open access" is decided where every other path decides it: the licence
            // (WorkLicenseResolver), then whether that licence lets a copy be hosted
            // (HostingPolicy). OpenAlex's is_oa alone calls a free-to-read, all-rights-
            // reserved page (bronze) open, and offered it for import.
            // No licence AND no status is no evidence either way — Unknown, not "reserved".
            $license = ($r->work_license || $r->oa_status)
                ? WorkLicenseResolver::resolve([$r->work_license], $r->oa_status)['license']
                : Licenses::UNKNOWN;
            $hostable = HostingPolicy::mayPublish((object) ['license' => $license]);

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
                'held'           => $held,
                // Where the row's title links: the copy we hold, else the work itself.
                'held_url'       => $heldBook ? url('/' . $heldBook) : null,
                'source_url'     => $r->doi ? 'https://doi.org/' . $r->doi : ($r->oa_url ?: ($r->pdf_url ?: null)),
                'is_oa'          => (bool) $r->is_oa,
                'oa_status'      => $r->oa_status ?: null,
                'license'        => $license,
                'license_label'  => Licenses::info($license)['label'],
                'hostable'       => $hostable,
                // The open copy OpenAlex lists, so the claim can be checked from the row.
                'oa_copy_url'    => $r->oa_url ?: ($r->pdf_url ?: null),
                'fetchable'      => $fetchable,
                'importable'     => (bool) ($r->is_oa && $fetchable && ! $held && $hostable),
            ];
        });
    }

    /**
     * Copies the canonical-link test misses, by canonical id => book:
     *   - the VIEWER's own copy, public or not (a shelf owner already has the book — the
     *     importer's existingReadableVersion() counts it, so the list must too);
     *   - a readable copy carrying the same DOI but never linked to this citation identity
     *     (an upload whose owner filled in the DOI, or a duplicate canonical row).
     * One query for the whole list. "Readable" = public, or the viewer's own.
     *
     * @param  Collection<int, object>  $rows
     * @return array<string, string>
     */
    private function heldOutsideTheLink(Collection $rows, ?string $viewer): array
    {
        $unheld = $rows->filter(fn ($r) => ! $r->held_book);
        if ($unheld->isEmpty()) {
            return [];
        }
        $ids = $unheld->pluck('id')->all();
        $byDoi = [];
        foreach ($unheld as $r) {
            if ($r->doi) {
                $byDoi[mb_strtolower($r->doi)] = $r->id;
            }
        }

        $copies = DB::connection('pgsql_admin')->table('library')
            ->where('has_nodes', true)
            ->where('book', 'NOT LIKE', '%/%')
            ->where(function ($q) use ($viewer) {
                $q->where('visibility', 'public');
                if ($viewer !== null) {
                    $q->orWhere(fn ($own) => $own->where('creator', $viewer)->where('visibility', '!=', 'deleted'));
                }
            })
            ->where(function ($q) use ($ids, $byDoi) {
                $q->whereIn('canonical_source_id', $ids);
                if ($byDoi !== []) {
                    $q->orWhereIn(DB::raw('lower(doi)'), array_keys($byDoi));
                }
            })
            ->orderBy('book')
            ->get(['book', 'canonical_source_id', 'doi']);

        $out = [];
        foreach ($copies as $c) {
            $id = in_array($c->canonical_source_id, $ids, true)
                ? $c->canonical_source_id
                : ($byDoi[mb_strtolower((string) $c->doi)] ?? null);
            if ($id !== null) {
                $out[$id] ??= $c->book;
            }
        }

        return $out;
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
