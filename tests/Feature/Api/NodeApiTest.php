<?php

/**
 * Node-chunk write endpoints (DbNodeController) — the document content path.
 * All `author`-gated. upsert is a NUCLEAR upsert (deletes all nodes for the book,
 * then re-inserts) inside a transaction — so we pin auth + the input guards that
 * return before any delete/insert, not the destructive happy path.
 */

afterEach(fn () => $this->cleanupApiFixtures());

dataset('node_routes', [
    '/api/db/nodes/upsert',
    '/api/db/nodes/bulk-create',
    '/api/db/nodes/targeted-upsert',
]);

test('node-chunk endpoints require an author', function (string $route) {
    $this->assertApiError($this->postJson($route, ['book' => 'x', 'data' => []]), 401);
})->with('node_routes');

// Standardized F5/F6: these validation failures now return 422 {success,message}
// (were bare 400). The SPA consumers key off res.ok, so the code change is transparent.
test('POST /api/db/nodes/upsert 422s without a book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/nodes/upsert', ['data' => []]), 422);
});

test('POST /api/db/nodes/bulk-create 422s without a book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/nodes/bulk-create', ['data' => []]), 422);
});

test('POST /api/db/nodes/targeted-upsert 422s with empty data', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/nodes/targeted-upsert', ['data' => []]), 422);
});
