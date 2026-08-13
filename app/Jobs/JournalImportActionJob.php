<?php

namespace App\Jobs;

use App\Models\CanonicalSource;
use App\Models\JournalSource;
use App\Models\User;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\ContentFetchService;
use App\Services\JournalHarvest\HtmlLaneCreator;
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
 * The three actions are the three questions an operator actually asks of a bad lane:
 *   - `import`         — there is no lane yet; go get one (pdf | html | both).
 *   - `reconvert_html` — the page is fine, OUR conversion of it was wrong. Re-runs the paste
 *                        engine over the STORED page: no network, no cost, and the input is held
 *                        constant so the only thing that changed is the processor fix.
 *   - `refetch_html`   — what we stored isn't the article (empty, walled, wrong page). Re-acquires
 *                        from the publisher.
 *
 * tries = 1, matching SourceNetworkHarvestJob: re-triggering is cheap and idempotent, and an
 * explicit operator retry beats automatic retries against a rate-limited publisher.
 */
class JournalImportActionJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600;
    public int $tries = 1;

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
