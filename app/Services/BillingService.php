<?php

namespace App\Services;

use App\Models\BillingLedger;
use App\Models\User;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

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
        return DB::transaction(function () use ($user, $amount, $description, $category, $lineItems, $metadata) {
            DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);

            $user = User::lockForUpdate()->find($user->id);

            $multiplier = $user->getBillingMultiplier();

            $metadata = array_merge($metadata ?? [], [
                'raw_cost'   => round($amount, 4),
                'multiplier' => $multiplier,
                'tier'       => $user->status,
            ]);

            $chargedAmount = round($amount * $multiplier, 4);
            $isPremium = $user->status === 'premium';

            if (!$isPremium) {
                $user->increment('debits', $chargedAmount);
            }
            $user->refresh();

            return BillingLedger::create([
                'user_id'       => $user->id,
                'type'          => 'debit',
                'amount'        => $chargedAmount,
                'description'   => $description,
                'category'      => $category,
                'line_items'    => !empty($lineItems) ? $lineItems : null,
                'metadata'      => $metadata,
                'balance_after' => $user->balance,
            ]);
        });
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
     * Add credits to a user.
     */
    public function addCredits(
        User $user,
        float $amount,
        string $description,
        string $category = 'topup',
        ?array $metadata = null,
    ): BillingLedger {
        return DB::transaction(function () use ($user, $amount, $description, $category, $metadata) {
            DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);

            $user = User::lockForUpdate()->find($user->id);

            $user->increment('credits', $amount);
            $user->refresh();

            return BillingLedger::create([
                'user_id'       => $user->id,
                'type'          => 'credit',
                'amount'        => $amount,
                'description'   => $description,
                'category'      => $category,
                'metadata'      => $metadata,
                'balance_after' => $user->balance,
            ]);
        });
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
