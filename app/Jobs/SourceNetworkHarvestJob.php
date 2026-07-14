<?php

namespace App\Jobs;

use App\Mail\HarvestCompleteMail;
use App\Mail\HarvestFailedMail;
use App\Models\User;
use App\Services\SourceHarvest\HarvestRunner;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

/**
 * Source Network Harvester orchestrator: one job per run, driving
 * HarvestRunner over the harvest row's frontier. Deliberately a single
 * sequential job rather than a per-work fan-out — sequential fetching with
 * politeness sleeps is the model every existing acquisition flow uses
 * against rate-limited external services, and the per-work try/catch in the
 * runner already isolates failures.
 *
 * tries = 1: a crashed run leaves the row 'running' until the controller's
 * stale watchdog fails it; re-triggering is cheap and idempotent (eligibility
 * excludes already-versioned canonicals, pointers wire from partial runs),
 * so an explicit user re-trigger beats automatic retries against
 * rate-limited publishers.
 *
 * timeout = 0 (UNBOUNDED): a full commons harvest walks dozens–hundreds of
 * works, each needing an OA fetch (the Cloudflare ladder alone can burn minutes
 * per work) + OCR + politeness sleeps, and it repeatedly DEFERS works whose
 * conversion hasn't landed yet — so a run legitimately spans many hours. Any
 * fixed cap (was 7200s/2h) eventually SIGALRM-kills a healthy run mid-frontier.
 * The job's own timeout overrides the worker's --timeout, so this is exempt
 * without weakening the 7200s cap on the CitationPipelineJobs sharing the queue.
 *
 * WHY 0 IS SAFE HERE (no double-run despite retry_after=7500s): the DB queue's
 * retry_after only bites when a SECOND worker re-reserves a job the first is
 * still running. `citation-pipeline` has exactly one consumer — the dedicated
 * hyperlit-citation Supervisor program at numprocs=1 — and a serial worker
 * cannot re-poll the job it's blocked inside handle() on. ⚠️ If you ever raise
 * that worker's numprocs (or add another consumer of this queue), you MUST also
 * raise config/queue.php `retry_after` above the longest expected harvest, or a
 * parallel worker will re-reserve the live run and tries=1 will mark it failed.
 */
class SourceNetworkHarvestJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 0; // unbounded — see class docblock (multi-hour harvests)
    public int $tries = 1;

    public function __construct(private string $harvestId)
    {
        $this->onQueue('citation-pipeline');
    }

    public function handle(HarvestRunner $runner): void
    {
        Log::info('SourceNetworkHarvestJob starting', ['harvest' => $this->harvestId]);

        DB::connection('pgsql_admin')
            ->table('source_network_harvests')
            ->where('id', $this->harvestId)
            ->update(['status' => 'running', 'error' => null, 'updated_at' => now()]);

        // The runner returns 'cancelled' when the user cancelled mid-run (it
        // still finalized the shelf + yield report for the partial run) or
        // 'completed' otherwise — a budget stop finalizes normally as completed.
        $outcome = $runner->run($this->harvestId);

        DB::connection('pgsql_admin')
            ->table('source_network_harvests')
            ->where('id', $this->harvestId)
            ->update([
                'status'     => $outcome === 'cancelled' ? 'cancelled' : 'completed',
                'updated_at' => now(),
            ]);

        // Either way the run finalized (partial results shelved) — send the
        // opt-in completion mail.
        $this->sendNotificationEmail(completed: true);

        Log::info('SourceNetworkHarvestJob finished', ['harvest' => $this->harvestId, 'outcome' => $outcome]);
    }

    public function failed(\Throwable $e): void
    {
        Log::error('SourceNetworkHarvestJob failed', [
            'harvest' => $this->harvestId,
            'error'   => $e->getMessage(),
        ]);

        DB::connection('pgsql_admin')
            ->table('source_network_harvests')
            ->where('id', $this->harvestId)
            ->update([
                'status'     => 'failed',
                'error'      => $e->getMessage(),
                'updated_at' => now(),
            ]);

        $this->sendNotificationEmail(completed: false, error: $e->getMessage());
    }

    /**
     * "Email me when done" opt-in: send the completion/failure mail when the
     * harvest row's notify_email flag was set by an authenticated owner.
     * Best-effort — a mail failure must never fail (or retry) the job.
     */
    private function sendNotificationEmail(bool $completed, ?string $error = null): void
    {
        try {
            $db = DB::connection('pgsql_admin');
            $harvest = $db->table('source_network_harvests')->where('id', $this->harvestId)->first();
            if (!$harvest || !$harvest->notify_email || !$harvest->user_id) {
                return;
            }

            $user = User::on('pgsql_admin')->find($harvest->user_id);
            if (!$user?->email) {
                return;
            }

            $title = $db->table('library')->where('book', $harvest->root_book)->value('title')
                ?: $harvest->root_book;

            if ($completed) {
                $shelf = $harvest->shelf_id
                    ? (array) $db->table('shelves')->where('id', $harvest->shelf_id)
                        ->select(['name', 'slug', 'creator'])->first()
                    : null;

                Mail::send(new HarvestCompleteMail(
                    $user->email,
                    $title,
                    $harvest->root_book,
                    json_decode($harvest->counts ?? '{}', true) ?: [],
                    $shelf ?: null,
                ));
            } else {
                Mail::send(new HarvestFailedMail(
                    $user->email,
                    $title,
                    $harvest->root_book,
                    $error ?? 'unknown error',
                ));
            }

            Log::info('Harvest notification email sent', ['harvest' => $this->harvestId, 'to' => $user->email]);
        } catch (\Throwable $mailErr) {
            Log::warning('Failed to send harvest notification email', [
                'harvest' => $this->harvestId,
                'error'   => $mailErr->getMessage(),
            ]);
        }
    }
}
