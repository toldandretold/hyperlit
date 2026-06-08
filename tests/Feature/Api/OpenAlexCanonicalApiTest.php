<?php

/**
 * OpenAlex + canonical source endpoints (OpenAlexController, CanonicalSourceController).
 * search/lookup/save hit the OpenAlex API on the happy path, so we only test the
 * validation guards that return before the network call. bestVersion is a pure
 * local read (no external call).
 */

afterEach(fn () => $this->cleanupApiFixtures());

/* ─── openalex search (public) ────────────────────────────────────── */

test('GET /api/search/openalex 422s on a too-short query (before the API call)', function () {
    $this->assertApiError($this->getJson('/api/search/openalex?q=a'), 422);
});

/* ─── openalex lookup-citation (auth) ─────────────────────────────── */

test('POST /api/openalex/lookup-citation requires authentication', function () {
    $this->assertApiError($this->postJson('/api/openalex/lookup-citation', ['raw' => 'Smith 2020']), 401);
});

test('POST /api/openalex/lookup-citation 422s without raw (before the API call)', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/openalex/lookup-citation', []), 422);
});

/* ─── openalex save-to-library (public) ───────────────────────────── */

test('POST /api/openalex/save-to-library 422s without an openalex_id', function () {
    $this->assertApiError($this->postJson('/api/openalex/save-to-library', []), 422);
});

/* ─── canonical best-version (public, local read) ─────────────────── */

test('GET /api/canonical/{id}/best-version 404s for an unknown canonical', function () {
    // Route constrains {id} to a UUID; an unknown (valid) UUID → "Canonical not found".
    $this->getJson('/api/canonical/00000000-0000-4000-8000-000000000000/best-version')
        ->assertStatus(404)
        ->assertJson(['error' => 'Canonical not found']);
});

test('GET /api/canonical/{id}/best-version 404s (route miss) for a non-UUID id', function () {
    // {id} constraint is [0-9a-f-]{36}; a non-UUID segment never matches a route.
    $this->getJson('/api/canonical/not-a-uuid/best-version')->assertStatus(404);
});
