<?php

/**
 * Remaining import + citation read/queue endpoints.
 *   - UrlImportController inspect/commit (arXiv/DOI) — hit OpenAlex on the happy
 *     path, so only validation is tested.
 *   - ImportController::reconvertInfo — filesystem-only, safe to call.
 *   - CitationScannerController history/running/resume — pgsql_admin reads, safe.
 *   - SearchController::searchNodes — public full-text, short-query branch.
 */

use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

/* ─── url import (author) ─────────────────────────────────────────── */

test('POST /import-url/inspect requires an author', function () {
    $this->assertApiError($this->postJson('/import-url/inspect', ['url' => 'https://arxiv.org/abs/1234']), 401);
});

test('POST /import-url/inspect 422s without a url (before the API call)', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/import-url/inspect', []), 422);
});

test('POST /import-url 422s without url + book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/import-url', []), 422);
});

/* ─── reconvert-info (author, filesystem-only) ────────────────────── */

test('GET /api/books/{book}/reconvert-info requires an author', function () {
    $this->assertApiError($this->getJson('/api/books/apitest_x/reconvert-info'), 401);
});

test('GET /api/books/{book}/reconvert-info reports not-reconvertible for an unknown book', function () {
    $this->loginUser();
    $this->getJson('/api/books/apitest_unknown/reconvert-info')
        ->assertStatus(200)
        ->assertJson(['canReconvert' => false, 'sourceType' => null]);
});

/* ─── citation reads (auth:sanctum) ───────────────────────────────── */

test('GET /api/citation-scanner/history/{book} requires authentication', function () {
    $this->assertApiError($this->getJson('/api/citation-scanner/history/apitest_x'), 401);
});

test('GET /api/citation-scanner/history/{book} returns an empty list for an unknown book', function () {
    $this->loginUser();
    $this->getJson('/api/citation-scanner/history/apitest_unknown')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'scans' => []]);
});

test('GET /api/citation-pipeline/running/{book} returns no active pipeline for an unknown book', function () {
    $this->loginUser();
    $this->getJson('/api/citation-pipeline/running/apitest_unknown')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'pipeline' => null]);
});

test('POST /api/citation-pipeline/resume/{id} 404s for an unknown pipeline', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/citation-pipeline/resume/' . Str::uuid()), 404);
});

/* ─── search nodes (public, full-text) ────────────────────────────── */

test('GET /api/search/nodes returns the full-text envelope for a short query', function () {
    $this->getJson('/api/search/nodes?q=a')
        ->assertStatus(200)
        ->assertJsonStructure(['success', 'results', 'query', 'mode'])
        ->assertJson(['success' => true, 'results' => []]);
});
