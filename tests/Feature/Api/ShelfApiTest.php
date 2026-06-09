<?php

/**
 * Shelves (ShelfController) — curation, auth:sanctum (public variants throttled).
 * Writes go through pgsql_admin (shelves/shelf_items/shelf_pins), cleaned up by
 * cleanupApiFixtures via the creator (test username) prefix.
 *
 * NOTE: shelves.id is a UUID; the routes now constrain it with whereUuid (F11
 * fixed), so a non-UUID {id} 404s (route miss) instead of 500ing on a Postgres
 * uuid cast. The not-found tests use a real (but unknown) UUID to reach the
 * controller's own 404.
 */

use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

// Use a valid UUID for {id} routes: with the whereUuid constraint (F11), a
// non-UUID segment 404s at routing BEFORE the auth middleware runs.
dataset('shelf_auth_routes', [
    ['get',    '/api/shelves'],
    ['post',   '/api/shelves'],
    ['get',    '/api/shelves/00000000-0000-4000-8000-000000000000/render'],
    ['get',    '/api/shelves/00000000-0000-4000-8000-000000000000/search?q=ab'],
    ['delete', '/api/shelves/00000000-0000-4000-8000-000000000000'],
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

test('shelf routes 404 (route miss) on a non-UUID id instead of 500 (F11 fixed)', function () {
    $this->loginUser();
    // whereUuid route constraint: a non-UUID segment never matches → 404, not a
    // Postgres uuid-cast 500.
    $this->assertApiError($this->getJson('/api/shelves/not-a-uuid/render'), 404);
    $this->assertApiError($this->deleteJson('/api/shelves/99999999'), 404);
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
