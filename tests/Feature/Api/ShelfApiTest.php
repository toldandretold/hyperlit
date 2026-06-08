<?php

/**
 * Shelves (ShelfController) — curation, auth:sanctum (public variants throttled).
 * Writes go through pgsql_admin (shelves/shelf_items/shelf_pins), cleaned up by
 * cleanupApiFixtures via the creator (test username) prefix.
 *
 * NOTE: shelves.id is a UUID. A non-UUID {id} hits a Postgres cast error → 500
 * (an unvalidated-route-param wart, finding F11) rather than a clean 404, so the
 * not-found tests use a real UUID.
 */

use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

dataset('shelf_auth_routes', [
    ['get',    '/api/shelves'],
    ['post',   '/api/shelves'],
    ['get',    '/api/shelves/1/render'],
    ['get',    '/api/shelves/1/search?q=ab'],
    ['delete', '/api/shelves/1'],
]);

test('shelf endpoints require authentication', function (string $method, string $route) {
    $this->assertApiError($this->json(strtoupper($method), $route), 401);
})->with('shelf_auth_routes');

test('POST /api/shelves 422s without a name', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/shelves', []), 422);
});

test('POST /api/shelves creates a shelf', function () {
    $this->loginUser();
    $this->postJson('/api/shelves', ['name' => 'My Shelf'])
        ->assertStatus(201)
        ->assertJsonStructure(['success', 'shelf' => ['id', 'name', 'slug']]);
});

test('DELETE /api/shelves/{id} 404s for an unknown shelf', function () {
    $this->loginUser();
    $this->assertApiError($this->deleteJson('/api/shelves/' . Str::uuid()), 404);
});

test('GET /api/shelves/{id}/render 404s for an unknown shelf', function () {
    $this->loginUser();
    $this->assertApiError($this->getJson('/api/shelves/' . Str::uuid() . '/render'), 404);
});

/* ─── public variants ─────────────────────────────────────────────── */

test('GET /api/public/shelves/{id}/render 404s for an unknown/non-public shelf', function () {
    $this->assertApiError($this->getJson('/api/public/shelves/' . Str::uuid() . '/render'), 404);
});

test('GET /api/public/shelves/{id}/search 404s for an unknown/non-public shelf', function () {
    $this->assertApiError($this->getJson('/api/public/shelves/' . Str::uuid() . '/search?q=hello'), 404);
});
