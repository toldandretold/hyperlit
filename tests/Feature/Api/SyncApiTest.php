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

/* ─── beacon sync ─────────────────────────────────────────────────── */

test('POST /api/db/sync/beacon requires an author', function () {
    $this->assertApiError($this->postJson('/api/db/sync/beacon', ['book' => 'x']), 401);
});

test('POST /api/db/sync/beacon 422s on a malformed payload', function () {
    $this->loginUser();
    // book required + updates/deletions must be arrays — omit them.
    $this->assertApiError($this->postJson('/api/db/sync/beacon', []), 422);
});
