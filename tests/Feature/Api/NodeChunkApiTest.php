<?php

/**
 * Node-chunk write endpoints (DbNodeChunkController) — the document content path.
 * All `author`-gated. upsert is a NUCLEAR upsert (deletes all nodes for the book,
 * then re-inserts) inside a transaction — so we pin auth + the input guards that
 * return before any delete/insert, not the destructive happy path.
 */

afterEach(fn () => $this->cleanupApiFixtures());

dataset('node_chunk_routes', [
    '/api/db/node-chunks/upsert',
    '/api/db/node-chunks/bulk-create',
    '/api/db/node-chunks/targeted-upsert',
]);

test('node-chunk endpoints require an author', function (string $route) {
    $this->assertApiError($this->postJson($route, ['book' => 'x', 'data' => []]), 401);
})->with('node_chunk_routes');

// Standardized F5/F6: these validation failures now return 422 {success,message}
// (were bare 400). The SPA consumers key off res.ok, so the code change is transparent.
test('POST /api/db/node-chunks/upsert 422s without a book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/node-chunks/upsert', ['data' => []]), 422);
});

test('POST /api/db/node-chunks/bulk-create 422s without a book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/node-chunks/bulk-create', ['data' => []]), 422);
});

test('POST /api/db/node-chunks/targeted-upsert 422s with empty data', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/node-chunks/targeted-upsert', ['data' => []]), 422);
});
