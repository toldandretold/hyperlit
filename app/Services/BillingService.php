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
     * Premium users: logs usage for tracking but doesn't debit.
     * Pay-as-you-go tiers: scales raw cost by tier multiplier and debits.
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
            $user = User::lockForUpdate()->find($user->id);

            $multiplier = $user->getBillingMultiplier();
            $isPremiumSub = $user->status === 'premium';

            $metadata = array_merge($metadata ?? [], [
                'raw_cost'   => round($amount, 4),
                'multiplier' => $multiplier,
                'tier'       => $user->status,
            ]);

            if ($isPremiumSub) {
                // Premium: log usage for data/analytics, zero debit
                return BillingLedger::create([
                    'user_id'       => $user->id,
                    'type'          => 'debit',
                    'amount'        => 0,
                    'description'   => $description,
                    'category'      => $category,
                    'line_items'    => !empty($lineItems) ? $lineItems : null,
                    'metadata'      => $metadata,
                    'balance_after' => $user->balance,
                ]);
            }

            // Pay-as-you-go: apply multiplier and debit
            $chargedAmount = round($amount * $multiplier, 4);

            $user->increment('debits', $chargedAmount);
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
