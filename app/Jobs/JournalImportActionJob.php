<?php

namespace App\Jobs;

use App\Models\CanonicalSource;
use App\Models\JournalSource;
use App\Models\User;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\ContentFetchService;
use App\Services\JournalHarvest\HtmlLaneCreator;
use App\Services\JournalHarvest\JournalHarvestRunner;
use App\Services\SourceHarvest\HarvestAttemptRecorder;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceHarvest\WorkOcrCharger;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * One article-scoped action fired from /maintainer/journal-import/{slug}.
 *
 * Queued, not synchronous, because every action here either hits a publisher or runs OCR — the
 * PDF lane can take minutes and costs real money. Runs on `citation-pipeline`, the same worker
 * the source harvester uses, so acquisition work stays serialized against rate-limited hosts
 * instead of racing it.
 *
 * Article-scoped actions — the three questions an operator asks of a bad lane:
 *   - `import`         — there is no lane yet; go get one (pdf | html | both).
 *   - `reconvert_html` — the page is fine, OUR conversion of it was wrong. Re-runs the paste
 *                        engine over the STORED page: no network, no cost, and the input is held
 *                        constant so the only thing that changed is the processor fix.
 *   - `refetch_html`   — what we stored isn't the article (empty, walled, wrong page). Re-acquires
 *                        from the publisher.
 *
 * Journal-scoped actions — the two steps that used to exist only as `journal:harvest` flags, so a
 * journal could not be started from the console at all (an un-enumerated journal shows an empty
 * list and, because every other button is per-article, no way to fill it):
 *   - `enumerate`  — ask OpenAlex what this journal has published and upsert those works as
 *                    canonicals. Touches no publisher, runs no OCR, costs nothing.
 *   - `import_all` — work the queue: up to `work_limit` eligible works (0 = all), lane-by-lane.
 *                    This one spends money on the PDF lane, hence the cap and the confirm.
 *                    Its `lanes` value also accepts `html_first`, which is a strategy rather than a
 *                    lane: per work, try the free publisher page and buy OCR only if that yields
 *                    nothing publishable (JournalHarvestRunner::importHtmlFirst). On a journal
 *                    whose publisher serves real server-rendered HTML that is most of the corpus
 *                    imported for nothing.
 *
 * Both run the SAME JournalHarvestRunner stages the CLI runs — the console is a second face on
 * one implementation, not a second implementation.
 *
 * tries = 1, matching SourceNetworkHarvestJob: re-triggering is cheap and idempotent, and an
 * explicit operator retry beats automatic retries against a rate-limited publisher.
 */
class JournalImportActionJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600;
    public int $tries = 1;

    /**
     * Seconds between works in a bulk run. Config-driven (`HARVEST_WORK_SLEEP`) because the right
     * value is a property of the PUBLISHER's rate rules, not ours — Bristol's AWS WAF started
     * issuing CAPTCHAs partway through a 25-work batch, which is what a rate-based rule looks
     * like. A journal harvest hits one host over and over; going flat out is how one earns a block.
     */
    private function workSleep(): int
    {
        return (int) config('services.source_fetch.work_sleep_seconds', 2);
    }

    /**
     * How long a bulk run may keep taking new work. Comfortably inside `$timeout` (3600s) so the
     * loop exits and REPORTS rather than being killed mid-article — and `$timeout` in turn stays
     * under the database queue's `retry_after` (7500s), without which a long job is re-dispatched
     * while the first copy is still writing.
     */
    private const WORK_BUDGET = 3000;

    /**
     * Ceiling on the per-work failure list carried back on the run row. Enough to triage a batch;
     * bounded so a journal where everything fails cannot bloat the jsonb the page polls.
     */
    private const MAX_REPORTED_FAILURES = 100;

    public function __construct(private string $runId)
    {
        $this->onQueue('citation-pipeline');
    }

    public function handle(
        AutoVersionCreator $creator,
        HtmlLaneCreator $htmlLane,
        ContentFetchService $fetcher,
        WorkOcrCharger $charger,
        HarvestShelf $shelf,
        JournalHarvestRunner $runner,
        HarvestAttemptRecorder $attempts,
    ): void {
        $db = DB::connection('pgsql_admin');
        $run = $db->table('journal_import_runs')->where('id', $this->runId)->first();
        if (! $run) {
            Log::warning('JournalImportActionJob: run row vanished', ['run' => $this->runId]);
            return;
        }

        $this->mark(['status' => 'running', 'error' => null, 'step_detail' => 'starting']);

        try {
            $counts = match ($run->action) {
                'import'         => $this->runImport($run, $creator, $htmlLane, $charger, $shelf, $attempts),
                'reconvert_html' => $this->runHtmlAction($run, $fetcher, $htmlLane, reconvertOnly: true),
                'refetch_html'   => $this->runHtmlAction($run, $fetcher, $htmlLane, reconvertOnly: false),
                'enumerate'      => $this->runEnumerate($run, $runner),
                'import_all'     => $this->runImportAll($run, $runner),
                default          => throw new \RuntimeException("unknown action \"{$run->action}\""),
            };

            // Chained BEFORE the row is marked terminal so the successor's id can be written into
            // this run's `counts` — that is how the console follows a chain: its poller sees
            // `completed`, finds `next_run_id`, and keeps polling instead of declaring victory
            // one-twelfth of the way through a journal.
            if ($next = $this->maybeChain($run, $counts)) {
                $counts['next_run_id'] = $next;
            }

            $this->mark([
                'status'      => 'completed',
                'counts'      => json_encode($counts),
                'step_detail' => $counts['summary'] ?? 'done',
            ]);
        } catch (\Throwable $e) {
            Log::error('JournalImportActionJob failed', ['run' => $this->runId, 'error' => $e->getMessage()]);
            $this->mark(['status' => 'failed', 'error' => mb_substr($e->getMessage(), 0, 500)]);
        }
    }

    /**
     * Import the requested lane(s) for one work.
     *
     * Outcomes feed the SAME retry backoff the bulk loops use (HarvestAttemptRecorder): an operator
     * who imports one article by hand and succeeds must clear any cooldown that article was
     * serving, or the next bulk run will keep skipping a work that now demonstrably fetches. This
     * path itself is never blocked by a cooldown — it names its article directly and never consults
     * HarvestEligibility, which is what makes "just try it now" always available.
     */
    private function runImport(
        object $run,
        AutoVersionCreator $creator,
        HtmlLaneCreator $htmlLane,
        WorkOcrCharger $charger,
        HarvestShelf $shelf,
        HarvestAttemptRecorder $attempts,
    ): array {
        $canonical = CanonicalSource::find($run->canonical_source_id);
        if (! $canonical) {
            throw new \RuntimeException('canonical row not found');
        }

        $journal = JournalSource::find($run->journal_source_id);
        $counts = ['pdf' => null, 'html' => null];
        $done = [];

        if (in_array($run->lanes, ['pdf', 'both'], true)) {
            $this->mark(['step_detail' => 'PDF lane: fetching + OCR (this is the slow one)']);
            $result = $creator->create($canonical, false);
            $counts['pdf'] = $result['status'] ?? 'error';
            $this->recordAttempt($attempts, $canonical->id, HarvestAttemptRecorder::LANE_PDF, $counts['pdf'], $result['reason'] ?? null);

            // Charge only a successful NEW import, exactly as the CLI does — `assigned_existing`
            // and failures never cost the operator anything.
            if (($result['status'] ?? null) === 'assigned' && $run->user_id) {
                $user = User::on('pgsql_admin')->find($run->user_id);
                if ($user) {
                    $charger->charge($user, $result['book'], "Journal import OCR ({$journal?->slug}): {$result['book']}");
                }
            }
            if (! empty($result['book'])) {
                $this->mark(['book' => $result['book']]);
            }
            $done[] = 'pdf ' . $counts['pdf'];
        }

        if (in_array($run->lanes, ['html', 'both'], true)) {
            $this->mark(['step_detail' => 'HTML lane: fetching the publisher page']);
            $result = $htmlLane->create($canonical, false);
            $counts['html'] = $result['status'] ?? 'error';
            $counts['html_reason'] = $result['reason'] ?? null;
            $this->recordAttempt($attempts, $canonical->id, HarvestAttemptRecorder::LANE_HTML, $counts['html'], $counts['html_reason']);
            if (! empty($result['book'])) {
                $this->mark(['book' => $result['book']]);
            }
            $done[] = 'html ' . $counts['html'];
        }

        // Keep the journal's public feeds in step with what now exists.
        if ($journal) {
            $shelf->syncJournalShelfMembership($journal);
        }

        $counts['summary'] = implode(', ', $done);

        return $counts;
    }

    /**
     * Ask OpenAlex what this journal has published and upsert the answer as canonicals.
     *
     * The step that makes a journal exist for every other button: the console lists
     * `canonical_source WHERE journal_source_id = <journal>`, so until this runs the page is empty
     * and — since every other action is article-scoped — unactionable. Free: OpenAlex only, no
     * publisher fetch, no OCR.
     */
    private function runEnumerate(object $run, JournalHarvestRunner $runner): array
    {
        $journal = JournalSource::find($run->journal_source_id);
        if (! $journal) {
            throw new \RuntimeException('journal row not found');
        }

        $stats = $runner->enumerate($journal, 'article', false, function (array $e) {
            // Also the watchdog heartbeat: runStatus fails a run with no progress for 30 minutes,
            // and a big journal's enumeration is many pages long.
            //
            // `total = 0` deliberately: OpenAlex paginates and the true count is not known until
            // the last page, so the console draws an indeterminate bar. `n` is what has landed.
            $this->markProgress(
                "enumerating: page {$e['pages']}, {$e['works']} works seen, {$e['upserted']} stored",
                [
                    'phase' => 'enumerate',
                    'n'     => (int) ($e['upserted'] ?? 0),
                    'total' => 0,
                    'title' => "page {$e['pages']} · {$e['works']} works seen",
                    'imported' => (int) ($e['upserted'] ?? 0),
                    'already'  => 0,
                    'failed'   => 0,
                    'recent_failures' => [],
                ],
            );
        });

        $estimate = $runner->estimate($journal);

        return $stats + [
            'eligible' => $estimate['eligible'],
            'summary'  => "{$stats['upserted']} works enumerated, {$estimate['eligible']} eligible to import",
        ];
    }

    /**
     * Work the journal's queue: up to `work_limit` works (0 = every eligible one), lane by lane.
     *
     * The HTML lane runs first and is free; the PDF lane runs OCR and is charged to whoever
     * pressed the button (`user_id`), per successful NEW import only — the same rule the CLI
     * applies, because it is literally the same code.
     */
    private function runImportAll(object $run, JournalHarvestRunner $runner): array
    {
        $journal = JournalSource::find($run->journal_source_id);
        if (! $journal) {
            throw new \RuntimeException('journal row not found');
        }

        $limit = (int) ($run->work_limit ?? 0);
        $payer = $run->user_id ? User::on('pgsql_admin')->find($run->user_id) : null;
        $counts = [];
        $spend = 0.0;
        $done = [];
        $stoppedEarly = false;

        // "All" on a 107-article journal is genuinely longer than one job may live: `timeout` must
        // stay under the queue's `retry_after` (7500s) or a still-running job gets picked up a
        // second time and two workers write the same books. So the loop stops itself with time to
        // spare and reports how far it got — every stage is idempotent and works are taken
        // most-cited-first, so the next press resumes rather than repeats.
        $deadline = time() + self::WORK_BUDGET;
        $outOfTime = function () use ($deadline, &$stoppedEarly): bool {
            $stop = time() >= $deadline;
            $stoppedEarly = $stoppedEarly || $stop;
            return $stop;
        };

        // Which works failed and WHY. "13 failed" is not a diagnosis: 13 empty shells is publisher
        // intermittency (press again), while 3 identity mismatches is our bug. The runner already
        // reports both per work — this just stops throwing them away.
        $failures = [];
        $current = null;

        // The live beat the console renders: where we are, in fields. Held across events because
        // the `*_result` stage reports an OUTCOME and carries no n/total — it settles the work the
        // preceding stage announced, so the position has to be remembered from that announcement.
        $beat = [
            'phase' => null, 'n' => 0, 'total' => 0, 'title' => null,
            'imported' => 0, 'already' => 0, 'failed' => 0,
        ];

        $publish = function (string $stepDetail) use (&$beat, &$failures): void {
            $this->markProgress($stepDetail, $beat + [
                // The tail, newest first — enough to see a pattern forming mid-run without
                // shipping the whole list on every work. The full grouped set still lands in
                // `counts` at the end, which is where triage actually happens.
                'recent_failures' => array_slice(array_reverse($failures), 0, 5),
            ]);
        };

        // `$alreadyStatuses` is checked FIRST and is a subset of `$successStatuses` — both are
        // successes as far as the failure list is concerned, but they are different numbers to an
        // operator watching a run: 20 already-there means the cap is being spent on works that
        // needed nothing.
        $collect = function (
            string $lane,
            array $e,
            array $successStatuses,
            array $alreadyStatuses,
        ) use (&$failures, &$current, &$beat): void {
            if ($e['stage'] === $lane) {
                $current = ['title' => $e['title'], 'canonical_id' => $e['canonical_id'] ?? null];
                return;
            }
            $status = $e['status'] ?? '';
            if (in_array($status, $alreadyStatuses, true)) {
                $beat['already']++;
                return;
            }
            if (in_array($status, $successStatuses, true)) {
                $beat['imported']++;
                return;
            }
            // Counted even past the reporting cap: the tally must stay true on a journal where
            // everything fails, long after the detail list stops growing.
            $beat['failed']++;
            if (count($failures) >= self::MAX_REPORTED_FAILURES) {
                return;
            }
            $failures[] = [
                'lane'   => $lane,
                'title'  => $current['title'] ?? '(untitled)',
                'canonical_id' => $current['canonical_id'] ?? null,
                'book'   => $e['book'] ?? null,
                'status' => $e['status'] ?? 'error',
                'reason' => $e['reason'] ?? null,
            ];
        };

        if ($run->lanes === 'html_first') {
            // One pass, one work list, two lanes tried in cost order — see
            // JournalHarvestRunner::importHtmlFirst. The beat settles per WORK rather than per lane
            // attempt: a failed HTML attempt is not a failure yet, because the PDF fallback is
            // still to come, and counting it would show a run failing everything while it quietly
            // succeeded at most of it.
            $htmlReason = null;

            $first = $runner->importHtmlFirst($journal, $limit, $payer, $this->workSleep(), function (array $e) use ($publish, &$beat, &$failures, &$current, &$htmlReason) {
                if ($e['stage'] === 'work') {
                    $beat['phase'] = 'html_first';
                    $beat['n']     = (int) ($e['n'] ?? 0);
                    $beat['total'] = (int) ($e['total'] ?? 0);
                    $beat['title'] = $e['title'] ?? null;
                    $current = ['title' => $e['title'], 'canonical_id' => $e['canonical_id'] ?? null];
                    $htmlReason = null;
                    $publish("{$beat['n']}/{$beat['total']} (html, pdf if needed): {$beat['title']}");

                    return;
                }

                $status = $e['status'] ?? '';

                if ($e['stage'] === 'html_result') {
                    if (in_array($status, JournalHarvestRunner::SETTLED_STATUSES, true)) {
                        // Free win — the publisher page carried the article and no OCR was bought.
                        $status === 'already_imported' ? $beat['already']++ : $beat['imported']++;
                    } else {
                        // Remembered, not reported: if the PDF fallback then also fails, knowing
                        // what the HTML lane said first is most of the diagnosis.
                        $htmlReason = $e['reason'] ?? $status;
                    }
                    $publish("{$beat['n']}/{$beat['total']}: {$beat['title']}");

                    return;
                }

                if ($e['stage'] !== 'pdf_result') {
                    return;
                }

                if ($status === 'assigned') {
                    $beat['imported']++;
                } elseif ($status === 'assigned_existing') {
                    $beat['already']++;
                } else {
                    $beat['failed']++;
                    if (count($failures) < self::MAX_REPORTED_FAILURES) {
                        $failures[] = [
                            'lane'   => 'html→pdf',
                            'title'  => $current['title'] ?? '(untitled)',
                            'canonical_id' => $current['canonical_id'] ?? null,
                            'book'   => $e['book'] ?? null,
                            'status' => $status ?: 'error',
                            'reason' => ($e['reason'] ?? $status)
                                . ($htmlReason ? " [html lane first: {$htmlReason}]" : ''),
                        ];
                    }
                }
                $publish("{$beat['n']}/{$beat['total']}: {$beat['title']}");
            }, $outOfTime);

            $counts['html_first'] = $first['stats'];
            $counts['spend'] = round($first['spend'], 4);
            $spend = $first['spend'];
            $s = $first['stats'];
            $done[] = "{$s['html_won']} free from html, {$s['pdf_assigned']} via pdf"
                . ($s['already'] ? ", {$s['already']} already there" : '')
                . ", {$s['failed']} failed"
                . ($first['spend'] > 0 ? sprintf(', $%.4f', $first['spend']) : '');
        }

        if (in_array($run->lanes, ['html', 'both'], true)) {
            $html = $runner->importHtmlLanes($journal, $limit, false, $this->workSleep(), function (array $e) use ($collect, $publish, &$beat) {
                if ($e['stage'] === 'html') {
                    $beat['phase'] = 'html';
                    $beat['n']     = (int) ($e['n'] ?? 0);
                    $beat['total'] = (int) ($e['total'] ?? 0);
                    $beat['title'] = $e['title'] ?? null;
                }
                if (in_array($e['stage'], ['html', 'html_result'], true)) {
                    $collect('html', $e, ['imported', 'reimported', 'already_imported'], ['already_imported']);
                    // Published on the result stage too, so the tallies move as each work settles
                    // rather than jumping a whole work behind the position.
                    $publish("html {$beat['n']}/{$beat['total']}: {$beat['title']}");
                }
            }, $outOfTime);
            unset($html['stopped_early']);
            $counts['html'] = $html;
            $done[] = "html: {$html['imported']} imported, {$html['already_imported']} already there, "
                . ($html['fetch_failed'] + $html['error']) . ' failed';
        }

        if (in_array($run->lanes, ['pdf', 'both'], true)) {
            $pdf = $runner->importPdfLanes($journal, $limit, $payer, false, $this->workSleep(), function (array $e) use ($collect, $publish, &$beat) {
                if ($e['stage'] === 'pdf') {
                    $beat['phase'] = 'pdf';
                    $beat['n']     = (int) ($e['n'] ?? 0);
                    $beat['total'] = (int) ($e['total'] ?? 0);
                    $beat['title'] = $e['title'] ?? null;
                }
                if (in_array($e['stage'], ['pdf', 'pdf_result'], true)) {
                    $collect('pdf', $e, ['assigned', 'assigned_existing'], ['assigned_existing']);
                    $publish("pdf {$beat['n']}/{$beat['total']} (fetch + OCR): {$beat['title']}");
                }
            }, $outOfTime);
            $counts['pdf'] = $pdf['stats'];
            $counts['spend'] = round($pdf['spend'], 4);
            $spend = $pdf['spend'];

            // A lane that was asked for and never got a single work is NOT "nothing to do" — on a
            // `both` run the two lanes share one deadline and the HTML lane goes first, so it can
            // eat the whole budget and leave this one breaking at i = 0. Reported as
            // "0 imported, 0 failed" that reads as a fully-harvested journal, which is the opposite
            // of the truth: not one article was attempted.
            $done[] = ($pdf['stopped_early'] && array_sum($pdf['stats']) === 0)
                ? 'pdf: not started — the html lane used the whole time budget'
                : "pdf: {$pdf['stats']['assigned']} imported, "
                    . ($pdf['stats']['fetch_failed'] + $pdf['stats']['ocr_failed'] + $pdf['stats']['error']) . ' failed'
                    . ($pdf['spend'] > 0 ? sprintf(', $%.4f', $pdf['spend']) : '');
        }

        // Shelf reconcile + registry bookkeeping, so the journal's public feeds and the index
        // page's "started" split reflect what just landed. Deliberately runs for an HTML-only run
        // too: the CLI's html-only path returns before this, which leaves `last_harvested_at`
        // null and a journal that has been worked still sitting in the console's "next up" list.
        // `html_first` is mutually exclusive with the other two branches and its keys are disjoint
        // from both, so this is a plain union rather than another collision waiting to happen.
        $stats = array_merge(
            JournalHarvestRunner::mergeLaneStats($counts['pdf'] ?? [], $counts['html'] ?? []),
            $counts['html_first'] ?? [],
        );
        $runner->finalise($journal, $stats, $spend, function (array $e) use ($publish, &$beat) {
            if ($e['stage'] === 'shelf') {
                // No denominator here — the console draws an indeterminate bar for `total = 0`
                // rather than inventing a percentage for a step that has no countable work.
                $beat['phase'] = 'shelf';
                $beat['n']     = 0;
                $beat['total'] = 0;
                $beat['title'] = "{$e['added']} book(s) added";
                $publish("shelf sync: {$e['added']} book(s) added");
            }
        });

        $estimate = $runner->estimate($journal);
        $counts['remaining_eligible'] = $estimate['eligible'];
        // Reported separately so a "remaining" number that stops falling has a visible reason:
        // these are works serving a retry cooldown, not works nobody will ever get to.
        $counts['cooling_off'] = $estimate['cooling_off'] ?? 0;
        $counts['stopped_early'] = $stoppedEarly;
        $counts['failures'] = $failures;
        $counts['summary'] = implode(' · ', $done)
            . ", {$counts['remaining_eligible']} still eligible"
            . ($counts['cooling_off'] ? " ({$counts['cooling_off']} cooling off after earlier failures)" : '')
            . ($stoppedEarly ? ' — stopped at the time limit, press again to continue' : '');

        return $counts;
    }

    /**
     * Reconvert or re-fetch an EXISTING html lane. Both end in the same place (nodes replaced),
     * but only one of them touches the publisher — which is the whole diagnostic point.
     */
    private function runHtmlAction(
        object $run,
        ContentFetchService $fetcher,
        HtmlLaneCreator $htmlLane,
        bool $reconvertOnly,
    ): array {
        $db = DB::connection('pgsql_admin');
        $record = $db->table('library')
            ->leftJoin('canonical_source as cs', 'cs.id', '=', 'library.canonical_source_id')
            ->where('library.book', $run->book)
            ->select('library.book', 'cs.doi', 'cs.oa_url', 'cs.id as canonical_id')
            ->first();

        if (! $record) {
            throw new \RuntimeException('lane not found');
        }

        // Every path here ends in persistArticle, which rewrites the row with `listed = false`.
        // On the lane readers are actually being served that is a silent demotion: the article
        // drops out of /j and the journal's shelf, and nothing says so. Remember the pointer and
        // put it back. (The re-fetch branch's HtmlLaneCreator already does this for itself, so
        // the restore below is a no-op there — hence the `listed` re-read rather than a blind promote.)
        $wasTheVersion = DB::connection('pgsql_admin')
            ->table('canonical_source')
            ->where('id', $record->canonical_id)
            ->value('auto_version_book') === $record->book;

        if ($reconvertOnly) {
            $this->mark(['step_detail' => 'reconverting from the stored page (no network)']);
            $result = $fetcher->reconvertHtmlLaneFromStoredPage($record);
        } else {
            $this->mark(['step_detail' => 're-fetching the publisher page']);
            $canonical = CanonicalSource::find($record->canonical_id);
            if (! $canonical) {
                throw new \RuntimeException('canonical row not found for this lane');
            }
            $result = $htmlLane->create($canonical, true);
        }

        $status = $result['status'] ?? 'error';
        if (in_array($status, ['failed', 'error'], true)) {
            throw new \RuntimeException($result['reason'] ?? 'unknown failure');
        }

        if ($wasTheVersion && ! $db->table('library')->where('book', $record->book)->value('listed')) {
            app(\App\Services\JournalHarvest\JournalVersionPromoter::class)->promote($record->book);
        }

        return [
            'status'  => $status,
            'nodes'   => $result['node_count'] ?? null,
            'summary' => $status . (isset($result['node_count']) ? ", {$result['node_count']} nodes" : ''),
        ];
    }

    /**
     * Enqueue this run's successor, when the operator asked for one and there is a reason to.
     *
     * The whole point of the chain is a journal that finishes without a dozen manual presses, so
     * the conditions to CONTINUE are deliberately narrow — every one of them is a way the loop
     * could otherwise become a money-burning spin:
     *
     *   - only a bulk `import_all` chains (nothing else is time-boxed);
     *   - only if the operator opted in;
     *   - only if this run actually hit the time budget. A run that finished early has emptied
     *       the queue, and re-dispatching would spin on nothing;
     *   - only if work remains. `remaining_eligible` already excludes works in their retry
     *       cooldown, so a journal whose entire tail is failing STOPS the chain instead of
     *       re-fetching corpses for a week;
     *   - only under the chain's spend cap, evaluated on the accumulated total.
     *
     * Returns the new run id, or null if the chain ends here.
     */
    private function maybeChain(object $run, array $counts): ?string
    {
        if ($run->action !== 'import_all' || ! ($run->continue_until_done ?? false)) {
            return null;
        }
        if (empty($counts['stopped_early']) || (int) ($counts['remaining_eligible'] ?? 0) < 1) {
            return null;
        }

        $spentSoFar = round((float) ($run->chain_spend ?? 0) + (float) ($counts['spend'] ?? 0), 4);
        $cap = $run->spend_cap === null ? null : (float) $run->spend_cap;
        if ($cap !== null && $spentSoFar >= $cap) {
            Log::info('JournalImportActionJob: chain stopped at its spend cap', [
                'run' => $this->runId, 'spent' => $spentSoFar, 'cap' => $cap,
            ]);

            return null;
        }

        $nextId = (string) Str::uuid();
        DB::connection('pgsql_admin')->table('journal_import_runs')->insert([
            'id'                  => $nextId,
            'journal_source_id'   => $run->journal_source_id,
            'canonical_source_id' => null,
            'user_id'             => $run->user_id,
            'action'              => 'import_all',
            'lanes'               => $run->lanes,
            'status'              => 'pending',
            'book'                => null,
            'work_limit'          => $run->work_limit,
            'continue_until_done' => true,
            'spend_cap'           => $run->spend_cap,
            'chain_spend'         => $spentSoFar,
            'chain_position'      => (int) ($run->chain_position ?? 1) + 1,
            'counts'              => '{}',
            'created_at'          => now(),
            'updated_at'          => now(),
        ]);

        self::dispatch($nextId);

        return $nextId;
    }

    /**
     * Settled or not? Same verdict the bulk loops apply (JournalHarvestRunner::recordAttempt),
     * duplicated here only because this path calls the lane creators directly rather than through
     * the runner's loops. The status vocabularies of the two lanes are disjoint, so one list covers
     * both without a lane argument.
     */
    private function recordAttempt(
        HarvestAttemptRecorder $attempts,
        string $canonicalId,
        string $lane,
        string $status,
        ?string $reason,
    ): void {
        in_array($status, JournalHarvestRunner::SETTLED_STATUSES, true)
            ? $attempts->recordSuccess($canonicalId, $lane)
            : $attempts->recordFailure($canonicalId, $lane, $reason ?? $status);
    }

    private function mark(array $fields): void
    {
        DB::connection('pgsql_admin')
            ->table('journal_import_runs')
            ->where('id', $this->runId)
            ->update($fields + ['updated_at' => now()]);
    }

    /**
     * The per-work beat: the prose line AND the same thing as fields, in one UPDATE.
     *
     * One statement rather than two because this fires once per work on a run that may be 100
     * works long, and `mark()` doubles as the watchdog heartbeat (`updated_at`) — two writes per
     * work would double that traffic to say the same thing twice.
     *
     * `step_detail` keeps being written verbatim: it is what the console falls back to when
     * `progress` is null, which is every run dispatched before this shipped and any still being
     * worked by a pre-deploy worker.
     */
    private function markProgress(string $stepDetail, array $progress): void
    {
        $this->mark(['step_detail' => $stepDetail, 'progress' => json_encode($progress)]);
    }

    public function failed(\Throwable $e): void
    {
        $this->mark(['status' => 'failed', 'error' => mb_substr($e->getMessage(), 0, 500)]);
    }
}
