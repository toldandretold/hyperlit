<?php

/**
 * Annotation write endpoints: hyperlights, hypercites, footnotes, references
 * (Db{Hyperlight,Hypercite,Footnote,References}Controller). All `author`-gated.
 *
 * Coverage here is auth + validation (deterministic, no fixtures). The happy-path
 * upserts create sub_book library rows via the default connection and are better
 * exercised by the sync/import flows; we pin the guards that reject bad input.
 *
 * NOTE: the bare error shape differs across these (some 400 {success:false},
 * footnotes/references use validate() → 422). assertApiError pins the status, not
 * the body — see findings F5/F6.
 */

afterEach(fn () => $this->cleanupApiFixtures());

/* ─── auth: every write endpoint rejects a guest ──────────────────── */

dataset('annotation_write_routes', [
    '/api/db/hyperlights/upsert',
    '/api/db/hyperlights/bulk-create',
    '/api/db/hyperlights/delete',
    '/api/db/hyperlights/hide',
    '/api/db/hypercites/upsert',
    '/api/db/hypercites/bulk-create',
    '/api/db/footnotes/upsert',
    '/api/db/references/upsert',
]);

test('annotation write endpoints require an author', function (string $route) {
    $this->assertApiError($this->postJson($route, ['data' => []]), 401);
})->with('annotation_write_routes');

/* ─── validation: hyperlights/hypercites reject bad data (400) ─────── */

test('POST /api/db/hyperlights/upsert 400s when data is non-array (F10 fixed)', function () {
    $this->loginUser();
    // F10 fixed: count() is now guarded by is_array, so a non-array `data` reaches
    // the intended "Invalid data format" 400 instead of TypeError-ing into a 500.
    $this->assertApiError($this->postJson('/api/db/hyperlights/upsert', ['data' => 'nope']), 400);
});

test('POST /api/db/hypercites/upsert 400s when data is non-array (F10 fixed)', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/hypercites/upsert', ['data' => 'nope']), 400);
});

/* ─── validation: footnotes now return a clean 422; references 422 ─── */

test('POST /api/db/footnotes/upsert 422s on bad input (F10 fixed)', function () {
    $this->loginUser();
    // F10 fixed: validate() runs before the try/catch, so the ValidationException
    // surfaces as a proper 422 with field errors instead of a masked 500.
    $this->assertApiError($this->postJson('/api/db/footnotes/upsert', []), 422);
});

test('POST /api/db/references/upsert 422s without book + data', function () {
    $this->loginUser();
    // References validates with an explicit 422 return (not swallowed) — the
    // consistent one of the four.
    $this->assertApiError($this->postJson('/api/db/references/upsert', []), 422);
});

/* ─── hypercite find: auth ────────────────────────────────────────── */

test('GET /api/db/hypercites/find/{book}/{id} requires an author', function () {
    $this->assertApiError($this->getJson('/api/db/hypercites/find/apitest_x/HC_missing'), 401);
});
