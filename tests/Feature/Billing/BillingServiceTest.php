<?php

/**
 * BillingService — core money mechanics (docs/billing.md).
 *
 * Locks the charging contract every priced feature relies on:
 *   - charge() = raw cost × the user's tier multiplier → users.debits + a
 *     billing_ledger debit row (premium: ledger-only, debits untouched)
 *   - addCredits() = users.credits + a ledger credit row (Stripe's path)
 *   - reserveCredits()/releaseReservation() = a temporary hold that MUST come
 *     back off debits when the operation ends (the audiobook double-debit bug)
 *   - ocrPricePerKPages() = per-SERVED-model OCR pricing with config fallback
 *   - billOcrForBook() = pages/1000 × model rate, marker-idempotent, free for
 *     client-side ('hyperlit-' prefixed) OCR
 *
 * All assertions read the DEFAULT connection (the charge ran inside the test's
 * RefreshDatabase transaction — invisible to pgsql_admin) with the RLS session
 * context set, mirroring how HTTP middleware sets it in production.
 */

use App\Models\BillingLedger;
use App\Models\User;
use App\Services\BillingService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/** Set the RLS session context (both vars — users_select_policy needs BOTH). */
function billingSvcCtx(User $user): void
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
}

function billingSvcLedger(User $user, string $category)
{
    return DB::table('billing_ledger')
        ->where('user_id', $user->id)->where('category', $category)
        ->orderBy('created_at')->get();
}

beforeEach(function () {
    // Account-book regeneration is covered by AccountBookTest; no-op it here so
    // these tests don't commit account pseudo-books through pgsql_admin.
    $this->mock(\App\Http\Controllers\UserHomeServerController::class, function ($mock) {
        $mock->shouldReceive('generateAccountBook')->andReturnNull();
    });
});

// ---------------------------------------------------------------------------
// charge() — tier multiplier × raw cost → debits + ledger
// ---------------------------------------------------------------------------

it('charges each pay-as-you-go tier at its multiplier and records the debit', function (string $tier, float $multiplier) {
    $user = $this->seedUser(['status' => $tier, 'credits' => 10]);
    billingSvcCtx($user);

    $entry = app(BillingService::class)->charge($user, 1.00, 'Test charge', 'ocr');

    expect((float) $entry->amount)->toEqualWithDelta(1.00 * $multiplier, 0.0001);
    expect($entry->metadata['raw_cost'])->toEqualWithDelta(1.00, 0.0001);
    expect($entry->metadata['multiplier'])->toEqualWithDelta($multiplier, 0.0001);
    expect($entry->metadata['tier'])->toBe($tier);

    // SQL-level: the users.debits column moved by exactly the charged amount,
    // and the ledger snapshot agrees with credits - debits.
    $fresh = User::find($user->id);
    expect((float) $fresh->debits)->toEqualWithDelta(1.00 * $multiplier, 0.0001);
    expect((float) $entry->balance_after)->toEqualWithDelta(10 - 1.00 * $multiplier, 0.0001);

    $rows = billingSvcLedger($user, 'ocr');
    expect($rows)->toHaveCount(1);
    expect($rows[0]->type)->toBe('debit');
})->with([
    'budget'     => ['budget', 1.5],
    'solidarity' => ['solidarity', 2.0],
    'capitalist' => ['capitalist', 5.0],
]);

it('charges premium users to the ledger ONLY — debits never move', function () {
    $user = $this->seedUser(['status' => 'premium', 'credits' => 10]);
    billingSvcCtx($user);

    $entry = app(BillingService::class)->charge($user, 2.00, 'Premium usage', 'tts');

    expect((float) $entry->amount)->toEqualWithDelta(2.00, 0.0001); // 1.0×
    expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001);
    expect((float) $entry->balance_after)->toEqualWithDelta(10.0, 0.0001);
    expect(billingSvcLedger($user, 'tts'))->toHaveCount(1);
});

it('falls back to the budget multiplier for an unknown tier', function () {
    $user = $this->seedUser(['status' => 'no_such_tier', 'credits' => 10]);
    billingSvcCtx($user);

    $entry = app(BillingService::class)->charge($user, 1.00, 'Fallback tier', 'ocr');

    expect((float) $entry->amount)->toEqualWithDelta(1.50, 0.0001);
});

// ---------------------------------------------------------------------------
// addCredits() — the Stripe top-up path
// ---------------------------------------------------------------------------

it('addCredits raises users.credits and writes a credit ledger row', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 0]);
    billingSvcCtx($user);

    $entry = app(BillingService::class)->addCredits($user, 25.00, 'Stripe top-up', 'stripe_topup');

    expect($entry->type)->toBe('credit');
    expect((float) $entry->amount)->toEqualWithDelta(25.00, 0.0001);
    expect((float) User::find($user->id)->credits)->toEqualWithDelta(25.00, 0.0001);
    expect((float) $entry->balance_after)->toEqualWithDelta(25.00, 0.0001);
});

// ---------------------------------------------------------------------------
// reserveCredits() / releaseReservation() — the hold lifecycle
// ---------------------------------------------------------------------------

