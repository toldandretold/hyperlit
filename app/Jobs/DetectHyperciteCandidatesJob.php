<?php

namespace App\Jobs;

use App\Models\JournalSource;
use App\Services\Hypercites\AutoApprovePolicy;
use App\Services\Hypercites\CandidateDetector;
use App\Services\Hypercites\DetectionScope;
use App\Services\Hypercites\HyperciteMinter;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * One collection-wide hypercite-candidate detection run — a journal or a
 * public shelf, whichever scope column the run row carries — fired from the
 * /maintainer/hypercites console (or `hypercites:detect`). Queued because a
 * collection's worth of parsing + quote location takes minutes, and the first
 * run may also invoke citation:scan-bibliography per book (LLM + external
 * lookups). Runs on `citation-pipeline` so it never races the harvester or an
 * import writing the same books' rows.
 *
 * With auto-approve on (explicit, per run, default off), freshly `matched`
 * candidates that clear AutoApprovePolicy are minted immediately — the
 * mostly-autonomous mode the review loop is meant to graduate into.
 *
 * tries = 1: idempotent (detection upserts on a stable key), and an operator
 * retry beats an automatic one.
 */
class DetectHyperciteCandidatesJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600;
    public int $tries = 1;

    /**
     * How long one SLICE may keep taking new citing books. Comfortably inside
     * `$timeout` so the loop exits cleanly instead of being killed mid-article
     * — the first GSCJ run proved the failure mode: 107 first-time
     * bibliography scans blew the hour, the worker killed the job at 3600s
     * and the run row sat 'running' until the watchdog called it dead,
     * reading as a crash when it was just slow.
     *
     * A slice that runs out of budget DISPATCHES ITS OWN CONTINUATION on the
     * same run row (status stays 'running', the page keeps polling one run
     * id), so a whole-journal first run completes unattended overnight. The
     * chain always terminates: the budget is only checked before STARTING a
     * new book, so every slice completes at least one, and already-scanned
     * books skip the expensive step on the next pass.
     *
     * `$budgetSeconds = null` disables slicing (the CLI's --sync path, which
     * runs inline and must not queue continuations).
     */
    private const WORK_BUDGET = 3000;

    public function __construct(
        private string $runId,
        private bool $autoApprove = false,
        private ?int $budgetSeconds = self::WORK_BUDGET,
    ) {
        $this->onQueue('citation-pipeline');
    }

    public function handle(CandidateDetector $detector, HyperciteMinter $minter): void
    {
        $db = DB::connection('pgsql_admin');
        $run = $db->table('hypercite_runs')->where('id', $this->runId)->first();
        if (! $run) {
            Log::warning('DetectHyperciteCandidatesJob: run row vanished', ['run' => $this->runId]);

            return;
        }

        $scope = null;
        if ($run->shelf_id) {
            $shelf = $db->table('shelves')->where('id', $run->shelf_id)->first();
            $scope = $shelf ? DetectionScope::forShelf($shelf) : null;
        } elseif ($run->journal_source_id) {
            $journal = JournalSource::find($run->journal_source_id);
            $scope = $journal ? DetectionScope::forJournal($journal) : null;
        }
        if (! $scope) {
            $this->mark(['status' => 'failed', 'error' => 'scope row (journal/shelf) not found']);

            return;
        }

        $this->mark(['status' => 'running', 'error' => null, 'step_detail' => 'starting']);

        try {
            $deadline = $this->budgetSeconds !== null ? time() + $this->budgetSeconds : null;
            $counts = $detector->detect($scope, $this->runId, $deadline);

            if (! empty($counts['stopped_early'])) {
                // Out of budget, not out of work: hand the baton to a fresh job
                // on the SAME run row. Auto-approve waits for the final slice —
                // it filters by detection_run_id, which persists across slices.
                $this->mark([
                    'status'      => 'running',
                    'counts'      => json_encode($counts),
                    'step_detail' => "sliced: {$counts['articles']} books walked this pass, "
                        . "{$counts['stopped_early']} to go — continuing in a fresh job",
                ]);
                self::dispatch($this->runId, $this->autoApprove, $this->budgetSeconds);

                return;
            }

            if ($this->autoApprove) {
                $counts['auto_approved'] = $this->autoApprove($db, $minter);
            }

            $summary = "{$counts['candidates']} candidates over {$counts['articles']} articles"
                . " ({$counts['matched']} quote-matched"
                . ($this->autoApprove ? ", {$counts['auto_approved']} auto-approved" : '')
                . ')';

            $this->mark([
                'status'      => 'completed',
                'counts'      => json_encode($counts),
                'step_detail' => $summary,
            ]);
        } catch (\Throwable $e) {
            Log::error('DetectHyperciteCandidatesJob failed', ['run' => $this->runId, 'error' => $e->getMessage()]);
            $this->mark(['status' => 'failed', 'error' => mb_substr($e->getMessage(), 0, 500)]);
        }
    }

    private function autoApprove($db, HyperciteMinter $minter): int
    {
        $minted = 0;
        $rows = $db->table('hypercite_candidates')
            ->where('detection_run_id', $this->runId)
            ->where('status', 'matched')
            ->get();

        foreach ($rows as $candidate) {
            if (! AutoApprovePolicy::qualifies($candidate)) {
                continue;
            }
            $result = $minter->mint($candidate->id, reviewerId: null, auto: true);
            if ($result['applied'] ?? false) {
                $minted++;
            }
        }

        return $minted;
    }

    private function mark(array $fields): void
    {
        DB::connection('pgsql_admin')->table('hypercite_runs')
            ->where('id', $this->runId)
            ->update($fields + ['updated_at' => now()]);
    }
}
