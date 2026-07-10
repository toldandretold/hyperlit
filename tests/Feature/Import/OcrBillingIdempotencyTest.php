<?php

/**
 * Layer 2a of "make PDF import survive a Mistral OCR hiccup".
 *
 * Raising ProcessDocumentImportJob::$tries from 1 → 3 means handle() — and with it
 * billOcrImport() — re-runs on every retry. BillingService::charge() has no
 * idempotency of its own, so without a guard a retry would charge the user AGAIN for
 * the same OCR. The guard is a per-book {path}/ocr_charged.json marker: bill once,
 * write the marker, and skip if it already exists.
 *
 * Crucially the guard is keyed on the BOOK, not $this->attempts() — an early attempt
 * can die BEFORE reaching billing, so "only bill on attempt 1" would under-charge.
 * These tests lock: exactly-one charge across re-runs, and zero charges when the
 * marker already exists (the reconvert-from-OCR-cache case).
 *
 * billOcrImport() takes the BillingService as a param and forwards $user straight to
 * charge(), so we mock BillingService and never touch the DB or the account-book
 * regeneration — this isolates the marker guard itself.
 */

use App\Jobs\ProcessDocumentImportJob;
use App\Models\User;
use App\Services\BillingService;
use Illuminate\Support\Facades\File;

/** Reflection call into the private guard under test. */
function invokeBillOcr(ProcessDocumentImportJob $job, User $user, string $bookId, string $path, BillingService $billing): void
{
    $ref = new ReflectionMethod($job, 'billOcrImport');
    $ref->setAccessible(true);
    $ref->invoke($job, $user, $bookId, $path, $billing);
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
    // Pricing must be present or billOcrImport bails before charging.
    config(['services.llm.pricing.mistral-ocr-latest.per_1k_pages' => 20]);
});

it('bills OCR exactly once even when billOcrImport re-runs (job retry)', function () {
    [$bookId, $path] = makeOcrBookDir(3);

    $user = Mockery::mock(User::class);
    $billing = Mockery::mock(BillingService::class);
    $billing->shouldReceive('charge')->once(); // the whole point — one charge, not two

    $job = new ProcessDocumentImportJob($bookId, 'pdf', 42, [], []);

    // First attempt: charges + writes the marker.
    invokeBillOcr($job, $user, $bookId, $path, $billing);
    expect(File::exists("{$path}/ocr_charged.json"))->toBeTrue();

    // Retry: handle() re-runs → billOcrImport called again → MUST NOT charge again.
    // Mockery's ->once() expectation fails at teardown if it did.
    invokeBillOcr($job, $user, $bookId, $path, $billing);

    File::deleteDirectory($path);
});

it('never charges when the ocr_charged marker already exists (reconvert-from-cache)', function () {
    [$bookId, $path] = makeOcrBookDir(3);
    // Simulate the marker left by a prior successful billing (OCR cache reused, no
    // fresh OCR cost) — reconvert-from-cache keeps this marker, so no re-charge.
    File::put("{$path}/ocr_charged.json", json_encode(['book' => $bookId]));

    $user = Mockery::mock(User::class);
    $billing = Mockery::mock(BillingService::class);
    $billing->shouldReceive('charge')->never();

    $job = new ProcessDocumentImportJob($bookId, 'pdf', 42, [], []);
    invokeBillOcr($job, $user, $bookId, $path, $billing);

    File::deleteDirectory($path);
});
