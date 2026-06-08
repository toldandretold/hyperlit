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

/* ─── validation: hyperlights/hypercites reject missing data (400) ── */

test('POST /api/db/hyperlights/upsert 400s when data is omitted', function () {
    $this->loginUser();
    // Omit `data` to reach the intended "Invalid data format" 400. (A non-array
    // `data` instead 500s on count() — see findings F10.)
    $this->assertApiError($this->postJson('/api/db/hyperlights/upsert', []), 400);
});

test('POST /api/db/hypercites/upsert 400s when data is omitted', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/hypercites/upsert', []), 400);
});

/* ─── validation: footnotes mask the 422 as 500 (F10); references 422 ─ */

test('POST /api/db/footnotes/upsert returns 500 on bad input (validation masked — F10)', function () {
    $this->loginUser();
    // CHARACTERIZATION: validate() runs inside a try/catch(\Exception), so the
    // ValidationException is swallowed and re-emitted as 500 instead of 422.
    // See docs/api-restructure-findings.md#f10. Flip to 422 when fixed.
    $this->assertApiError($this->postJson('/api/db/footnotes/upsert', []), 500);
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
