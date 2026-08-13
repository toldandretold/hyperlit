<?php

namespace App\Services\JournalHarvest;

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\SystemVersionMinter;
use App\Services\ContentFetchService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * The publisher-HTML lane: a SECOND system version of a work, sitting beside the PDF one.
 *
 * Shaped exactly like the ar5iv lane (CreateAr5ivVersionsCommand), which is the existing proof
 * that one canonical can carry sibling library rows: distinct `foundation_source` gives each
 * lane its own `findExistingSystemRow` keyspace, its own book id, and its own
 * `resources/markdown/{book}/` artifacts. Nothing about the versions model has to change.
 *
 * Deliberately NOT routed through AutoVersionCreator: that is hard-wired to the PDF foundation
 * (`canonical_pdf_vacuum`) and short-circuits at `assigned_existing` the moment any lane already
 * has content, so it can never mint a second one.
 *
 * The pointer is left alone. `AutoVersionResolver` picks the earliest-created eligible row, so
 * on a work that already has a PDF lane the PDF keeps being the version until someone promotes
 * this one deliberately (JournalVersionPromoter) — importing a lane is not a claim that it's
 * better, which is the whole reason the compare page exists.
 */
class HtmlLaneCreator
{
    /** Marks the lane. `paste_engine_html` is already in AutoVersionResolver::SYSTEM_CONVERSION_METHODS. */
    public const FOUNDATION_SOURCE = 'journal_html';
    public const CONVERSION_METHOD = 'paste_engine_html';

    public function __construct(
        private SystemVersionMinter $minter,
        private ContentFetchService $fetcher,
        private JournalVersionPromoter $promoter,
    ) {
    }

    /**
     * Create (or reuse) this canonical's HTML lane and import into it.
     *
     * `$force` re-fetches and re-converts a lane that already has content — the path a processor
     * fix has to travel to reach articles imported before it (the Bristol front-matter fix, where
     * every already-imported article was missing its title, authors and abstract). Nodes are
     * replaced wholesale, not appended (persistArticle deletes the book's rows first).
     *
     * @return array{status: string, book: ?string, reason: ?string, node_count?: int}
     *         status: imported | reimported | already_imported | fetch_failed | error
     */
    public function create(CanonicalSource $canonical, bool $force = false): array
    {
        try {
            $existing = $this->minter->findExistingSystemRow($canonical, self::FOUNDATION_SOURCE);

            // Already converted — never re-fetch. Re-running the HTML pass over a journal must be
            // free and idempotent, the same promise the PDF pass makes.
            if ($existing && $existing->has_nodes && ! $force) {
                return ['status' => 'already_imported', 'book' => $existing->book, 'reason' => null];
            }

            // A re-import rewrites the row with `listed = false` (persistArticle), which would
            // silently pull a PROMOTED lane out of the journal's feeds. Remember the pointer so
            // the operator's choice survives the reconvert.
            $wasTheVersion = $force
                && $existing
                && $canonical->auto_version_book === $existing->book;

            $bookId = $existing->book ?? $this->minter->mintSystemRow(
                $canonical,
                self::CONVERSION_METHOD,
                self::FOUNDATION_SOURCE,
            );

            File::ensureDirectoryExists(resource_path("markdown/{$bookId}"));

            $record = $this->laneRecord($bookId, $canonical);
            $result = $this->fetcher->importHtmlLane($record);

            if (($result['status'] ?? 'failed') === 'failed') {
                return [
                    'status' => 'fetch_failed',
                    'book'   => $bookId,
                    'reason' => $result['reason'] ?? 'unknown',
                ];
            }

            // Restore the promotion the re-import cleared, so a reconvert never demotes the
            // version readers are getting.
            if ($wasTheVersion) {
                $this->promoter->promote($bookId);
            }

            return [
                'status'     => $wasTheVersion || ($existing && $existing->has_nodes) ? 'reimported' : 'imported',
                'book'       => $bookId,
                'reason'     => $result['reason'] ?? null,
                'node_count' => $result['node_count'] ?? null,
            ];
        } catch (\Throwable $e) {
            return ['status' => 'error', 'book' => null, 'reason' => $e->getMessage()];
        }
    }

    /**
     * Canonicals of a journal whose HTML lane hasn't been imported yet, most-cited first.
     *
     * Deliberately NOT HarvestEligibility::eligibleCanonicalsForJournal: that one requires
     * `auto_version_book IS NULL`, so it skips every work the PDF pass already claimed — which
     * is precisely the set we want a second lane for. The gate here is simply "does a converted
     * HTML lane exist", plus something to fetch from.
     *
     * `$includeConverted` drops that gate, for re-running an improved processor over articles
     * already imported (paired with `create(force: true)`).
     *
     * @return \Illuminate\Support\Collection<int, object>
     */
    public function pendingForJournal(string $journalSourceId, int $limit = 0, bool $includeConverted = false)
    {
        $query = DB::connection('pgsql_admin')
            ->table('canonical_source as cs')
            ->where('cs.journal_source_id', $journalSourceId)
            ->where('cs.is_oa', true)
            ->where(function ($q) {
                $q->where(fn ($q2) => $q2->whereNotNull('cs.doi')->where('cs.doi', '!=', ''))
                  ->orWhere(fn ($q2) => $q2->whereNotNull('cs.oa_url')->where('cs.oa_url', '!=', ''));
            })
            ->orderByRaw('cs.cited_by_count DESC NULLS LAST')
            ->select('cs.*');

        if (! $includeConverted) {
            $query->whereNotExists(function ($q) {
                $q->select(DB::raw(1))
                    ->from('library as l')
                    ->whereColumn('l.canonical_source_id', 'cs.id')
                    ->where('l.foundation_source', self::FOUNDATION_SOURCE)
                    ->where('l.has_nodes', true)
                    ->where('l.visibility', '!=', 'deleted');
            });
        }

        if ($limit > 0) {
            $query->limit($limit);
        }

        return $query->get();
    }

    /**
     * The minimal record importHtmlLane needs. Built from the canonical rather than re-read from
     * library because the freshly-minted row carries the same identity fields by construction.
     */
    private function laneRecord(string $bookId, CanonicalSource $canonical): object
    {
        return (object) [
            'book'   => $bookId,
            'doi'    => $canonical->doi,
            'oa_url' => $canonical->oa_url,
            'title'  => $canonical->title,
        ];
    }
}
