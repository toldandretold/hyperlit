<?php

namespace App\Services\JournalHarvest;

use App\Models\CanonicalSource;
use App\Models\JournalSource;
use App\Models\User;
use App\Services\CanonicalSourceMatcher;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\OpenAlex\WorksApi;
use App\Services\OpenAlex\WorkScorer;
use App\Services\SourceHarvest\HarvestEligibility;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceHarvest\WorkOcrCharger;

/**
 * The journal harvest stages, with no opinion about who is watching.
 *
 * Extracted from JournalHarvestCommand when the console grew buttons for the same work: the CLI
 * and the queued JournalImportActionJob now run THE SAME enumeration and THE SAME import loops,
 * differing only in how they report progress (coloured console lines vs a `journal_import_runs`
 * row the page polls). Two implementations of "enumerate a journal" would drift the moment one of
 * them learned something — the same reasoning that keeps the PDF lane's reconvert on the shared
 * /maintainer/conversion path instead of growing a second copy inside this console.
 *
 * Progress is reported as STRUCTURED EVENTS, not formatted strings, precisely so the two callers
 * can render differently without this class knowing about either: the command turns an event into
 * a `<fg=green>` line, the job turns it into a `step_detail` sentence. Every stage is individually
 * idempotent, so a caller may stop between them and resume later — that is what makes Ctrl-C free
 * on the CLI and what lets the console offer enumeration and import as separate buttons.
 */
class JournalHarvestRunner
{
    /** foundation_source stamped on canonicals first created by the journal path. */
    public const FOUNDATION_SOURCE = 'journal_harvest';

    public function __construct(
        private WorksApi $worksApi,
        private WorkScorer $scorer,
        private CanonicalSourceMatcher $matcher,
        private HarvestEligibility $eligibility,
        private AutoVersionCreator $creator,
        private HtmlLaneCreator $htmlLane,
        private WorkOcrCharger $charger,
        private HarvestShelf $shelf,
    ) {
    }

    /**
     * Stage 1 — enumerate every work OpenAlex lists for this journal and upsert it as a canonical
     * stamped with `journal_source_id`.
     *
     * This is the step that makes a journal visible AT ALL: the console's article list is
     * `canonical_source WHERE journal_source_id = <journal>`, so before this runs the page can
     * only say "no articles enumerated yet". It costs nothing but OpenAlex calls — no publisher is
     * touched, no OCR runs — which is why it is safe behind a plain button with no confirm.
     *
     * Events: `{stage: enumerate, page, works, upserted, skipped_type, dry_run}` per page.
     *
     * @param  callable(array):void|null  $progress
     * @return array{pages:int, works:int, upserted:int, skipped_type:int, count:int}
     */
    public function enumerate(
        JournalSource $journal,
        ?string $type = 'article',
        bool $dryRun = false,
        ?callable $progress = null,
    ): array {
        $stats = ['pages' => 0, 'works' => 0, 'upserted' => 0, 'skipped_type' => 0, 'count' => 0];
        $cursor = '*';

        while ($cursor !== null) {
            $page = $this->worksApi->fetchBySourcePage($journal->openalex_source_id, $cursor, 200, $type);
            $cursor = $page['next_cursor'];
            $stats['pages']++;

            if ($stats['pages'] === 1) {
                $stats['count'] = (int) $page['count'];
            }

            foreach ($page['works'] as $normalised) {
                $stats['works']++;
                if (! $this->scorer->isCitableWork($normalised)) {
                    $stats['skipped_type']++;
                    continue;
                }
                if ($dryRun) {
                    continue;
                }

                $canonical = $this->matcher->ingestExternal($normalised, self::FOUNDATION_SOURCE);
                // Stamp unconditionally: the works filter guarantees this journal IS the work's
                // primary location. Same (default) connection as ingestExternal's write —
                // canonical_source has no RLS.
                if ($canonical->journal_source_id !== $journal->id) {
                    $canonical->journal_source_id = $journal->id;
                    $canonical->save();
                }
                $stats['upserted']++;
            }

            $this->emit($progress, ['stage' => 'enumerate', 'dry_run' => $dryRun] + $stats);
        }

        return $stats;
    }

