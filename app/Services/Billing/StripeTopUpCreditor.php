<?php

namespace App\Services\Billing;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The ONE definition of "apply a paid Stripe top-up to a user's balance".
 *
 * Both the webhook (StripeController::handleWebhook) and the reconciliation
 * sweep (billing:reconcile-stripe) call this, so the money operation is written
 * once. It is:
 *
 *  - IDEMPOTENT — keyed on the billing_ledger row tagged with the session id, so
 *    a webhook + a reconcile (or two reconciles) for the same session credit at
 *    most once. This is what makes Stripe's retries and our sweep safe together.
 *  - ATOMIC — the credit increment, the ledger row, and the local
 *    stripe_checkout_sessions status flip commit together or not at all, on ONE
 *    pgsql_admin transaction (a transaction on the DEFAULT connection would
 *    govern a connection none of these writes use and roll back nothing).
 *  - ADMIN-CONNECTION — the caller runs with no user session (webhook / cron),
 *    so RLS is bypassed via pgsql_admin; the user is looked up the same way.
 *
 * A credit is ONLY ever applied from a Stripe-verified fact (a signed webhook,
 * or a session the reconciler fetched from Stripe's API) — never from
 * client-submitted data, so it cannot be forged by a user.
 */
class StripeTopUpCreditor
{
    public const CREDITED = 'credited';
    public const DUPLICATE = 'duplicate';
    public const USER_NOT_FOUND = 'user_not_found';

    /**
     * @return self::CREDITED|self::DUPLICATE|self::USER_NOT_FOUND
     */
    public function applyCredit(int $userId, float $amount, string $sessionId): string
    {
        $admin = DB::connection('pgsql_admin');

        // Idempotency: this session already produced a ledger row → do nothing.
        $already = $admin->selectOne(
            "SELECT 1 FROM billing_ledger WHERE category = 'stripe_topup' AND metadata->>'stripe_session_id' = ?",
            [$sessionId],
        );
        if ($already) {
            // Keep the tracking row consistent even if only the status flip was
            // ever lost (credit + ledger already durably happened).
            $admin->table('stripe_checkout_sessions')
                ->where('session_id', $sessionId)
                ->where('status', '!=', self::CREDITED)
                ->update(['status' => self::CREDITED, 'credited_at' => now(), 'updated_at' => now()]);

            return self::DUPLICATE;
        }

        $user = $admin->table('users')->where('id', $userId)->first();
        if (! $user) {
            return self::USER_NOT_FOUND;
        }

        $admin->transaction(function () use ($admin, $userId, $amount, $sessionId) {
            $admin->table('users')->where('id', $userId)->increment('credits', $amount);

            $updated = $admin->table('users')->where('id', $userId)->first();

            $admin->table('billing_ledger')->insert([
                'id'            => Str::uuid()->toString(),
                'user_id'       => $userId,
                'type'          => 'credit',
                'amount'        => $amount,
                'description'   => 'Stripe top-up',
                'category'      => 'stripe_topup',
                'metadata'      => json_encode(['stripe_session_id' => $sessionId]),
                'balance_after' => (float) $updated->credits - (float) $updated->debits,
                'created_at'    => now(),
            ]);

            // updateOrInsert so a session created before this table existed (or
            // whose create-time record failed) is still recorded as credited.
            $admin->table('stripe_checkout_sessions')->updateOrInsert(
                ['session_id' => $sessionId],
                [
                    'user_id'       => $userId,
                    'credit_amount' => $amount,
                    'status'        => self::CREDITED,
                    'credited_at'   => now(),
                    'last_error'    => null,
                    'updated_at'    => now(),
                ],
            );
        });

        return self::CREDITED;
    }
}
