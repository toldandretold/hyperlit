<?php

/**
 * Saved CSS vibes (VibesController) — auth:sanctum, plus a public gallery.
 * Writes go through the default `vibes` table (Vibe model); cleanup sweeps by
 * the creator (test username) prefix.
 */

use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

dataset('vibe_auth_routes', [
    ['get',    '/api/vibes/mine'],
    ['post',   '/api/vibes'],
    ['patch',  '/api/vibes/' . '00000000-0000-0000-0000-000000000000'],
    ['delete', '/api/vibes/' . '00000000-0000-0000-0000-000000000000'],
]);

test('vibe endpoints require authentication', function (string $method, string $route) {
    $this->assertApiError($this->json(strtoupper($method), $route), 401);
})->with('vibe_auth_routes');

test('POST /api/vibes 422s without name + css_overrides', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/vibes', ['name' => 'x']), 422);
});

test('POST /api/vibes saves a vibe', function () {
    $this->loginUser();
    $this->postJson('/api/vibes', ['name' => 'Sepia', 'css_overrides' => ['--bg' => '#fff']])
        ->assertStatus(201)
        ->assertJsonStructure(['vibe' => ['id', 'name', 'css_overrides']]);
});

test('PATCH /api/vibes/{id} 404s for an unknown vibe', function () {
    $this->loginUser();
    $this->assertApiError($this->patchJson('/api/vibes/' . Str::uuid(), ['name' => 'x']), 404);
});

test('DELETE /api/vibes/{id} 404s for an unknown vibe', function () {
    $this->loginUser();
    $this->assertApiError($this->deleteJson('/api/vibes/' . Str::uuid()), 404);
});

test('GET /api/vibes/public is public and returns the gallery envelope', function () {
    $this->getJson('/api/vibes/public')
        ->assertStatus(200)
        ->assertJsonStructure(['vibes', 'has_more']);
});
