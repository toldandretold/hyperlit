<?php

namespace App\Services\JournalHarvest;

use App\Models\CanonicalSource;
use App\Models\JournalSource;
use App\Models\User;
use App\Services\CanonicalSourceMatcher;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\OpenAlex\WorksApi;
use App\Services\OpenAlex\WorkScorer;
use App\Services\SourceHarvest\HarvestAttemptRecorder;
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
        private HarvestAttemptRecorder $attempts,
        private JournalVersionPromoter $promoter,
    ) {
    }

    /**
     * Statuses that mean "this work is settled on this lane" — no retry owed.
     *
     * `already_imported` / `assigned_existing` count: nothing was fetched, but there is nothing
     * wrong either, and leaving a stale cooldown on a work that demonstrably has content would
     * hide it from a later run that legitimately needs to revisit it.
     */
    public const SETTLED_STATUSES = ['imported', 'reimported', 'already_imported', 'assigned', 'assigned_existing'];

    /**
     * Record one work's outcome against its lane's retry backoff.
     *
     * Every non-settled status backs off, INCLUDING `deferred` (a stub that got no converted
     * content). Deferred looks benign next to `fetch_failed`, but it is the same thing as far as
     * the queue is concerned: the work is still selectable, still at the front, and re-running it
     * costs exactly as much as the first time.
     */
    private function recordAttempt(string $canonicalId, string $lane, string $status, ?string $reason): void
    {
        if (in_array($status, self::SETTLED_STATUSES, true)) {
            $this->attempts->recordSuccess($canonicalId, $lane);
            $this->consecutiveInfraFailures = 0;

            return;
        }

        // An egress fault is not this work's failure and must not spend its retry budget — see
        // HarvestAttemptRecorder::isInfrastructureFailure. The work stays exactly as selectable as
        // it was, so when the proxy comes back the queue is intact.
        if (HarvestAttemptRecorder::isInfrastructureFailure($reason)) {
            $this->consecutiveInfraFailures++;

            return;
        }

        $this->consecutiveInfraFailures = 0;
        $this->attempts->recordFailure($canonicalId, $lane, $reason ?? $status);
    }

    /**
     * How many works in a row may fail on OUR egress before a run gives up.
     *
     * The point is to stop a dead proxy from being walked through an entire journal. Each of those
     * attempts costs up to 75s of browser process timeout and produces an identical, useless
     * failure; at 890 works that is a whole day of burning nothing into nothing. Five is enough to
     * distinguish an outage from two unlucky works, and costs about six minutes to establish.
     */
    private const INFRA_FAILURE_LIMIT = 5;

    /** Consecutive works that failed on our egress; reset by any outcome that wasn't one. */
    private int $consecutiveInfraFailures = 0;

    /**
     * Has our egress failed often enough in a row to call the run off?
     *
     * Checked at the TOP of each work alongside the time budget, so the run stops before paying for
     * another doomed fetch rather than after.
     */
    private function egressLooksDown(): bool
    {
        return $this->consecutiveInfraFailures >= self::INFRA_FAILURE_LIMIT;
    }

    /** The message a run carries when the breaker tripped — it names the fault as ours. */
    private function egressAbortReason(): string
    {
        return self::INFRA_FAILURE_LIMIT . ' works in a row failed on our own network egress '
            . '(proxy/browser), not on the publisher — stopped rather than working through the '
            . 'journal marking everything failed. Check SOURCE_FETCH_PROXY, then run again; '
            . 'no work was put into retry cooldown by this.';
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
        $this->consecutiveInfraFailures = 0;
        $pending = $this->htmlLane->pendingForJournal($journal->id, $limit, $force);
        $total = count($pending);
        $abort = null;

        $this->emit($progress, ['stage' => 'html_start', 'total' => $total, 'force' => $force]);

        foreach ($pending as $i => $row) {
            $n = $i + 1;

            if ($this->egressLooksDown()) {
                $abort = $this->egressAbortReason();
                $this->emit($progress, ['stage' => 'aborted', 'done' => $i, 'total' => $total, 'reason' => $abort]);
                break;
            }
            if ($shouldStop && $shouldStop()) {
                $stats['stopped_early'] = true;
                $this->emit($progress, ['stage' => 'stopped', 'done' => $i, 'total' => $total]);
                break;
            }
            $this->emit($progress, [
                'stage' => 'html', 'n' => $n, 'total' => $total,
                'title' => mb_substr($row->title ?? '(untitled)', 0, 66),
                // Carried so a caller collecting failures can link each one back to its article.
                'canonical_id' => $row->id,
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
                $this->recordAttempt($row->id, HarvestAttemptRecorder::LANE_HTML, $status, $result['reason'] ?? null);
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
                $this->recordAttempt($row->id, HarvestAttemptRecorder::LANE_HTML, 'error', $e->getMessage());
                $this->emit($progress, ['stage' => 'html_result', 'status' => 'error', 'reason' => $e->getMessage()]);
            }

            if ($sleep > 0 && $n < $total) {
                sleep($sleep);
            }
        }

        return $stats + ['aborted_reason' => $abort];
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
        $abort = null;
        $this->consecutiveInfraFailures = 0;

        $eligible = $this->eligibility->eligibleCanonicalsForJournal($journal->id, $limit);
        $total = count($eligible);

        $this->emit($progress, ['stage' => 'pdf_start', 'total' => $total]);

        foreach ($eligible as $i => $row) {
            $n = $i + 1;

            if ($this->egressLooksDown()) {
                $abort = $this->egressAbortReason();
                $this->emit($progress, ['stage' => 'aborted', 'done' => $i, 'total' => $total, 'reason' => $abort]);
                break;
            }
            if ($shouldStop && $shouldStop()) {
                $stoppedEarly = true;
                $this->emit($progress, ['stage' => 'stopped', 'done' => $i, 'total' => $total]);
                break;
            }
            $this->emit($progress, [
                'stage' => 'pdf', 'n' => $n, 'total' => $total,
                'title' => mb_substr($row->title ?? '(untitled)', 0, 70),
                'canonical_id' => $row->id,
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
                // `--skip-ocr` deliberately leaves every stub deferred, so recording those as
                // failures would put the whole journal into cooldown for doing exactly what was
                // asked. The fetch still happened; its verdict just isn't in yet.
                if (! $skipOcr) {
                    $this->recordAttempt($row->id, HarvestAttemptRecorder::LANE_PDF, $status, $result['reason'] ?? null);
                }

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
                $this->recordAttempt($row->id, HarvestAttemptRecorder::LANE_PDF, 'error', $e->getMessage());
                $this->emit($progress, ['stage' => 'pdf_result', 'status' => 'error', 'reason' => $e->getMessage()]);
            }

            if ($sleep > 0 && $n < $total) {
                sleep($sleep);
            }
        }

        return ['stats' => $stats, 'spend' => $spend, 'books' => $books, 'stopped_early' => $stoppedEarly, 'aborted_reason' => $abort];
    }

    /**
     * Stage 3b — the CHEAP-FIRST lane: try the publisher's HTML, and only pay for OCR when it
     * doesn't yield a publishable article.
     *
     * The existing `both` mode runs the two lanes as independent passes, which is right when the
     * point is to COMPARE them (the GSCJ debugging workflow this console was built for). It is the
     * wrong shape for filling a journal: it OCRs every work regardless, so a corpus whose publisher
     * serves perfectly good server-rendered HTML — most OJS journals, tripleC included — is paid
     * for twice over at roughly $0.04 an article.
     *
     * Selection is the PDF queue (`auto_version_book IS NULL`), because the question here is "do we
     * have this article at all", not "does this lane exist". Per work:
     *
     *   1. HTML lane, unless it is serving its own cooldown (then straight to 3).
     *   2. If it imported, PROMOTE it. A fresh HTML lane does NOT claim `auto_version_book` on its
     *      own (HtmlLaneCreator leaves the pointer alone by design), so without this the work stays
     *      PDF-eligible and the next run pays for the OCR we just avoided.
     *   3. Only if there is still no version — HTML failed, or produced something the authenticity
     *      gate will not publish — fall back to the PDF lane and charge for it.
     *
     * Promotion refusing is therefore a FEATURE, not an error to route around: a lane that cannot
     * be published is a lane readers cannot be given, which is exactly the condition under which
     * paying for the PDF is the right call.
     *
     * Events: `{stage: work, n, total, title, canonical_id}` per work, then `html_result` and —
     * only when the fallback fires — `pdf_result`.
     *
     * @param  callable(array):void|null  $progress
     * @param  callable():bool|null  $shouldStop  checked before each work; true ends the run cleanly
     * @return array{stats: array<string,int>, spend: float, books: array<int,string>, stopped_early: bool}
     */
    public function importHtmlFirst(
        JournalSource $journal,
        int $limit,
        ?User $payer,
        int $sleep = 0,
        ?callable $progress = null,
        ?callable $shouldStop = null,
    ): array {
        $stats = [
            'html_won'     => 0,  // free: the publisher page carried the article
            'pdf_assigned' => 0,  // paid: HTML gave us nothing usable
            'already'      => 0,
            'failed'       => 0,  // neither lane produced a version
            'skipped_html' => 0,  // HTML lane was cooling off; went straight to PDF
        ];
        $books = [];
        $spend = 0.0;
        $stoppedEarly = false;
        $abort = null;
        $this->consecutiveInfraFailures = 0;

        $eligible = $this->eligibility->eligibleCanonicalsForJournal($journal->id, $limit);
        $total = count($eligible);

        $this->emit($progress, ['stage' => 'html_first_start', 'total' => $total]);

        foreach ($eligible as $i => $row) {
            $n = $i + 1;

            // Checked first, and before the time budget: when our egress is down every remaining
            // work fails identically at up to 75s a go, so there is nothing to spend the rest of
            // the budget on. This is the mode that made a 37-work tripleC batch report a single
            // uniform cause on both lanes.
            if ($this->egressLooksDown()) {
                $abort = $this->egressAbortReason();
                $this->emit($progress, ['stage' => 'aborted', 'done' => $i, 'total' => $total, 'reason' => $abort]);
                break;
            }
            if ($shouldStop && $shouldStop()) {
                $stoppedEarly = true;
                $this->emit($progress, ['stage' => 'stopped', 'done' => $i, 'total' => $total]);
                break;
            }

            $this->emit($progress, [
                'stage' => 'work', 'n' => $n, 'total' => $total,
                'title' => mb_substr($row->title ?? '(untitled)', 0, 66),
                'canonical_id' => $row->id,
            ]);

            $canonical = CanonicalSource::find($row->id);
            if (! $canonical) {
                $stats['failed']++;
                $this->emit($progress, ['stage' => 'html_result', 'status' => 'error', 'reason' => 'canonical row vanished mid-run']);
                continue;
            }

            $claimed = false;

            if ($this->attempts->isCoolingOff($row->id, HarvestAttemptRecorder::LANE_HTML)) {
                $stats['skipped_html']++;
            } else {
                try {
                    $html = $this->htmlLane->create($canonical, false);
                    $status = $html['status'];
                    $this->recordAttempt($row->id, HarvestAttemptRecorder::LANE_HTML, $status, $html['reason'] ?? null);

                    // `already_imported` means a converted lane exists but never won the pointer —
                    // still worth promoting, and still free. That is the resumed-run case.
                    if (in_array($status, self::SETTLED_STATUSES, true) && ! empty($html['book'])) {
                        $promotion = $this->promoter->promote($html['book']);
                        $claimed = $promotion['promoted'];
                        if ($claimed) {
                            $stats[$status === 'already_imported' ? 'already' : 'html_won']++;
                            $books[] = $html['book'];
                        }
                        $this->emit($progress, [
                            'stage'  => 'html_result',
                            'status' => $claimed ? $status : 'not_publishable',
                            'book'   => $html['book'],
                            'nodes'  => $html['node_count'] ?? null,
                            'reason' => $claimed ? null : ($promotion['reason'] ?? 'the authenticity gate would not publish this lane'),
                        ]);
                    } else {
                        $this->emit($progress, [
                            'stage'  => 'html_result',
                            'status' => $status,
                            'book'   => $html['book'] ?? null,
                            'reason' => $html['reason'] ?? null,
                        ]);
                    }
                } catch (\Throwable $e) {
                    $this->recordAttempt($row->id, HarvestAttemptRecorder::LANE_HTML, 'error', $e->getMessage());
                    $this->emit($progress, ['stage' => 'html_result', 'status' => 'error', 'reason' => $e->getMessage()]);
                }
            }

            if (! $claimed) {
                try {
                    $result = $this->creator->create($canonical, false);
                    $status = $result['status'] ?? 'error';
                    $this->recordAttempt($row->id, HarvestAttemptRecorder::LANE_PDF, $status, $result['reason'] ?? null);

                    $cost = 0.0;
                    if ($status === 'assigned') {
                        $stats['pdf_assigned']++;
                        $books[] = $result['book'];
                        $cost = $this->charger->charge(
                            $payer,
                            $result['book'],
                            "Journal harvest OCR ({$journal->slug}): {$result['book']}",
                        );
                        $spend += $cost;
                    } elseif ($status === 'assigned_existing') {
                        $stats['already']++;
                    } else {
                        $stats['failed']++;
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
                    $stats['failed']++;
                    $this->recordAttempt($row->id, HarvestAttemptRecorder::LANE_PDF, 'error', $e->getMessage());
                    $this->emit($progress, ['stage' => 'pdf_result', 'status' => 'error', 'reason' => $e->getMessage()]);
                }
            }

            if ($sleep > 0 && $n < $total) {
                sleep($sleep);
            }
        }

        return ['stats' => $stats, 'spend' => $spend, 'books' => $books, 'stopped_early' => $stoppedEarly, 'aborted_reason' => $abort];
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

    /**
     * Fold a run's two lane stat-blocks into the one flat array `finalise()` accumulates.
     *
     * The lanes share key NAMES (`fetch_failed`, `error`) while counting different things, so the
     * obvious `$pdf + $html` silently discards the HTML lane's copies — PHP's array `+` keeps the
     * left-hand value on a collision, and both callers had the PDF block on the left. The journal's
     * cumulative `harvest_stats` has therefore never recorded a single HTML fetch failure.
     *
     * Namespacing the HTML lane rather than summing keeps the two readable apart in the registry:
     * "6 fetch_failed" means nothing if it could be either lane, and the whole point of running two
     * is to compare them. PDF keys stay bare so existing accumulated history keeps adding up.
     *
     * @param  array<string,int>  $pdf
     * @param  array<string,int>  $html
     * @return array<string,int>
     */
    public static function mergeLaneStats(array $pdf, array $html): array
    {
        $merged = $pdf;
        foreach ($html as $key => $value) {
            $merged['html_' . $key] = $value;
        }

        return $merged;
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
