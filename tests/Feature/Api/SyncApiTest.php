<?php

/**
 * Unified + beacon sync endpoints (UnifiedSyncController, BeaconSyncController).
 *
 * unified-sync orchestrates writes across many child controllers inside a single
 * transaction, with each child opening its own — see findings F8 (nested
 * transactions). We pin auth + the input/stale guards here; the orchestration
 * itself is best exercised through the editor save flow.
 */

afterEach(fn () => $this->cleanupApiFixtures());

/* ─── unified-sync ────────────────────────────────────────────────── */

test('POST /api/db/unified-sync requires an author', function () {
    $this->assertApiError($this->postJson('/api/db/unified-sync', ['book' => 'x']), 401);
});

test('POST /api/db/unified-sync 400s without a book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/unified-sync', []), 400);
});

test('POST /api/db/unified-sync upserts a library record (happy path; exercises F8 refactor)', function () {
    // Library-only payload: no nodes (so the stale-check is skipped), no deletions
    // (so the post-commit deletion helpers no-op). Covers the transaction + a child
    // upsert + the results envelope after the F8 extract-and-reorder.
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app']);

    $this->postJson('/api/db/unified-sync', [
        'book'    => $book,
        'library' => ['book' => $book, 'title' => 'Synced Title'],
    ])
        ->assertStatus(200)
        ->assertJson(['success' => true])
        ->assertJsonPath('results.library.success', true);
});

/* ─── beacon sync ─────────────────────────────────────────────────── */

test('POST /api/db/sync/beacon requires an author', function () {
    $this->assertApiError($this->postJson('/api/db/sync/beacon', ['book' => 'x']), 401);
});

test('POST /api/db/sync/beacon 422s on a malformed payload', function () {
    $this->loginUser();
    // book required + updates/deletions must be arrays — omit them.
    $this->assertApiError($this->postJson('/api/db/sync/beacon', []), 422);
});
