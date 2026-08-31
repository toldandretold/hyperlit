<?php

namespace App\Console\Commands;

use App\Mail\StripeTopUpStuckMail;
use App\Services\Billing\StripeSessionGateway;
use App\Services\Billing\StripeTopUpCreditor;
use App\Services\BillingService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

/**
 * Reconcile Stripe top-ups so a paid user is NEVER left uncredited waiting on
 * Stripe's ~72h webhook-retry window.
 *
 * The webhook is the fast path; this is the safety net. For every locally-recorded
 * checkout session still 'pending' past a short grace period, ask Stripe whether
 * it was actually paid:
 *   - paid + not yet credited  → credit it now (idempotent, atomic — same
 *     StripeTopUpCreditor the webhook uses),
 *   - paid but we still can't credit it (user vanished, etc.), or Stripe
 *     unreachable → leave pending, count the attempt, and ALERT the admin,
 *   - Stripe says expired (or it's >25h old and still unpaid) → mark expired and
 *     stop checking (the user simply didn't pay).
 *
 * Credits come ONLY from Stripe's own record of the session (fetched with our
 * secret key) — never from anything a user submits — so this cannot be gamed.
 * Idempotent against billing_ledger, so it can never double-credit alongside the
 * webhook or a previous run.
 */
class ReconcileStripeTopUps extends Command
{
    protected $signature = 'billing:reconcile-stripe
                            {--grace=5 : Skip sessions newer than this many minutes (webhook may still be in flight)}
                            {--alert-after=30 : A paid session uncredited longer than this (minutes) alerts the admin}
                            {--limit=200 : Max sessions to examine per run}
                            {--dry-run : Report only, change nothing}';

    protected $description = 'Credit paid-but-uncredited Stripe top-ups and alert on stuck ones (webhook safety net)';

