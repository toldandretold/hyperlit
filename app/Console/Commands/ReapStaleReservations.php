<?php

namespace App\Console\Commands;

use App\Models\User;
use App\Services\BillingService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Give back credit holds whose job died without releasing them.
 *
 * `BillingService::reserveCredits` is not a soft lock — it INCREMENTS
 * `users.debits` immediately, and only `releaseReservation()` gives it back.
 * That release lives in the job's `finally` and its `failed()` handler, and a
 * SIGKILLed worker runs NEITHER: a deploy overrunning `stopwaitsecs`, the OOM
 * killer, or a reboot all leave the user debited the full ESTIMATE for work
 * they may never have received. On a long book that is real money — a 2.7M
 * character book holds ~$4 at the budget tier.
 *
 * The queue's own `retry_after` eventually re-reserves the job and marks it
 * failed (which does release), but that is two hours away and only if a worker
 * is still listening. This is the backstop.
 *
 * Safe by construction: `releaseReservation()` only ever touches ledger rows
 * whose metadata carries `reservation = true`, so a real charge can never be
 * reversed through it, and it is idempotent.
 */
class ReapStaleReservations extends Command
{
    protected $signature = 'billing:reap-reservations
                            {--minutes=90 : Release holds older than this}
                            {--connection= : Read through this connection (default: the BYPASSRLS admin one)}
                            {--dry-run : List what would be released, change nothing}';

    protected $description = 'Release credit reservation holds orphaned by a killed job';

    public function handle(BillingService $billing): int
    {
        $minutes = max(1, (int) $this->option('minutes'));
        $cutoff = now()->subMinutes($minutes);
        // BYPASSRLS by default: cron has no RLS session and the holds belong to
        // many different users. Overridable because a test's uncommitted rows
        // are invisible to a second connection.
        $connection = (string) ($this->option('connection') ?: 'pgsql_admin');

        $holds = DB::connection($connection)->table('billing_ledger')
            ->where('type', 'debit')
            ->whereRaw("(metadata->>'reservation')::boolean IS TRUE")
            ->where('created_at', '<', $cutoff)
            ->get(['id', 'user_id', 'amount', 'description', 'created_at']);

        if ($holds->isEmpty()) {
            $this->info('No stale reservation holds.');

            return self::SUCCESS;
        }

        $this->warn("{$holds->count()} stale hold(s) older than {$minutes}m:");
        $released = 0;
        foreach ($holds as $hold) {
            $this->line(sprintf('  %s  $%.4f  %s', $hold->created_at, $hold->amount, $hold->description));
            if ($this->option('dry-run')) {
                continue;
            }

            $user = User::on($connection)->find($hold->user_id);
            if (! $user) {
                continue;
            }
            // releaseReservation sets app.current_user itself, but the ledger
            // read inside it also needs the token (the queue-worker RLS caveat
            // documented on charge()).
            DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
            DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);

            $billing->releaseReservation($user, (string) $hold->id);
            $released++;

            Log::warning('Released an orphaned credit reservation', [
                'user' => $user->name,
                'amount' => $hold->amount,
                'description' => $hold->description,
                'held_since' => (string) $hold->created_at,
            ]);
        }

        $this->info($this->option('dry-run') ? 'Dry run — nothing released.' : "Released {$released} hold(s).");

        return self::SUCCESS;
    }
}