it('reserves a multiplied hold and releaseReservation gives it back exactly', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    billingSvcCtx($user);
    $billing = app(BillingService::class);

    $hold = $billing->reserveCredits($user, 2.00, 'Audio generation reservation: test');
    expect($hold)->not->toBeNull();
    expect((float) $hold->amount)->toEqualWithDelta(3.00, 0.0001); // 2.00 × 1.5
    expect($hold->metadata['reservation'])->toBeTrue();
    expect((float) User::find($user->id)->debits)->toEqualWithDelta(3.00, 0.0001);

    $billing->releaseReservation($user, $hold->id);

    // Debits fully restored, hold row gone — the user pays only the REAL charge.
    expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001);
    expect(billingSvcLedger($user, 'tts_reservation'))->toHaveCount(0);

    // Idempotent: releasing again (or a bogus id) is a no-op, never a refund.
    $billing->releaseReservation($user, $hold->id);
    $billing->releaseReservation($user, null);
    expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001);
});

it('releaseReservation refuses to reverse a REAL debit (reservation rows only)', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    billingSvcCtx($user);
    $billing = app(BillingService::class);

    $realCharge = $billing->charge($user, 1.00, 'Real work', 'ocr');
    $billing->releaseReservation($user, $realCharge->id);

    expect((float) User::find($user->id)->debits)->toEqualWithDelta(1.50, 0.0001);
    expect(billingSvcLedger($user, 'ocr'))->toHaveCount(1);
});

it('reserveCredits is skipped for premium and refused on empty balance', function () {
    $premium = $this->seedUser(['status' => 'premium', 'credits' => 0]);
    billingSvcCtx($premium);
    expect(app(BillingService::class)->reserveCredits($premium, 5.00, 'hold'))->toBeNull();
    expect((float) User::find($premium->id)->debits)->toEqualWithDelta(0.0, 0.0001);

    $broke = $this->seedUser(['status' => 'budget', 'credits' => 0]);
    billingSvcCtx($broke);
    expect(app(BillingService::class)->reserveCredits($broke, 5.00, 'hold'))->toBeNull();
    expect((float) User::find($broke->id)->debits)->toEqualWithDelta(0.0, 0.0001);
});

// ---------------------------------------------------------------------------
// ocrPricePerKPages() — per-served-model pricing
// ---------------------------------------------------------------------------

it('prices OCR by the served model and falls back to the pinned config model', function () {
    expect(BillingService::ocrPricePerKPages('mistral-ocr-2512'))->toEqualWithDelta(2.00, 0.0001);
    expect(BillingService::ocrPricePerKPages('mistral-ocr-4-0'))->toEqualWithDelta(4.00, 0.0001);
    expect(BillingService::ocrPricePerKPages('mistral-ocr-latest'))->toEqualWithDelta(4.00, 0.0001);

    // Unknown served id / no id at all → the pinned production model's rate.
    $pinned = config('services.mistral_ocr.model', 'mistral-ocr-2512');
    $pinnedRate = (float) config("services.llm.pricing.{$pinned}.per_1k_pages");
    expect(BillingService::ocrPricePerKPages('some-unknown-model'))->toEqualWithDelta($pinnedRate, 0.0001);
    expect(BillingService::ocrPricePerKPages(null))->toEqualWithDelta($pinnedRate, 0.0001);
});

// ---------------------------------------------------------------------------
// billOcrForBook() — real math end-to-end (pages × model rate × tier), marker
// idempotency, and the client-side free path
// ---------------------------------------------------------------------------

it('bills OCR at pages/1000 × the served model rate × tier, exactly once', function () {
    $user = $this->seedUser(['status' => 'solidarity', 'credits' => 10]);
    billingSvcCtx($user);

    $dir = storage_path('framework/testing/billing_ocr_' . uniqid());
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/ocr_response.json", json_encode([
        'model' => 'mistral-ocr-2512',
        'pages' => [['index' => 0], ['index' => 1], ['index' => 2]], // 3 pages
    ]));

    try {
        $charged = app(BillingService::class)->billOcrForBook($user, 'book_ocr_test', $dir);

        // 3/1000 × $2.00 = $0.006 raw → × 2.0 (solidarity) = $0.012
        expect($charged)->toEqualWithDelta(0.012, 0.0001);
        $rows = billingSvcLedger($user, 'ocr');
        expect($rows)->toHaveCount(1);
        expect((float) $rows[0]->amount)->toEqualWithDelta(0.012, 0.0001);
        expect(File::exists("{$dir}/ocr_charged.json"))->toBeTrue();

        // Marker idempotency: a retry / reconvert-from-cache never re-bills.
        expect(app(BillingService::class)->billOcrForBook($user, 'book_ocr_test', $dir))->toEqualWithDelta(0.0, 0.0001);
        expect(billingSvcLedger($user, 'ocr'))->toHaveCount(1);
    } finally {
        File::deleteDirectory($dir);
    }
});

it('never bills client-side OCR (hyperlit- model prefix) even without a marker', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    billingSvcCtx($user);

    $dir = storage_path('framework/testing/billing_ocr_' . uniqid());
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/ocr_response.json", json_encode([
        'model' => 'hyperlit-native-ocr',
        'pages' => [['index' => 0], ['index' => 1]],
    ]));

    try {
        expect(app(BillingService::class)->billOcrForBook($user, 'book_free_ocr', $dir))->toEqualWithDelta(0.0, 0.0001);
        expect(billingSvcLedger($user, 'ocr'))->toHaveCount(0);
        expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001);
    } finally {
        File::deleteDirectory($dir);
    }
});
