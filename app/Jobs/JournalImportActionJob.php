<?php

namespace App\Jobs;

use App\Models\CanonicalSource;
use App\Models\JournalSource;
use App\Models\User;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\ContentFetchService;
use App\Services\JournalHarvest\HtmlLaneCreator;
use App\Services\JournalHarvest\JournalHarvestRunner;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceHarvest\WorkOcrCharger;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

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
     * Seconds between works in a bulk run — the CLI's `--sleep` default. A journal harvest hits
     * one publisher over and over; going flat out is how a harvester earns a block.
     */
    private const WORK_SLEEP = 2;

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
                'import'         => $this->runImport($run, $creator, $htmlLane, $charger, $shelf),
                'reconvert_html' => $this->runHtmlAction($run, $fetcher, $htmlLane, reconvertOnly: true),
                'refetch_html'   => $this->runHtmlAction($run, $fetcher, $htmlLane, reconvertOnly: false),
                'enumerate'      => $this->runEnumerate($run, $runner),
                'import_all'     => $this->runImportAll($run, $runner),
                default          => throw new \RuntimeException("unknown action \"{$run->action}\""),
            };

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

    /** Import the requested lane(s) for one work. */
    private function runImport(
        object $run,
        AutoVersionCreator $creator,
        HtmlLaneCreator $htmlLane,
        WorkOcrCharger $charger,
        HarvestShelf $shelf,
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
            $this->mark(['step_detail' => "enumerating: page {$e['pages']}, {$e['works']} works seen, {$e['upserted']} stored"]);
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
        $collect = function (string $lane, array $e, array $successStatuses) use (&$failures, &$current): void {
            if ($e['stage'] === $lane) {
                $current = ['title' => $e['title'], 'canonical_id' => $e['canonical_id'] ?? null];
                return;
            }
            if (in_array($e['status'] ?? '', $successStatuses, true) || count($failures) >= self::MAX_REPORTED_FAILURES) {
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

        if (in_array($run->lanes, ['html', 'both'], true)) {
            $html = $runner->importHtmlLanes($journal, $limit, false, self::WORK_SLEEP, function (array $e) use ($collect) {
                if ($e['stage'] === 'html') {
                    $this->mark(['step_detail' => "html {$e['n']}/{$e['total']}: {$e['title']}"]);
                }
                if (in_array($e['stage'], ['html', 'html_result'], true)) {
                    $collect('html', $e, ['imported', 'reimported', 'already_imported']);
                }
            }, $outOfTime);
            unset($html['stopped_early']);
            $counts['html'] = $html;
            $done[] = "html: {$html['imported']} imported, {$html['already_imported']} already there, "
                . ($html['fetch_failed'] + $html['error']) . ' failed';
        }

        if (in_array($run->lanes, ['pdf', 'both'], true)) {
            $pdf = $runner->importPdfLanes($journal, $limit, $payer, false, self::WORK_SLEEP, function (array $e) use ($collect) {
                if ($e['stage'] === 'pdf') {
                    $this->mark(['step_detail' => "pdf {$e['n']}/{$e['total']} (fetch + OCR): {$e['title']}"]);
                }
                if (in_array($e['stage'], ['pdf', 'pdf_result'], true)) {
                    $collect('pdf', $e, ['assigned', 'assigned_existing']);
                }
            }, $outOfTime);
            $counts['pdf'] = $pdf['stats'];
            $counts['spend'] = round($pdf['spend'], 4);
            $spend = $pdf['spend'];
            $done[] = "pdf: {$pdf['stats']['assigned']} imported, "
                . ($pdf['stats']['fetch_failed'] + $pdf['stats']['ocr_failed'] + $pdf['stats']['error']) . ' failed'
                . ($pdf['spend'] > 0 ? sprintf(', $%.4f', $pdf['spend']) : '');
        }

        // Shelf reconcile + registry bookkeeping, so the journal's public feeds and the index
        // page's "started" split reflect what just landed. Deliberately runs for an HTML-only run
        // too: the CLI's html-only path returns before this, which leaves `last_harvested_at`
        // null and a journal that has been worked still sitting in the console's "next up" list.
        $stats = ($counts['pdf'] ?? []) + ($counts['html'] ?? []);
        $runner->finalise($journal, $stats, $spend, function (array $e) {
            if ($e['stage'] === 'shelf') {
                $this->mark(['step_detail' => "shelf sync: {$e['added']} book(s) added"]);
            }
        });

        $counts['remaining_eligible'] = $runner->estimate($journal)['eligible'];
        $counts['stopped_early'] = $stoppedEarly;
        $counts['failures'] = $failures;
        $counts['summary'] = implode(' · ', $done)
            . ", {$counts['remaining_eligible']} still eligible"
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

    private function mark(array $fields): void
    {
        DB::connection('pgsql_admin')
            ->table('journal_import_runs')
            ->where('id', $this->runId)
            ->update($fields + ['updated_at' => now()]);
    }

    public function failed(\Throwable $e): void
    {
        $this->mark(['status' => 'failed', 'error' => mb_substr($e->getMessage(), 0, 500)]);
    }
}
