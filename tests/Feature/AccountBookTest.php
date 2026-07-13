<?php

/**
 * Guards the Account pseudo-book (`{sanitized}Account`) that backs the
 * profile page's Account tab.
 *
 * The balance card bakes users.credits/debits/tier + billing_ledger rows into
 * pre-rendered nodes, so it MUST be regenerated when billing data changes:
 *   - eagerly, after every billing mutation (BillingService::charge/addCredits,
 *     the Stripe top-up webhook, updateTier) — this bumps library.timestamp,
 *     which is what makes SPA clients refetch (loadHyperText.ts),
 *   - and as a failsafe, by the per-visit freshness guard
 *     (generateAccountBookIfNeeded) when a billing input is newer than the
 *     book — regenerate once, then settle.
 * The original bug: the book was only generated when its library row was
 * missing, so a user who topped up after their first visit saw $0 forever.
 *
 * Cross-connection caveat: RefreshDatabase wraps only the DEFAULT connection
 * in a transaction. BillingService::charge/addCredits write users/billing_ledger
 * on the default connection — invisible to pgsql_admin inside a test — so the
 * regeneration a real charge triggers would bake pre-transaction values here.
 * Those two paths are therefore asserted via a container spy (the wiring),
 * while generator correctness and the admin-connection paths (Stripe webhook,
 * updateTier, the guard) get full content assertions.
 */

use App\Http\Controllers\UserHomeServerController;
use App\Models\BillingLedger;
use App\Models\User;
use App\Services\BillingService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

require_once __DIR__ . '/HomeBookTestHelpers.php';

beforeEach(fn () => hbCleanup());
afterEach(fn () => hbCleanup());

