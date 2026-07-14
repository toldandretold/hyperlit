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

test('POST /api/db/hyperlights/upsert 422s with the standard envelope on bad data (F5/F6/F7)', function () {
    $this->loginUser();
    // Standardized like hypercites: inline Validator + ApiResponse → 422
    // {success:false, message, errors} (was a bare 400). Consumer keys off res.ok.
    $this->postJson('/api/db/hyperlights/upsert', ['data' => 'nope'])
        ->assertStatus(422)
        ->assertJson(['success' => false])
        ->assertJsonStructure(['success', 'message', 'errors' => ['data']]);
});

test('POST /api/db/hypercites/upsert 422s with the standard envelope on bad data (F5/F6/F7)', function () {
    $this->loginUser();
    // Standardized: inline Validator + ApiResponse → 422 {success:false, message, errors}
    // (was a bare 400 'Invalid data format'). The SPA consumer keys off !res.ok, so
    // 400→422 is transparent to it.
    $this->postJson('/api/db/hypercites/upsert', ['data' => 'nope'])
        ->assertStatus(422)
        ->assertJson(['success' => false])
        ->assertJsonStructure(['success', 'message', 'errors' => ['data']]);
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
    // The id must be hypercite-shaped to match the route (constrained so the greedy
    // sub-book {book} pattern knows where the book id ends — see routes/api.php).
    $this->assertApiError($this->getJson('/api/db/hypercites/find/apitest_x/hypercite_missing'), 401);
});

test('GET /api/db/hypercites/find rejects non-hypercite-shaped ids at the router', function () {
    // Router-level 404 (no route match), by design: {hyperciteId} is constrained to
    // hypercite_[A-Za-z0-9]+ so {book} can be greedy for sub-book ids with slashes.
    $this->loginUser();
    $this->getJson('/api/db/hypercites/find/apitest_x/HC_missing')->assertStatus(404);
});
