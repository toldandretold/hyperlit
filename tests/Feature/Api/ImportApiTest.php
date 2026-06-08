<?php

/**
 * Import progress + reconvert endpoints (ImportController).
 *
 * The full upload→convert happy path is already covered by
 * tests/Feature/Import/ImportPipelineTest.php (it runs the conversion inline).
 * This file covers the surrounding surface that file pins:
 *   - import-progress / notify  — the public file-backed polling endpoints
 *   - reconvert                 — auth (author), ownership, and the dispatch guard
 *
 * async: ProcessDocumentImportJob. Queue::fake() asserts dispatch without running
 * the conversion. reconvert has no in-flight guard (findings F1/F4): re-issuing it
 * queues another job against the same book even if one is already running.
 */

use App\Jobs\ProcessDocumentImportJob;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function writeProgress(string $book, array $progress): string
{
    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/progress.json", json_encode($progress));
    return $dir;
}

afterEach(function () {
    $this->cleanupApiFixtures();
    foreach (glob(resource_path('markdown/apitest_*')) ?: [] as $dir) {
        if (is_dir($dir)) {
            File::deleteDirectory($dir);
        }
    }
});

/* ─── import-progress (public, file-backed) ───────────────────────── */

test('GET /api/import-progress/{book} 404s when there is no progress file', function () {
    $this->getJson('/api/import-progress/apitest_missing')
        ->assertStatus(404)
        ->assertJson(['status' => 'not_found']);
});

test('GET /api/import-progress/{book} returns the progress payload when present', function () {
    $book = 'apitest_' . Str::random(8);
    writeProgress($book, ['status' => 'processing', 'percent' => 42]);

    $this->getJson("/api/import-progress/{$book}")
        ->assertStatus(200)
        ->assertJson(['status' => 'processing', 'percent' => 42]);
});

/* ─── import-progress notify ──────────────────────────────────────── */

test('POST /api/import-progress/{book}/notify 404s for an unknown import', function () {
    $this->assertApiError($this->postJson('/api/import-progress/apitest_missing/notify'), 404);
});

test('POST /api/import-progress/{book}/notify 422s when the import already finished', function () {
    $book = 'apitest_' . Str::random(8);
    writeProgress($book, ['status' => 'complete']);

    $this->assertApiError($this->postJson("/api/import-progress/{$book}/notify"), 422);
});

test('POST /api/import-progress/{book}/notify accepts a request for an in-progress import', function () {
    $book = 'apitest_' . Str::random(8);
    $dir = writeProgress($book, ['status' => 'processing']);

    $this->postJson("/api/import-progress/{$book}/notify")
        ->assertStatus(200)
        ->assertJson(['ok' => true]);

    expect(File::exists("{$dir}/notify_email.json"))->toBeTrue();
});

/* ─── reconvert: auth + ownership ─────────────────────────────────── */

test('POST /api/books/{book}/reconvert rejects a guest (author middleware)', function () {
    $this->assertApiError($this->postJson('/api/books/apitest_x/reconvert'), 401);
});

test('POST /api/books/{book}/reconvert 404s for a book that does not exist', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/books/apitest_nope/reconvert'), 404);
});

test('POST /api/books/{book}/reconvert 403s for a non-owner of a public book', function () {
    // Must be public: RLS hides a PRIVATE book from a non-owner entirely, so the
    // controller can't see it and returns 404 (you can't tell it exists). The 403
    // ownership branch is only reachable once the row is readable.
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);

    $this->loginUser();   // a different user
    $this->assertApiError($this->postJson("/api/books/{$book}/reconvert"), 403);
});

/* ─── reconvert: dispatch + the missing in-flight guard (F1/F4) ───── */

test('POST /api/books/{book}/reconvert dispatches the import job for the owner', function () {
    Queue::fake();
    $user = $this->loginUser();
    // via=app: reconvert mutates this row through the default connection. An
    // admin-committed row would be lock-held at teardown and deadlock cleanup.
    $book = $this->makeBook($user, ['via' => 'app']);
    File::ensureDirectoryExists(resource_path("markdown/{$book}"));
    File::put(resource_path("markdown/{$book}/original.md"), "# Hi\n");

    $this->postJson("/api/books/{$book}/reconvert")
        ->assertStatus(200)
        ->assertJson(['success' => true, 'status' => 'processing']);

    Queue::assertPushed(ProcessDocumentImportJob::class, 1);
});

test('POST /api/books/{book}/reconvert blocks a concurrent re-trigger (F1/F4 fixed)', function () {
    Queue::fake();
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app']);
    File::ensureDirectoryExists(resource_path("markdown/{$book}"));
    File::put(resource_path("markdown/{$book}/original.md"), "# Hi\n");

    // First reconvert queues the job and writes a fresh 'queued' progress marker.
    $this->postJson("/api/books/{$book}/reconvert")->assertStatus(200);
    // Second, while the first is still in flight, is rejected — only ONE job runs.
    // (Was the F4 gap: both used to succeed and queue two racing jobs.)
    $this->assertApiError($this->postJson("/api/books/{$book}/reconvert"), 409);

    Queue::assertPushed(ProcessDocumentImportJob::class, 1);
});