    public function handle(
        StripeSessionGateway $stripe,
        StripeTopUpCreditor $creditor,
        BillingService $billing,
    ): int {
        $grace = now()->subMinutes(max(0, (int) $this->option('grace')));
        $alertAfter = now()->subMinutes(max(0, (int) $this->option('alert-after')));
        $limit = max(1, (int) $this->option('limit'));
        $dry = (bool) $this->option('dry-run');
        $admin = DB::connection('pgsql_admin');

        $pending = $admin->table('stripe_checkout_sessions')
            ->where('status', 'pending')
            ->where('created_at', '<', $grace)
            ->orderBy('created_at')
            ->limit($limit)
            ->get();

        if ($pending->isEmpty()) {
            $this->info('No pending Stripe sessions to reconcile.');

            return self::SUCCESS;
        }

        $creditedNow = 0;
        $expired = 0;
        $problems = [];   // paid-but-uncredited / errored — need a human
        $recovered = [];  // credited this run but had been stuck a while — FYI

        foreach ($pending as $row) {
            $session = $stripe->retrieve($row->session_id);

            if ($session === null) {
                // Couldn't reach Stripe / session not found — unknown, try again
                // next sweep. Record the attempt; escalate if it's been paid-shaped
                // and stuck (we can't tell here, so age is the signal).
                if (! $dry) {
                    $admin->table('stripe_checkout_sessions')->where('id', $row->id)->update([
                        'attempts'   => $row->attempts + 1,
                        'last_error' => 'stripe retrieve failed',
                        'updated_at' => now(),
                    ]);
                }
                if ($row->created_at < $alertAfter) {
                    $problems[] = ['row' => $row, 'reason' => 'Stripe unreachable / session not found'];
                }
                continue;
            }

            $paid = ($session->payment_status ?? null) === 'paid'
                || ($session->status ?? null) === 'complete';
            $isExpired = ($session->status ?? null) === 'expired';

            if ($paid) {
                $this->line(sprintf('  paid: %s  user=%d  $%.2f%s', $row->session_id, $row->user_id, (float) $row->credit_amount, $dry ? '  [dry-run]' : ''));
                if ($dry) {
                    continue;
                }

                $result = $creditor->applyCredit((int) $row->user_id, (float) $row->credit_amount, $row->session_id);

                if ($result === StripeTopUpCreditor::CREDITED || $result === StripeTopUpCreditor::DUPLICATE) {
                    if ($result === StripeTopUpCreditor::CREDITED) {
                        $creditedNow++;
                        Log::warning('Reconciled a paid-but-uncredited Stripe top-up', [
                            'session_id' => $row->session_id,
                            'user_id'    => $row->user_id,
                            'amount'     => $row->credit_amount,
                            'age'        => (string) $row->created_at,
                        ]);
                        // Make the new balance visible on the account card (best-effort).
                        try {
                            $user = $admin->table('users')->where('id', $row->user_id)->first();
                            if ($user) {
                                $billing->refreshAccountBook($user->name);
                            }
                        } catch (\Throwable $e) {
                            Log::warning('Account book refresh after reconcile failed (non-fatal)', ['error' => $e->getMessage()]);
                        }
                        // It was stuck long enough to matter → tell the admin we caught it.
                        if ($row->created_at < $alertAfter) {
                            $recovered[] = $row;
                        }
                    }
                } else {
                    // Paid on Stripe but we still can't credit (e.g. user deleted).
                    if (! $dry) {
                        $admin->table('stripe_checkout_sessions')->where('id', $row->id)->update([
                            'attempts'   => $row->attempts + 1,
                            'last_error' => "paid but applyCredit={$result}",
                            'updated_at' => now(),
                        ]);
                    }
                    $problems[] = ['row' => $row, 'reason' => "paid but could not credit ({$result})"];
                }
            } elseif ($isExpired) {
                if (! $dry) {
                    $admin->table('stripe_checkout_sessions')->where('id', $row->id)
                        ->update(['status' => 'expired', 'updated_at' => now()]);
                }
                $expired++;
            } else {
                // Still open/unpaid. Stripe expires unpaid sessions after ~24h; once
                // past that, stop checking so it doesn't linger as 'pending' forever.
                if ($row->created_at < now()->subHours(25)) {
                    if (! $dry) {
                        $admin->table('stripe_checkout_sessions')->where('id', $row->id)
                            ->update(['status' => 'expired', 'updated_at' => now()]);
                    }
                    $expired++;
                }
            }
        }

        // ONE admin email per run for anything needing attention: paid-but-uncredited
        // or Stripe-unreachable-and-stale (problems), plus a note of any we recovered.
        // Only alert problem rows we haven't already alerted on, so a persistent
        // issue doesn't email every sweep.
        $freshProblems = array_values(array_filter($problems, fn ($p) => $p['row']->alerted_at === null));

        if (! $dry && (! empty($freshProblems) || ! empty($recovered))) {
            $alertTo = config('mail.maintainer_alert');
            if ($alertTo) {
                try {
                    Mail::send(new StripeTopUpStuckMail(
                        problems: array_map(fn ($p) => [
                            'session_id' => $p['row']->session_id,
                            'user_id'    => $p['row']->user_id,
                            'amount'     => (float) $p['row']->credit_amount,
                            'created_at' => (string) $p['row']->created_at,
                            'reason'     => $p['reason'],
                        ], $freshProblems),
                        recoveredCount: count($recovered),
                    ));
                } catch (\Throwable $e) {
                    Log::error('Failed to send Stripe reconciliation alert', ['error' => $e->getMessage()]);
                }
            }
            // Stamp alerted_at so we don't re-email the same stuck sessions each sweep.
            foreach ($freshProblems as $p) {
                $admin->table('stripe_checkout_sessions')->where('id', $p['row']->id)
                    ->update(['alerted_at' => now(), 'updated_at' => now()]);
            }
        }

        $this->info(sprintf(
            '%sReconcile done: %d credited, %d expired, %d problem(s), %d recovered.',
            $dry ? '[dry-run] ' : '',
            $creditedNow,
            $expired,
            count($problems),
            count($recovered),
        ));

        return self::SUCCESS;
    }
}
