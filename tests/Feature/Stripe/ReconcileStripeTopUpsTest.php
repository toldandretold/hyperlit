<?php

/**
 * billing:reconcile-stripe — the webhook safety net.
 *
 * Proves a paying user is never left uncredited: for a locally-recorded pending
 * session that Stripe says is PAID, the sweep credits it (idempotently, atomic),
 * flips the tracking row to 'credited', and alerts the admin about anything it
 * cannot credit. Stripe is faked (StripeSessionGateway is bound), so no network.
 *
 * Seeds + asserts via pgsql_admin: the command runs outside any user session and
 * writes on the admin connection, which needs COMMITTED rows.
 */

use App\Mail\StripeTopUpStuckMail;
use App\Services\Billing\StripeSessionGateway;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;

const RC_PREFIX = 'rc_recon_';

function rcAdmin()
{
    return DB::connection('pgsql_admin');
}

function rcCleanup(): void
{
    rcAdmin()->table('stripe_checkout_sessions')->where('session_id', 'like', 'cs_rc_%')->delete();
    $ids = rcAdmin()->table('users')->where('name', 'like', RC_PREFIX.'%')->pluck('id');
    if ($ids->isNotEmpty()) {
        rcAdmin()->table('billing_ledger')->whereIn('user_id', $ids)->delete();
        rcAdmin()->table('users')->whereIn('id', $ids)->delete();
    }
}

beforeEach(fn () => rcCleanup());
afterEach(fn () => rcCleanup());

function rcSeedUser(float $credits = 0.0): object
{
    $name = RC_PREFIX.uniqid();
    $id = rcAdmin()->table('users')->insertGetId([
        'name' => $name, 'email' => $name.'@test.local', 'email_verified_at' => now(),
        'password' => Hash::make('password'), 'user_token' => (string) Str::uuid(),
        'status' => 'budget', 'credits' => $credits, 'debits' => 0,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    return (object) ['id' => $id, 'name' => $name];
}

/** Insert a pending checkout-session row. $ageMin = how long ago it was created. */
function rcSeedSession(int $userId, float $amount, int $ageMin = 60): string
{
    $sid = 'cs_rc_'.Str::random(12);
    rcAdmin()->table('stripe_checkout_sessions')->insert([
        'session_id' => $sid, 'user_id' => $userId, 'credit_amount' => $amount,
        'status' => 'pending', 'attempts' => 0,
        'created_at' => now()->subMinutes($ageMin), 'updated_at' => now()->subMinutes($ageMin),
    ]);

    return $sid;
}

/** Bind a fake Stripe gateway returning the given session objects, keyed by id. */
function rcFakeStripe(array $byId): void
{
    $fake = new class($byId) extends StripeSessionGateway {
        public function __construct(private array $byId) {}

        public function retrieve(string $sessionId): ?object
        {
            return $this->byId[$sessionId] ?? null;
        }
    };
    app()->instance(StripeSessionGateway::class, $fake);
}

function rcPaid(): object
{
    return (object) ['payment_status' => 'paid', 'status' => 'complete'];
}

function rcCredits(int $id): float
{
    return (float) rcAdmin()->table('users')->where('id', $id)->value('credits');
}

function rcSessionStatus(string $sid): ?string
{
    return rcAdmin()->table('stripe_checkout_sessions')->where('session_id', $sid)->value('status');
}

it('credits a paid-but-uncredited pending session and marks it credited', function () {
    $user = rcSeedUser(0);
    $sid = rcSeedSession($user->id, 25, ageMin: 60);
    rcFakeStripe([$sid => rcPaid()]);

    $this->artisan('billing:reconcile-stripe')->assertExitCode(0);

    expect(rcCredits($user->id))->toBe(25.0);
    expect(rcSessionStatus($sid))->toBe('credited');
    expect((int) rcAdmin()->table('billing_ledger')->where('user_id', $user->id)->where('category', 'stripe_topup')->count())->toBe(1);
});

it('is idempotent — never double-credits a session already in the ledger', function () {
    $user = rcSeedUser(0);
    $sid = rcSeedSession($user->id, 25, ageMin: 60);
    rcFakeStripe([$sid => rcPaid()]);

    // Two sweeps (or a webhook + a sweep) must credit exactly once.
    $this->artisan('billing:reconcile-stripe')->assertExitCode(0);
    $this->artisan('billing:reconcile-stripe')->assertExitCode(0);

    expect(rcCredits($user->id))->toBe(25.0);
    expect((int) rcAdmin()->table('billing_ledger')->where('user_id', $user->id)->where('category', 'stripe_topup')->count())->toBe(1);
});

it('skips a session still inside the grace period', function () {
    $user = rcSeedUser(0);
    $sid = rcSeedSession($user->id, 25, ageMin: 1); // newer than the 5-min grace
    rcFakeStripe([$sid => rcPaid()]);

    $this->artisan('billing:reconcile-stripe')->assertExitCode(0);

    expect(rcCredits($user->id))->toBe(0.0);
    expect(rcSessionStatus($sid))->toBe('pending');
});

it('marks an expired unpaid session expired and credits nothing', function () {
    $user = rcSeedUser(0);
    $sid = rcSeedSession($user->id, 25, ageMin: 60);
    rcFakeStripe([$sid => (object) ['payment_status' => 'unpaid', 'status' => 'expired']]);

    $this->artisan('billing:reconcile-stripe')->assertExitCode(0);

    expect(rcCredits($user->id))->toBe(0.0);
    expect(rcSessionStatus($sid))->toBe('expired');
});

it('alerts the admin about a paid session it cannot credit', function () {
    Mail::fake();
    // A session for a user id that does not exist → applyCredit returns user_not_found.
    $ghostUserId = 2000000000;
    $sid = rcSeedSession($ghostUserId, 25, ageMin: 60);
    rcFakeStripe([$sid => rcPaid()]);

    $this->artisan('billing:reconcile-stripe')->assertExitCode(0);

    // StripeTopUpStuckMail implements ShouldQueue → captured as queued under Mail::fake.
    Mail::assertQueued(StripeTopUpStuckMail::class);
    // Alerted + attempted, but still pending (nothing to credit).
    $row = rcAdmin()->table('stripe_checkout_sessions')->where('session_id', $sid)->first();
    expect($row->status)->toBe('pending');
    expect($row->alerted_at)->not->toBeNull();
    expect((int) $row->attempts)->toBeGreaterThan(0);
});