/** Seed a billing user via pgsql_admin (bypasses RLS on insert). */
function abSeedUser(float $credits = 0, float $debits = 0, string $status = 'budget'): object
{
    $username = HB_TEST_USER_PREFIX . uniqid();
    $token = (string) Str::uuid();
    $id = hbAdmin()->table('users')->insertGetId([
        'name' => $username,
        'email' => $username . '@test.local',
        'email_verified_at' => now(),
        'password' => Hash::make('password'),
        'user_token' => $token,
        'status' => $status,
        'credits' => $credits,
        'debits' => $debits,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return (object) ['id' => $id, 'name' => $username, 'token' => $token];
}

/**
 * Seed a billing user on the DEFAULT connection, inside RefreshDatabase's
 * transaction. Required for tests that run BillingService::charge/addCredits
 * for real: those hold row locks on `users` until the test's transaction
 * rolls back, and rows seeded via pgsql_admin are committed — so hbCleanup's
 * admin-connection DELETE in afterEach would block on the lock forever (the
 * cross-connection teardown deadlock InteractsWithApi::makeBook documents).
 * A default-connection row is uncommitted: invisible to the admin cleanup
 * (no lock collision) and discarded by the rollback.
 *
 * Sets app.current_user/app.current_token (transaction-local) first so the
 * INSERT's RETURNING and charge()'s SELECT/UPDATE pass the users RLS policies.
 */
function abSeedUserOnDefault(float $credits = 0, float $debits = 0, string $status = 'budget'): object
{
    $username = HB_TEST_USER_PREFIX . uniqid();
    $token = (string) Str::uuid();

    DB::statement("SELECT set_config('app.current_user', ?, true)", [$username]);
    DB::statement("SELECT set_config('app.current_token', ?, true)", [$token]);

    $id = DB::table('users')->insertGetId([
        'name' => $username,
        'email' => $username . '@test.local',
        'email_verified_at' => now(),
        'password' => Hash::make('password'),
        'user_token' => $token,
        'status' => $status,
        'credits' => $credits,
        'debits' => $debits,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return (object) ['id' => $id, 'name' => $username, 'token' => $token];
}

function abSeedLedger(int $userId, string $type, float $amount, ?\Carbon\Carbon $createdAt = null, string $desc = 'test entry', string $cat = 'topup'): string
{
    $id = (string) Str::uuid();
    hbAdmin()->table('billing_ledger')->insert([
        'id' => $id,
        'user_id' => $userId,
        'type' => $type,
        'amount' => $amount,
        'description' => $desc,
        'category' => $cat,
        'balance_after' => 0,
        'created_at' => $createdAt ?? now(),
    ]);
    return $id;
}

function abAccountBook(string $username): string
{
    return str_replace(' ', '', $username) . 'Account';
}

function abBalanceNode(string $username): ?object
{
    $book = abAccountBook($username);
    return hbAdmin()->table('nodes')
        ->where('book', $book)
        ->where('node_id', $book . '_balance_card')
        ->first();
}

/** The Account book's library.timestamp — bumped only when (re)generated. */
function abAccountTs(string $username): int
{
    return (int) hbAdmin()->table('library')->where('book', abAccountBook($username))->value('timestamp');
}

/** A fingerprint of the Account book's nodes that changes iff delete+reinserted. */
function abNodeFingerprint(string $username): string
{
    $rows = hbAdmin()->table('nodes')->where('book', abAccountBook($username))->orderBy('id')->pluck('id')->all();
    return implode(',', $rows);
}

/** Invoke the private failsafe guard the way show() does. */
function abInvokeGuard(string $username): void
{
    $controller = app(UserHomeServerController::class);
    $m = (new ReflectionClass($controller))->getMethod('generateAccountBookIfNeeded');
    $m->setAccessible(true);
    $m->invoke($controller, $username);
}

function abUserModel(string $username): User
{
    return User::on('pgsql_admin')->where('name', $username)->firstOrFail();
}

test('generateAccountBook bakes the correct balance, tier and ledger into the nodes', function () {
    $user = abSeedUser(credits: 20, debits: 5.5, status: 'solidarity');
    abSeedLedger($user->id, 'credit', 20, desc: 'top up', cat: 'topup');
    abSeedLedger($user->id, 'debit', 5.5, desc: 'ocr run', cat: 'ocr');

    app(UserHomeServerController::class)->generateAccountBook($user->name);

    $balance = abBalanceNode($user->name);
    expect($balance)->not->toBeNull();
    expect($balance->content)->toContain('Balance: $14.50');
    expect($balance->content)->toContain('Credits: $20.00');
    expect($balance->content)->toContain('Debits: $5.50');
    expect($balance->content)->toContain('data-current-tier="solidarity"');
    expect($balance->plainText)->toContain('Balance: $14.50');

    $ledgerContents = hbAdmin()->table('nodes')
        ->where('book', abAccountBook($user->name))
        ->where('content', 'like', '%ledgerEntry%')
        ->pluck('content')
        ->implode("\n");
    expect($ledgerContents)->toContain('+$20.00');
    expect($ledgerContents)->toContain('-$5.50');

    // Self-stability precondition: the book's timestamp incorporates the
    // newest ledger row (floored to ms, same expression as the guard).
    $newestLedgerMs = (int) hbAdmin()->table('billing_ledger')
        ->where('user_id', $user->id)
        ->selectRaw('floor(extract(epoch from max(created_at)) * 1000)::bigint AS ts')
        ->value('ts');
    expect(abAccountTs($user->name))->toBeGreaterThanOrEqual($newestLedgerMs);
});

test('the guard generates a missing account book', function () {
    $user = abSeedUser(credits: 3);

    expect(hbAdmin()->table('library')->where('book', abAccountBook($user->name))->exists())->toBeFalse();

    abInvokeGuard($user->name);

    expect(hbAdmin()->table('library')->where('book', abAccountBook($user->name))->exists())->toBeTrue();
    expect(abBalanceNode($user->name)->content)->toContain('Credits: $3.00');
});

test('a ledger row newer than the account book triggers exactly one regeneration, then settles', function () {
    $user = abSeedUser(credits: 5);
    app(UserHomeServerController::class)->generateAccountBook($user->name);
    $fpBefore = abNodeFingerprint($user->name);

    // Simulate a MISSED eager regen: a ledger row lands with a created_at
    // ahead of the book's timestamp, without the book being rebuilt.
    abSeedLedger($user->id, 'credit', 5, createdAt: now()->addSeconds(5), desc: 'missed top up');

    // First visit after the drift → one regeneration, new entry visible.
    abInvokeGuard($user->name);
    $fpAfter = abNodeFingerprint($user->name);
    expect($fpAfter)->not->toBe($fpBefore);
    $contents = hbAdmin()->table('nodes')->where('book', abAccountBook($user->name))->pluck('content')->implode("\n");
    expect($contents)->toContain('missed top up');

    // It must SETTLE: the next visit does nothing (book ts now >= ledger ts).
    abInvokeGuard($user->name);
    expect(abNodeFingerprint($user->name))->toBe($fpAfter);
});

test('an unchanged visit does NOT regenerate the account book', function () {
    $user = abSeedUser(credits: 5);
    abSeedLedger($user->id, 'credit', 5);
    app(UserHomeServerController::class)->generateAccountBook($user->name);

    $tsBefore = abAccountTs($user->name);
    $fpBefore = abNodeFingerprint($user->name);

    abInvokeGuard($user->name);
    abInvokeGuard($user->name);

    expect(abAccountTs($user->name))->toBe($tsBefore);
    expect(abNodeFingerprint($user->name))->toBe($fpBefore);
});

test('a REAL owner visit to /u/{username} runs the guard, and the reader pull API serves the fresh book', function () {
    // The last hop the other tests trust but don't assert: (1) the browser's
    // actual user-page route (not a reflection call) triggers the freshness
    // guard for the owner, and (2) the endpoint the reader's loading path
    // fetches (loadHyperText → serverSync/pull.ts → /api/database-to-indexeddb/
    // books/{book}/data) returns the regenerated content, RLS-gated as the owner.
    $user = abSeedUser(credits: 5);
    app(UserHomeServerController::class)->generateAccountBook($user->name);
    $fpBefore = abNodeFingerprint($user->name);

    // Drift: a missed eager regen — a ledger row newer than the book.
    abSeedLedger($user->id, 'credit', 5, createdAt: now()->addSeconds(5), desc: 'visit guard top up');

    // Real HTTP GET to the page the browser loads (user.blade.php).
    $this->actingAs(abUserModel($user->name))->get('/u/' . $user->name)->assertOk();

    // show() ran the guard: the account book was rebuilt with the new entry.
    expect(abNodeFingerprint($user->name))->not->toBe($fpBefore);

    // And the reader's pull endpoint serves that fresh content to the client.
    $resp = $this->actingAs(abUserModel($user->name))
        ->getJson('/api/database-to-indexeddb/books/' . abAccountBook($user->name) . '/data');
    $resp->assertOk();
    $payload = json_encode($resp->json());
    expect($payload)->toContain('visit guard top up');
    expect($payload)->toContain('Balance: $5.00');
});

test('charge() regenerates the account book after the billing transaction', function () {
    $user = abSeedUserOnDefault(credits: 10);
    $spy = $this->spy(UserHomeServerController::class);

    $entry = app(BillingService::class)->charge(User::findOrFail($user->id), 1.0, 'test charge', 'ocr');

    expect($entry)->toBeInstanceOf(BillingLedger::class);
    $spy->shouldHaveReceived('generateAccountBook')->once()->with($user->name);
});

test('addCredits() regenerates the account book after the billing transaction', function () {
    $user = abSeedUserOnDefault();
    $spy = $this->spy(UserHomeServerController::class);

    $entry = app(BillingService::class)->addCredits(User::findOrFail($user->id), 5.0, 'test top up');

    expect($entry)->toBeInstanceOf(BillingLedger::class);
    $spy->shouldHaveReceived('generateAccountBook')->once()->with($user->name);
});

test('a regeneration failure does not fail the billing write', function () {
    $user = abSeedUserOnDefault();
    $this->mock(UserHomeServerController::class, function ($mock) {
        $mock->shouldReceive('generateAccountBook')->andThrow(new RuntimeException('boom'));
    });

    $entry = app(BillingService::class)->addCredits(User::findOrFail($user->id), 5.0, 'test top up');

    expect($entry)->toBeInstanceOf(BillingLedger::class);
});

test('the Stripe webhook applies credits AND refreshes the account book', function () {
    config(['services.stripe.webhook_secret' => 'whsec_testsecret']);

    $user = abSeedUser();
    app(UserHomeServerController::class)->generateAccountBook($user->name);
    $tsBefore = abAccountTs($user->name);
    expect(abBalanceNode($user->name)->content)->toContain('Credits: $0.00');

    usleep(5000); // guarantee the regen lands in a later millisecond than $tsBefore

    $payload = json_encode([
        'id' => 'evt_test_1',
        'object' => 'event',
        'type' => 'checkout.session.completed',
        'data' => ['object' => [
            'id' => 'cs_test_' . uniqid(),
            'object' => 'checkout.session',
            'metadata' => ['user_id' => (string) $user->id, 'credit_amount' => '5'],
        ]],
    ]);
    $ts = time();
    $sig = 't=' . $ts . ',v1=' . hash_hmac('sha256', $ts . '.' . $payload, 'whsec_testsecret');

    $response = $this->call('POST', '/api/stripe/webhook', [], [], [], [
        'HTTP_STRIPE_SIGNATURE' => $sig,
        'CONTENT_TYPE' => 'application/json',
    ], $payload);

    $response->assertOk()->assertJson(['received' => true]);

    // Credits + ledger row landed (admin connection — webhook writes are committed).
    expect((float) hbAdmin()->table('users')->where('id', $user->id)->value('credits'))->toBe(5.0);
    expect(hbAdmin()->table('billing_ledger')->where('user_id', $user->id)->where('category', 'stripe_topup')->exists())->toBeTrue();

    // The account book was rebuilt with the new balance, and its library
    // timestamp bumped — the client-refetch trigger.
    $balance = abBalanceNode($user->name);
    expect($balance->content)->toContain('Credits: $5.00');
    expect($balance->content)->toContain('Balance: $5.00');
    expect(abAccountTs($user->name))->toBeGreaterThan($tsBefore);
});

test('updateTier refreshes the tier baked into the balance card', function () {
    $user = abSeedUser(credits: 5, status: 'budget');
    app(UserHomeServerController::class)->generateAccountBook($user->name);
    $tsBefore = abAccountTs($user->name);
    expect(abBalanceNode($user->name)->content)->toContain('data-current-tier="budget"');

    usleep(5000);

    $response = $this->actingAs(abUserModel($user->name))
        ->postJson('/api/billing/tier', ['tier' => 'capitalist']);

    $response->assertOk()->assertJson(['success' => true, 'tier' => 'capitalist']);

    expect(hbAdmin()->table('users')->where('id', $user->id)->value('status'))->toBe('capitalist');
    $balance = abBalanceNode($user->name);
    expect($balance->content)->toContain('data-current-tier="capitalist"');
    expect($balance->content)->toContain('Honest Capitalist');
    expect(abAccountTs($user->name))->toBeGreaterThan($tsBefore);
});
