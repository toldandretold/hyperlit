<?php

/**
 * Stripe top-up webhook ATOMICITY (StripeController::handleWebhook).
 *
 * The webhook does TWO writes that must be all-or-nothing: increment
 * `users.credits`, then insert the `billing_ledger` row. Both go through
 * pgsql_admin, and the idempotency probe keys on the ledger row — so if the
 * credit landed but the ledger insert failed, a Stripe RETRY (which fires on a
 * non-2xx response) would find no ledger row and CREDIT THE USER AGAIN.
 *
 * The wrapper must therefore be a transaction ON the pgsql_admin connection (a
 * `DB::transaction` on the DEFAULT connection governs a connection nothing here
 * writes to and rolls back NOTHING). This test forces the SECOND write to fail
 * and proves the credit rolls back.
 *
 * Fault injection is DATA-level, not DDL: the user is seeded with a large
 * negative `debits`, so the webhook's `balance_after = credits - debits`
 * overflows the `decimal(10,4)` ledger column and the INSERT throws — AFTER the
 * credit increment has run. (A trigger-based fault is impossible here: the
 * webhook's idempotency SELECT holds an ACCESS SHARE lock on billing_ledger on
 * the DEFAULT connection for the whole RefreshDatabase transaction, so any
 * CREATE/DROP TRIGGER on that table blocks forever.)
 *
 * Seeds + asserts via pgsql_admin: the webhook runs with no user session, looks
 * the user up through a SECURITY DEFINER, and writes on the admin connection —
 * all of which need COMMITTED rows, invisible to a default-connection seed.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

const WA_PREFIX = 'wa_atomic_';

// decimal(10,4): a balance_after magnitude at/above 1e6 overflows the column.
// credits(25) - debits(-999999.9999) = 1000024.9999 → overflow on the INSERT.
const WA_OVERFLOW_DEBITS = -999999.9999;

function waAdmin()
{
    return DB::connection('pgsql_admin');
}

function waCleanup(): void
{
    $ids = waAdmin()->table('users')->where('name', 'like', WA_PREFIX.'%')->pluck('id');
    if ($ids->isNotEmpty()) {
        waAdmin()->table('billing_ledger')->whereIn('user_id', $ids)->delete();
        waAdmin()->table('users')->whereIn('id', $ids)->delete();
    }
}

beforeEach(fn () => waCleanup());
afterEach(fn () => waCleanup());

function waSeedUser(float $credits = 0.0, float $debits = 0.0): object
{
    $name = WA_PREFIX.uniqid();
    $id = waAdmin()->table('users')->insertGetId([
        'name' => $name,
        'email' => $name.'@test.local',
        'email_verified_at' => now(),
        'password' => Hash::make('password'),
        'user_token' => (string) Str::uuid(),
        'status' => 'budget',
        'credits' => $credits,
        'debits' => $debits,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return (object) ['id' => $id, 'name' => $name];
}

/** A genuinely Stripe-signed checkout.session.completed event for this top-up. */
function waSignedWebhook(int $userId, float $amount, string $sessionId): array
{
    $payload = json_encode([
        'id' => 'evt_'.Str::random(10),
        'object' => 'event',
        'type' => 'checkout.session.completed',
        'data' => ['object' => [
            'id' => $sessionId,
            'object' => 'checkout.session',
            'metadata' => ['user_id' => (string) $userId, 'credit_amount' => (string) $amount],
        ]],
    ]);
    $t = time();
    $secret = config('services.stripe.webhook_secret');
    $sig = hash_hmac('sha256', "{$t}.{$payload}", $secret);

    return [$payload, "t={$t},v1={$sig}"];
}

function waPost($test, string $payload, string $sig)
{
    return $test->call('POST', '/api/stripe/webhook', [], [], [], [
        'HTTP_STRIPE_SIGNATURE' => $sig,
        'CONTENT_TYPE' => 'application/json',
    ], $payload);
}

function waCredits(int $id): float
{
    return (float) waAdmin()->table('users')->where('id', $id)->value('credits');
}

it('rolls the credit back when the ledger insert fails, so a Stripe retry cannot double-credit', function () {
    // Force the SECOND write (billing_ledger insert) to fail: this user's
    // balance_after (credits - debits) overflows the decimal(10,4) column, so the
    // INSERT throws AFTER the credit increment has already run inside the webhook.
    $user = waSeedUser(0, WA_OVERFLOW_DEBITS);
    [$payload, $sig] = waSignedWebhook($user->id, 25, 'cs_'.Str::random(12));
    $resp = waPost($this, $payload, $sig);

    // A 500 proves the webhook got PAST signature/idempotency/user-lookup and
    // failed at the DB write — i.e. it genuinely tried to credit (not a silent
    // no-op from a bad signature, which would also leave 0 credits).
    expect($resp->getStatusCode())->toBe(500);

    // Atomic: the failed ledger insert rolled the credit increment back too.
    // Without this (a DB::transaction on the wrong connection), the credit would
    // stick with no ledger row — and because the idempotency probe keys on that
    // missing row, a Stripe retry would credit the user AGAIN.
    expect(waCredits($user->id))->toBe(0.0);
    expect((int) waAdmin()->table('billing_ledger')->where('user_id', $user->id)->count())->toBe(0);
});
