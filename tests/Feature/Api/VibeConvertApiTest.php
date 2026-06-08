<?php

/**
 * Vibe-convert endpoints (VibeConvertController) — per-document LLM re-conversion.
 *
 * async: VibeConversionJob (queue: vibe). Queue::fake() asserts dispatch without
 * running the Python job. Auth is auth:sanctum; billing gates the start (premium
 * OR balance>0 — see BillingService::canProceed).
 *
 * Progress / cancel / review are tracked as FILES under markdown/{book}/, which is
 * itself a concurrency hazard (findings F3) — concurrent runs clobber each other's
 * markers. start() has NO uniqueness guard at all (findings F1): two starts queue
 * two jobs against the same book, demonstrated below.
 */

use App\Jobs\VibeConversionJob;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

/** Seed the decision-trace start() requires (markdown/{book}/assessment.json). */
function seedVibeDecisionTrace(string $book): void
{
    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/assessment.json", json_encode(['ok' => true]));
}

afterEach(function () {
    $this->cleanupApiFixtures();
    foreach (glob(resource_path('markdown/apitest_*')) ?: [] as $dir) {
        if (is_dir($dir)) {
            File::deleteDirectory($dir);
        }
    }
});

/* ─── auth: every endpoint rejects a guest ────────────────────────── */

test('vibe-convert endpoints require authentication', function () {
    $this->assertApiError($this->postJson('/api/vibe-convert/start', ['bookId' => 'x']), 401);
    $this->assertApiError($this->getJson('/api/vibe-convert/progress/x'), 401);
    $this->assertApiError($this->postJson('/api/vibe-convert/cancel/x'), 401);
    $this->assertApiError($this->postJson('/api/vibe-convert/accept', ['bookId' => 'x']), 401);
    $this->assertApiError($this->postJson('/api/vibe-convert/use-now/x'), 401);
    $this->assertApiError($this->postJson('/api/vibe-convert/notify/x'), 401);
    $this->assertApiError($this->getJson('/api/vibe-convert/review/x'), 401);
    $this->assertApiError($this->postJson('/api/vibe-convert/review/x/keep'), 401);
    $this->assertApiError($this->postJson('/api/vibe-convert/review/x/reject'), 401);
});

/* ─── start: validation + gates ───────────────────────────────────── */

test('POST /api/vibe-convert/start validates that bookId is required', function () {
    $this->loginUser(['status' => 'premium']);
    $this->assertApiError($this->postJson('/api/vibe-convert/start', []), 422);
});

test('POST /api/vibe-convert/start 402s when the user has no balance', function () {
    // Billing is checked before the decision-trace existence check.
    $this->loginUser(['status' => 'free']);
    $this->assertApiError($this->postJson('/api/vibe-convert/start', ['bookId' => 'apitest_anything']), 402);
});

test('POST /api/vibe-convert/start 404s when the book has no decision-trace yet', function () {
    $this->loginUser(['status' => 'premium']);
    $this->assertApiError(
        $this->postJson('/api/vibe-convert/start', ['bookId' => 'apitest_notrace_' . Str::random(6)]),
        404
    );
});

/* ─── start: happy path + the missing uniqueness guard (F1) ───────── */

test('POST /api/vibe-convert/start dispatches the job when a decision-trace exists', function () {
    Queue::fake();
    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);
    seedVibeDecisionTrace($book);

    $this->postJson('/api/vibe-convert/start', ['bookId' => $book])
        ->assertStatus(200)
        ->assertJson(['success' => true]);

    Queue::assertPushed(VibeConversionJob::class, 1);
});

test('POST /api/vibe-convert/start has NO in-flight guard — two starts queue two jobs', function () {
    Queue::fake();
    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);
    seedVibeDecisionTrace($book);

    $this->postJson('/api/vibe-convert/start', ['bookId' => $book])->assertStatus(200);
    $this->postJson('/api/vibe-convert/start', ['bookId' => $book])->assertStatus(200);

    // Characterization: today both succeed and TWO jobs are queued for one book.
    // This is the gap recorded as findings F1 (no ShouldBeUnique / lock). When a
    // guard is added, flip this expectation to 1 and assert the 2nd returns 409.
    Queue::assertPushed(VibeConversionJob::class, 2);
});

/* ─── accept / review: validation + not-found ─────────────────────── */

test('POST /api/vibe-convert/accept validates that bookId is required', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/vibe-convert/accept', []), 422);
});

test('GET /api/vibe-convert/review/{book} returns {status:none} when there is no review marker', function () {
    $this->loginUser();
    $this->getJson('/api/vibe-convert/review/apitest_noreview')
        ->assertStatus(200)
        ->assertJson(['status' => 'none']);
});
