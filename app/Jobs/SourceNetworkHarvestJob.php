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
 */
class SourceNetworkHarvestJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 7200; // fetch + OCR across dozens of works is slow
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
