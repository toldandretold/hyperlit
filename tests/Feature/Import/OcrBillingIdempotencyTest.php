<?php

/**
 * Layer 2a of "make PDF import survive a Mistral OCR hiccup".
 *
 * PDF-import OCR billing lives in BillingService::billOcrForBook (shared with
 * the source harvester). ProcessDocumentImportJob::handle() re-runs on every
 * retry ($tries > 1), so without a guard a retry would charge the user AGAIN
 * for the same OCR. The guard is a per-book {path}/ocr_charged.json marker:
 * bill once, write the marker, and skip if it already exists.
 *
 * Crucially the guard is keyed on the BOOK, not the attempt number — an early
 * attempt can die BEFORE reaching billing, so "only bill on attempt 1" would
 * under-charge. These tests lock: exactly-one charge across re-runs, and zero
 * charges when the marker already exists (the reconvert-from-OCR-cache case).
 *
 * We partial-mock BillingService so the REAL billOcrForBook (marker guard +
 * pricing) runs while charge() is stubbed — isolating the guard from the DB and
 * account-book regeneration.
 */

use App\Models\BillingLedger;
use App\Models\User;
use App\Services\BillingService;
use Illuminate\Support\Facades\File;

/** A partial-mock billing service whose charge() is stubbed but billOcrForBook is real. */
function ocrBillingMock(): BillingService
{
    return Mockery::mock(BillingService::class)->makePartial();
}

/** A book dir with a real OCR response (N pages) so pricing math runs. */
function makeOcrBookDir(int $pages): array
{
    $bookId = 'ocrbill-' . uniqid();
    $path = sys_get_temp_dir() . '/' . $bookId;
    File::ensureDirectoryExists($path);
    File::put("{$path}/ocr_response.json", json_encode([
        'pages' => array_fill(0, $pages, ['markdown' => 'x']),
    ]));
    return [$bookId, $path];
}

beforeEach(function () {
    // Pricing must be present or billOcrForBook bails before charging.
    config(['services.llm.pricing.mistral-ocr-latest.per_1k_pages' => 20]);
});

it('bills OCR exactly once even when billOcrForBook re-runs (job retry)', function () {
    [$bookId, $path] = makeOcrBookDir(3);

    $user = Mockery::mock(User::class);
    $billing = ocrBillingMock();
    // the whole point — one charge, not two — returns a ledger-shaped object.
    $billing->shouldReceive('charge')->once()->andReturn(new BillingLedger(['amount' => 0.06]));

    // First call: charges + writes the marker.
    $billing->billOcrForBook($user, $bookId, $path);
    expect(File::exists("{$path}/ocr_charged.json"))->toBeTrue();

    // Retry: billOcrForBook called again → MUST NOT charge again.
    // Mockery's ->once() expectation fails at teardown if it did.
    $billing->billOcrForBook($user, $bookId, $path);

    File::deleteDirectory($path);
});

it('never charges when the ocr_charged marker already exists (reconvert-from-cache)', function () {
    [$bookId, $path] = makeOcrBookDir(3);
    // Simulate the marker left by a prior successful billing (OCR cache reused, no
    // fresh OCR cost) — reconvert-from-cache keeps this marker, so no re-charge.
    File::put("{$path}/ocr_charged.json", json_encode(['book' => $bookId]));

    $user = Mockery::mock(User::class);
    $billing = ocrBillingMock();
    $billing->shouldReceive('charge')->never();

    expect($billing->billOcrForBook($user, $bookId, $path))->toBe(0.0);

    File::deleteDirectory($path);
});