    /**
     * Stage 2b — the HTML lane: a sibling system version per work, straight from the publisher
     * page. Free (no OCR), and selected on its OWN predicate, because the PDF eligibility rule
     * requires `auto_version_book IS NULL` and so skips exactly the works we most want a second
     * lane for.
     *
     * Events: `{stage: html, n, total, title}` before each work, `{stage: html_result, …}` after.
     *
     * @param  callable(array):void|null  $progress
     * @param  callable():bool|null  $shouldStop  checked before each work; true ends the run cleanly
     * @return array{imported:int, reimported:int, already_imported:int, fetch_failed:int, error:int, stopped_early:bool}
     */
    public function importHtmlLanes(
        JournalSource $journal,
        int $limit,
        bool $force = false,
        int $sleep = 0,
        ?callable $progress = null,
        ?callable $shouldStop = null,
    ): array {
        $stats = ['imported' => 0, 'reimported' => 0, 'already_imported' => 0, 'fetch_failed' => 0, 'error' => 0, 'stopped_early' => false];
        $pending = $this->htmlLane->pendingForJournal($journal->id, $limit, $force);
        $total = count($pending);

        $this->emit($progress, ['stage' => 'html_start', 'total' => $total, 'force' => $force]);

        foreach ($pending as $i => $row) {
            $n = $i + 1;

            if ($shouldStop && $shouldStop()) {
                $stats['stopped_early'] = true;
                $this->emit($progress, ['stage' => 'stopped', 'done' => $i, 'total' => $total]);
                break;
            }
            $this->emit($progress, [
                'stage' => 'html', 'n' => $n, 'total' => $total,
                'title' => mb_substr($row->title ?? '(untitled)', 0, 66),
            ]);

            $canonical = CanonicalSource::find($row->id);
            if (! $canonical) {
                $stats['error']++;
                $this->emit($progress, ['stage' => 'html_result', 'status' => 'error', 'reason' => 'canonical row vanished mid-run']);
                continue;
            }

            try {
                $result = $this->htmlLane->create($canonical, $force);
                $status = $result['status'];
                $stats[array_key_exists($status, $stats) ? $status : 'error']++;
                $this->emit($progress, [
                    'stage'  => 'html_result',
                    'status' => $status,
                    'book'   => $result['book'] ?? null,
                    'nodes'  => $result['node_count'] ?? null,
                    'reason' => $result['reason'] ?? null,
                ]);
            } catch (\Throwable $e) {
                // One bad article must never kill the run — the same promise the CLI makes.
                $stats['error']++;
                $this->emit($progress, ['stage' => 'html_result', 'status' => 'error', 'reason' => $e->getMessage()]);
            }

            if ($sleep > 0 && $n < $total) {
                sleep($sleep);
            }
        }

        return $stats;
    }

