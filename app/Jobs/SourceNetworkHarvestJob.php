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
 * SLICED EXECUTION — a harvest can run indefinitely, but no single JOB does:
 * the runner works until its slice budget (source_harvest.slice_seconds,
 * default 900s) elapses, persists a bookmark on the harvest row and returns
 * 'sliced'; handle() then re-dispatches this job to continue. So a full
 * commons harvest (dozens–hundreds of works, each an OA fetch + OCR) is a
 * CHAIN of short queue jobs — deploy-friendly (`queue:restart` waits ≤ one
 * slice, never hours) and safely under the DB queue's retry_after=7500s
 * (a slice only outlives 900s by the one in-flight work).
 *
 * $timeout below is therefore a PER-SLICE backstop, not a harvest ceiling: it
 * only fires when a single work pathologically outruns the whole 2 h budget.
 * If it (or any crash) kills a slice, failed() still finalizes the shelf +
 * yield report from the row's persisted state, marked partial — and a user
 * re-trigger resumes from the bookmark, upgrading the report in place.
 */
class SourceNetworkHarvestJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 7200; // per-SLICE backstop, not the whole harvest — see docblock
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
        // still finalized the shelf + yield report for the partial run),
        // 'sliced' when the slice budget elapsed with frontier work remaining,
        // or 'completed' otherwise — a budget stop finalizes normally as completed.
        $outcome = $runner->run($this->harvestId);

        if ($outcome === 'sliced') {
            // Chain the next slice: the row keeps status 'running' (the live
            // progress panel keeps polling seamlessly) and no mail is sent —
            // only the LAST slice reaches the terminal path below.
            Log::info('SourceNetworkHarvestJob slice done — chaining next slice', ['harvest' => $this->harvestId]);
            self::dispatch($this->harvestId);

            return;
        }

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

        // Ship the report for whatever the run DID gather before dying:
        // results persist per-work, so finalize() rebuilds shelf + yield
        // report from the row alone, marked partial. A re-run then resumes
        // from the bookmark and upgrades the report in place. Best-effort —
        // a finalize error must never mask the original failure.
        try {
            app(HarvestRunner::class)->finalize(
                $this->harvestId,
                'This harvest run died partway (' . $e->getMessage() . ').',
            );
        } catch (\Throwable $finalizeErr) {
            Log::warning('Harvest crash-finalize failed', [
                'harvest' => $this->harvestId,
                'error'   => $finalizeErr->getMessage(),
            ]);
        }

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
