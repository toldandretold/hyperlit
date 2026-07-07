<?php

namespace App\Services;

use App\Models\BillingLedger;
use App\Models\User;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class BillingService
{
    /**
     * Charge a user (create a debit ledger entry).
     *
     * All tiers: logs real cost to ledger for usage tracking.
     * Pay-as-you-go: also increments users.debits (for balance gating).
     * Premium: skips debits increment (ledger-only) so balance stays clean on downgrade.
     */
    public function charge(
        User $user,
        float $amount,
        string $description,
        string $category,
        array $lineItems = [],
        ?array $metadata = null,
    ): BillingLedger {
        // NOTE: regeneration below runs after this transaction returns (i.e.
        // post-commit). If a caller ever wraps charge() in an outer
        // transaction, switch to DB::afterCommit() — today none do, and the
        // freshness guard in generateAccountBookIfNeeded self-heals any miss.
        $entry = DB::transaction(function () use ($user, $amount, $description, $category, $lineItems, $metadata) {
            DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);

            $user = User::lockForUpdate()->find($user->id);

            $multiplier = $user->getBillingMultiplier();

            $metadata = array_merge($metadata ?? [], [
                'raw_cost' => round($amount, 4),
                'multiplier' => $multiplier,
                'tier' => $user->status,
            ]);

            $chargedAmount = round($amount * $multiplier, 4);
            $isPremium = $user->status === 'premium';

            if (! $isPremium) {
                $user->increment('debits', $chargedAmount);
            }
            $user->refresh();

            return BillingLedger::create([
                'user_id' => $user->id,
                'type' => 'debit',
                'amount' => $chargedAmount,
                'description' => $description,
                'category' => $category,
                'line_items' => ! empty($lineItems) ? $lineItems : null,
                'metadata' => $metadata,
                'balance_after' => $user->balance,
            ]);
        });

        $this->refreshAccountBook($user->name);

        return $entry;
    }

    /**
     * Check if a user can start an expensive operation.
     * Premium: always allowed. Pay-as-you-go: must have positive balance.
     */
    public function canProceed(User $user): bool
    {
        if ($user->status === 'premium') {
            return true;
        }

        return $user->balance > 0;
    }

    /**
     * Atomically reserve credits for an upcoming operation, preventing
     * concurrent requests from all passing a non-locking canProceed() check.
     *
     * Premium: always succeeds (no debit hold needed).
     * Pay-as-you-go: increments debits by $estimatedCost under a row lock
     * (lockForUpdate), creating a 'reservation' ledger entry. If the balance
     * after the hold is negative, the reservation is rolled back and null is
     * returned. The actual charge happens later via charge() — the reservation
     * is a temporary hold that ensures only one operation proceeds at a time.
     *
     * Returns a BillingLedger entry on success, or null if insufficient balance.
     */
    public function reserveCredits(User $user, float $estimatedCost, string $description): ?BillingLedger
    {
        if ($user->status === 'premium') {
            // Premium users aren't charged per-use; no reservation needed.
            return null;
        }

        if ($estimatedCost <= 0) {
            return null;
        }

        try {
            return DB::transaction(function () use ($user, $estimatedCost, $description) {
                DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);

                $locked = User::lockForUpdate()->find($user->id);
                if ($locked->balance <= 0) {
                    return null;
                }

                $multiplier = $locked->getBillingMultiplier();
                $holdAmount = round($estimatedCost * $multiplier, 4);

                $locked->increment('debits', $holdAmount);
                $locked->refresh();

                return BillingLedger::create([
                    'user_id' => $locked->id,
                    'type' => 'debit',
                    'amount' => $holdAmount,
                    'description' => $description,
                    'category' => 'tts_reservation',
                    'metadata' => [
                        'reservation' => true,
                        'raw_cost' => round($estimatedCost, 4),
                        'multiplier' => $multiplier,
                        'tier' => $locked->status,
                    ],
                    'balance_after' => $locked->balance,
                ]);
            });
        } catch (\Throwable $e) {
            Log::warning('Credit reservation failed', [
                'user' => $user->name,
                'estimated_cost' => $estimatedCost,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }

    /**
     * Add credits to a user.
     */
    public function addCredits(
        User $user,
        float $amount,
        string $description,
        string $category = 'topup',
        ?array $metadata = null,
    ): BillingLedger {
        // Post-commit regeneration — same outer-transaction caveat as charge().
        $entry = DB::transaction(function () use ($user, $amount, $description, $category, $metadata) {
            DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);

            $user = User::lockForUpdate()->find($user->id);

            $user->increment('credits', $amount);
            $user->refresh();

            return BillingLedger::create([
                'user_id' => $user->id,
                'type' => 'credit',
                'amount' => $amount,
                'description' => $description,
                'category' => $category,
                'metadata' => $metadata,
                'balance_after' => $user->balance,
            ]);
        });

        $this->refreshAccountBook($user->name);

        return $entry;
    }

    /**
     * Regenerate the user's pre-rendered Account book so the balance card and
     * ledger list reflect the mutation that just committed (and its library
     * timestamp bump makes clients refetch). Best-effort: a regen failure must
     * never fail the billing write itself — the freshness guard in
     * UserHomeServerController::generateAccountBookIfNeeded self-heals on the
     * next profile visit.
     */
    public function refreshAccountBook(string $username): void
    {
        try {
            app(\App\Http\Controllers\UserHomeServerController::class)->generateAccountBook($username);
        } catch (\Throwable $e) {
            Log::warning('Account book regeneration failed after billing mutation', [
                'username' => $username,
                'error' => $e->getMessage(),
            ]);
        }
    }

    public function getBalance(User $user): float
    {
        return $user->balance;
    }

    public function getLedger(User $user, ?int $limit = 50): Collection
    {
        return $user->ledgerEntries()
            ->orderByDesc('created_at')
            ->limit($limit)
            ->get();
    }
}