    /**
     * Stage 3 — the PDF lane: fetch + convert eligible works, most-cited first. This is the
     * expensive one; `$payer` is charged per SUCCESSFUL new import via WorkOcrCharger, exactly as
     * the CLI does — `assigned_existing` and every failure cost nothing.
     *
     * Events: `{stage: pdf, n, total, title}` before each work, `{stage: pdf_result, …}` after.
     *
     * @param  callable(array):void|null  $progress
     * @param  callable():bool|null  $shouldStop  checked before each work; true ends the run cleanly
     * @return array{stats:array<string,int>, spend:float, books:array<int,string>, stopped_early:bool}
     */
    public function importPdfLanes(
        JournalSource $journal,
        int $limit,
        ?User $payer,
        bool $skipOcr = false,
        int $sleep = 0,
        ?callable $progress = null,
        ?callable $shouldStop = null,
    ): array {
        $stats = ['assigned' => 0, 'assigned_existing' => 0, 'fetch_failed' => 0, 'ocr_failed' => 0, 'deferred' => 0, 'error' => 0];
        $books = [];
        $spend = 0.0;
        $stoppedEarly = false;

        $eligible = $this->eligibility->eligibleCanonicalsForJournal($journal->id, $limit);
        $total = count($eligible);

        $this->emit($progress, ['stage' => 'pdf_start', 'total' => $total]);

        foreach ($eligible as $i => $row) {
            $n = $i + 1;

            if ($shouldStop && $shouldStop()) {
                $stoppedEarly = true;
                $this->emit($progress, ['stage' => 'stopped', 'done' => $i, 'total' => $total]);
                break;
            }
            $this->emit($progress, [
                'stage' => 'pdf', 'n' => $n, 'total' => $total,
                'title' => mb_substr($row->title ?? '(untitled)', 0, 70),
            ]);

            try {
                $canonical = CanonicalSource::find($row->id);
                if (! $canonical) {
                    $stats['error']++;
                    $this->emit($progress, ['stage' => 'pdf_result', 'status' => 'error', 'reason' => 'canonical row vanished mid-run']);
                    continue;
                }

                $result = $this->creator->create($canonical, $skipOcr);
                $status = $result['status'] ?? 'error';
                $stats[array_key_exists($status, $stats) ? $status : 'error']++;

                $cost = 0.0;
                if ($status === 'assigned') {
                    $books[] = $result['book'];
                    $cost = $this->charger->charge(
                        $payer,
                        $result['book'],
                        "Journal harvest OCR ({$journal->slug}): {$result['book']}",
                    );
                    $spend += $cost;
                }

                $this->emit($progress, [
                    'stage'  => 'pdf_result',
                    'status' => $status,
                    'book'   => $result['book'] ?? null,
                    'via'    => $result['via'] ?? null,
                    'cost'   => $cost,
                    'reason' => $result['reason'] ?? null,
                ]);
            } catch (\Throwable $e) {
                // One bad work must never kill the journal run.
                $stats['error']++;
                $this->emit($progress, ['stage' => 'pdf_result', 'status' => 'error', 'reason' => $e->getMessage()]);
            }

            if ($sleep > 0 && $n < $total) {
                sleep($sleep);
            }
        }

        return ['stats' => $stats, 'spend' => $spend, 'books' => $books, 'stopped_early' => $stoppedEarly];
    }

    /**
     * Stage 4 — shelf reconcile + registry bookkeeping. A FULL reconcile rather than "add this
     * run's books": it also repairs drift from earlier runs and heals year/volume/issue onto
     * version rows. A shelf failure never fails the harvest itself.
     *
     * @return object|null the journal's shelf row, when one could be ensured
     */
    public function finalise(JournalSource $journal, array $stats, float $spend, ?callable $progress = null): ?object
    {
        $shelfRow = null;
        try {
            $shelfRow = $this->shelf->ensureJournalShelfFor($journal);
            $added = $this->shelf->syncJournalShelfMembership($journal);
            $this->emit($progress, ['stage' => 'shelf', 'added' => $added]);
        } catch (\Throwable $e) {
            $this->emit($progress, ['stage' => 'shelf_failed', 'reason' => $e->getMessage()]);
        }

        $cumulative = $journal->harvest_stats ?? [];
        foreach ($stats as $k => $v) {
            $cumulative[$k] = ($cumulative[$k] ?? 0) + $v;
        }
        $cumulative['spend'] = round(($cumulative['spend'] ?? 0) + $spend, 4);
        $cumulative['runs'] = ($cumulative['runs'] ?? 0) + 1;
        $cumulative['last_run'] = $stats + ['spend' => round($spend, 4)];

        $journal->update([
            'harvest_stats'     => $cumulative,
            'last_harvested_at' => now(),
            'shelf_id'          => $shelfRow->id ?? $journal->shelf_id,
        ]);

        return $shelfRow;
    }

    /** How many works are still worth fetching — the console's "eligible" number. */
    public function estimate(JournalSource $journal): array
    {
        return $this->eligibility->estimateForJournal($journal->id);
    }

    /** @return \Illuminate\Support\Collection<int, object> */
    public function eligiblePreview(JournalSource $journal, int $limit)
    {
        return $this->eligibility->eligibleCanonicalsForJournal($journal->id, $limit);
    }

    private function emit(?callable $progress, array $event): void
    {
        if ($progress) {
            $progress($event);
        }
    }
}
