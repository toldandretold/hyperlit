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
        /**
         * How many times this chain has already been resumed after a FAILED slice (as opposed
         * to a cleanly budget-capped one). Carried in the job payload rather than on the run
         * row because it is a property of the chain, not of the run: `--sync` has no chain,
         * and a run re-triggered by an operator deserves a fresh allowance.
         */
        private int $failureRetries = 0,
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
                // A clean hand-off resets the failure allowance: the chain is demonstrably
                // making progress, so an earlier transient fault should not count against a
                // fault that happens hours later.
                self::dispatch($this->runId, $this->autoApprove, $this->budgetSeconds, 0);

                return;
            }

            if ($this->autoApprove) {
                $counts['auto_approved'] = $this->autoApprove($db, $minter);
            }

            // Clear the live beat before stamping the verdict: `progress` describes a run that is
            // still moving, and a terminal row carrying the last book it touched invites the
            // console to draw a half-full bar over a finished run.
            $this->mark(['progress' => null]);

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
            $this->mark(['status' => 'failed', 'progress' => null, 'error' => mb_substr($e->getMessage(), 0, 500)]);
        }
    }

    private function autoApprove($db, HyperciteMinter $minter): int
    {
        $minted = 0;
        $rows = $db->table('hypercite_candidates')
            ->where('detection_run_id', $this->runId)
            ->where('status', 'matched')
            ->get();

        // Minting is its own phase with its own denominator: each mint splices HTML, recomputes
        // char data and touches two books' clocks, so a few hundred of them is minutes during
        // which the run used to report the LAST book it scanned and look wedged.
        $eligible = $rows->filter(fn ($c) => AutoApprovePolicy::qualifies($c))->values();
        $total = $eligible->count();

        foreach ($eligible as $i => $candidate) {
            $this->mark([
                'step_detail' => "auto-approving {$i}/{$total}",
                'progress'    => json_encode([
                    'phase' => 'minting',
                    'n'     => $i + 1,
                    'total' => $total,
                    'title' => 'minting hypercites that clear the auto-approve policy',
                    'minted' => $minted,
                ]),
            ]);

            $result = $minter->mint($candidate->id, reviewerId: null, auto: true);
            if ($result['applied'] ?? false) {
                $minted++;
            }
        }

        return $minted;
    }

    /**
     * The baton-drop handler. `handle()`'s own try/catch covers an exception thrown INSIDE the
     * detector, but it cannot cover the two ways a slice actually died in production: the queue
     * worker killing the job at `$timeout`, and the kernel killing the worker outright. In both
     * cases the catch block never runs, so the `stopped_early` continuation at the top of this
     * class is never dispatched — and with `tries = 1` nothing retries. The run row then sits
     * 'running' with a frozen `updated_at` until the console's 30-minute watchdog calls it dead,
     * which reads as "the worker died or was never running" whatever the real cause was. That is
     * how a tripleC run lost 22 hours of successfully chained slices to one overlong book.
     *
     * So: resume the chain, but a bounded number of times. An unbounded resume on a
     * deterministic crash is an infinite chain that occupies the citation worker forever.
     *
     * NOTE the limit of this hook — Laravel calls it on a timeout or an uncaught throw, but a
     * hard SIGKILL (OOM) bypasses the worker entirely and nothing here runs. The reserve window
     * in CandidateDetector (`scan_reserve_seconds`) is what covers that case, by not starting
     * work the slice cannot finish in the first place.
     */
    public function failed(?\Throwable $e = null): void
    {
        $message = $e ? mb_substr($e->getMessage(), 0, 400) : 'slice died without reporting (timeout or kill)';

        // `--sync` has no worker to pick up a continuation, so a failure there is terminal.
        $maxRetries = (int) config('hypercites.max_failure_continuations', 2);
        $canResume = $this->budgetSeconds !== null && $this->failureRetries < $maxRetries;

        if (! $canResume) {
            Log::error('DetectHyperciteCandidatesJob: chain ended on a failed slice', [
                'run' => $this->runId, 'retries' => $this->failureRetries, 'error' => $message,
            ]);
            $this->mark([
                'status'      => 'failed',
                'progress'    => null,
                'error'       => "slice failed and the chain was not resumed: {$message}",
                'step_detail' => 'run ended on a failed slice',
            ]);

            return;
        }

        $next = $this->failureRetries + 1;
        Log::warning('DetectHyperciteCandidatesJob: slice failed, resuming chain', [
            'run' => $this->runId, 'attempt' => $next, 'of' => $maxRetries, 'error' => $message,
        ]);

        // Status STAYS 'running' and `updated_at` is touched — that heartbeat is what keeps the
        // console's 30-minute watchdog from declaring a run dead that is in fact being resumed.
        $this->mark([
            'status'      => 'running',
            'error'       => null,
            'step_detail' => "slice failed ({$message}) — resuming, attempt {$next} of {$maxRetries}",
        ]);

        self::dispatch($this->runId, $this->autoApprove, $this->budgetSeconds, $next);
    }

    private function mark(array $fields): void
    {
        DB::connection('pgsql_admin')->table('hypercite_runs')
            ->where('id', $this->runId)
            ->update($fields + ['updated_at' => now()]);
    }
}
