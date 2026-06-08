<?php

/**
 * Search endpoints (SearchController) — public, throttled, read-only.
 *
 * Representative of the Phase-2 read-path pattern: no auth, assert the JSON
 * envelope the SPA consumes. Kept deterministic — we use the short-query branch
 * (which returns an empty envelope without touching search infra or OpenAlex) so
 * these don't depend on indexed content or the network.
 */

afterEach(fn () => $this->cleanupApiFixtures());

test('GET /api/search/library is public and returns the search envelope', function () {
    // Guest, short query (<2 chars) → the early empty-results branch.
    $this->getJson('/api/search/library?q=a')
        ->assertStatus(200)
        ->assertJsonStructure(['success', 'results', 'query', 'mode'])
        ->assertJson(['success' => true, 'mode' => 'library', 'results' => []]);
});

test('GET /api/search/library echoes the query back', function () {
    $this->getJson('/api/search/library?q=x')
        ->assertStatus(200)
        ->assertJson(['query' => 'x']);
});

test('GET /api/search/combined rejects an invalid sourceScope', function () {
    // Validation fails before any search/OpenAlex work, so this is deterministic.
    // sourceScope must be one of public|mine|shelf — invalid value is rejected by
    // validation before any search/OpenAlex work runs, so this is deterministic.
    // (This endpoint returns a proper 422 — one of the more consistent ones.)
    $this->assertApiError($this->getJson('/api/search/combined?q=hello&sourceScope=bogus'), 422);
});
