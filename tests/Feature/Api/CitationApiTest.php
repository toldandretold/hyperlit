<?php

/**
 * Citation scanner / pipeline endpoints (CitationScannerController).
 *
 * async: CitationScanBibliographyJob, CitationPipelineJob. We Queue::fake() so the
 * dispatch is asserted without running the (LLM-heavy) job. Auth is auth:sanctum.
 *
 * Concurrency note: scan()/triggerPipeline() guard against a second run by checking
 * for a pending/running row, which we verify SEQUENTIALLY here. The check is not
 * atomic (TOCTOU between the SELECT and the INSERT) — see
 * docs/api-restructure-findings.md#f2. Proving the true race needs the live harness
 * in tests/Feature/Api/Concurrency/, not an in-process sync-queue test.
 */

use App\Jobs\CitationScanBibliographyJob;
use App\Jobs\CitationPipelineJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;

afterEach(fn () => $this->cleanupApiFixtures());

/* ─── scan: auth + validation ─────────────────────────────────────── */

test('POST /api/citation-scanner/scan requires authentication', function () {
    $this->assertApiError($this->postJson('/api/citation-scanner/scan', ['book' => 'x']), 401);
});

test('POST /api/citation-scanner/scan validates that book is required', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/citation-scanner/scan', []), 422);
});

test('POST /api/citation-scanner/scan 404s for a book that does not exist', function () {
    $this->loginUser();
    $this->assertApiError(
        $this->postJson('/api/citation-scanner/scan', ['book' => 'apitest_nope_' . uniqid()]),
        404
    );
});

/* ─── scan: happy path + dispatch ─────────────────────────────────── */

test('POST /api/citation-scanner/scan creates a scan record and dispatches the job', function () {
    Queue::fake();
    $user = $this->loginUser();
    $book = $this->makeBook($user);

    $response = $this->postJson('/api/citation-scanner/scan', ['book' => $book]);

    $response->assertStatus(200)
        ->assertJsonStructure(['success', 'scan_id', 'total_entries'])
        ->assertJson(['success' => true]);

    $scanId = $response->json('scan_id');
    expect(DB::connection('pgsql_admin')->table('citation_scans')->where('id', $scanId)->where('status', 'pending')->exists())
        ->toBeTrue();
    Queue::assertPushed(CitationScanBibliographyJob::class, 1);
});

/* ─── scan: the in-flight guard (sequential) ──────────────────────── */

test('POST /api/citation-scanner/scan 409s when a scan is already pending for the book', function () {
    Queue::fake();
    $user = $this->loginUser();
    $book = $this->makeBook($user);

    // First scan establishes a pending row.
    $this->postJson('/api/citation-scanner/scan', ['book' => $book])->assertStatus(200);

    // Second scan must be blocked by the pending-row guard.
    $second = $this->postJson('/api/citation-scanner/scan', ['book' => $book]);
    $this->assertApiError($second, 409)->assertJson(['success' => false]);

    // Guard worked sequentially: exactly one job dispatched, one scan row.
    Queue::assertPushed(CitationScanBibliographyJob::class, 1);
    expect(DB::connection('pgsql_admin')->table('citation_scans')->where('book', $book)->count())->toBe(1);
    // NB: this proves the guard SEQUENTIALLY. The SELECT-then-INSERT is not atomic;
    // two concurrent requests can both pass the check. See findings F2 — the live
    // harness (tests/Feature/Api/Concurrency) is what actually exercises that race.
});

/* ─── pipeline: auth, billing, guard ──────────────────────────────── */

test('POST /api/citation-pipeline/trigger requires authentication', function () {
    $this->assertApiError($this->postJson('/api/citation-pipeline/trigger', ['book' => 'x']), 401);
});

test('POST /api/citation-pipeline/trigger 402s when the user has no balance', function () {
    // Non-premium with no credit ledger → balance 0 → billing gate.
    $this->loginUser(['status' => 'free']);
    $this->assertApiError($this->postJson('/api/citation-pipeline/trigger', ['book' => 'apitest_x']), 402);
});

test('POST /api/citation-pipeline/trigger dispatches for a premium user', function () {
    Queue::fake();
    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);

    $response = $this->postJson('/api/citation-pipeline/trigger', ['book' => $book]);

    $response->assertStatus(200)->assertJsonStructure(['success', 'pipeline_id']);
    Queue::assertPushed(CitationPipelineJob::class, 1);
});

test('POST /api/citation-pipeline/trigger 409s when a pipeline is already running', function () {
    Queue::fake();
    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);

    $this->postJson('/api/citation-pipeline/trigger', ['book' => $book])->assertStatus(200);
    $this->assertApiError($this->postJson('/api/citation-pipeline/trigger', ['book' => $book]), 409);

    Queue::assertPushed(CitationPipelineJob::class, 1);
});

/* ─── status endpoints: not-found shape ───────────────────────────── */

test('GET /api/citation-scanner/status/{id} 404s for an unknown scan', function () {
    $this->loginUser();
    $this->assertApiError($this->getJson('/api/citation-scanner/status/' . \Illuminate\Support\Str::uuid()), 404);
});

test('GET /api/citation-pipeline/status/{id} 404s for an unknown pipeline', function () {
    $this->loginUser();
    $this->assertApiError($this->getJson('/api/citation-pipeline/status/' . \Illuminate\Support\Str::uuid()), 404);
});
