<?php

/**
 * AI Brain + Vibe CSS (AiBrainController, VibeCSSController). auth:sanctum.
 * The happy paths stream from / call an LLM (Fireworks AI), so we only exercise
 * the auth / validation / billing pre-flight guards that return BEFORE any LLM
 * call — never the generation itself.
 */

use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

/* ─── ai-brain ────────────────────────────────────────────────────── */

test('POST /api/ai-brain/query requires authentication', function () {
    $this->assertApiError($this->postJson('/api/ai-brain/query', []), 401);
});

test('POST /api/ai-brain/query 422s on missing fields (before any LLM call)', function () {
    $this->loginUser(['status' => 'premium']);   // pass billing so we reach validation
    $this->assertApiError($this->postJson('/api/ai-brain/query', ['question' => 'hi']), 422);
});

test('GET /api/ai-brain/status/{id} requires authentication', function () {
    $this->assertApiError($this->getJson('/api/ai-brain/status/HL_x'), 401);
});

test('GET /api/ai-brain/status/{id} 404s for an unknown highlight', function () {
    $this->loginUser();
    $this->getJson('/api/ai-brain/status/HL_' . Str::random(8))
        ->assertStatus(404)
        ->assertJson(['status' => 'not_found']);
});

/* ─── vibe-css ────────────────────────────────────────────────────── */

test('POST /api/vibe-css/generate requires authentication', function () {
    $this->assertApiError($this->postJson('/api/vibe-css/generate', ['prompt' => 'x']), 401);
});

test('POST /api/vibe-css/generate 422s without a prompt (before any LLM call)', function () {
    $this->loginUser(['status' => 'premium']);
    $this->assertApiError($this->postJson('/api/vibe-css/generate', []), 422);
});

test('GET /api/vibe-css/can-proceed requires authentication', function () {
    $this->assertApiError($this->getJson('/api/vibe-css/can-proceed'), 401);
});

test('GET /api/vibe-css/can-proceed returns the gate for a logged-in user', function () {
    $this->loginUser(['status' => 'premium']);
    $this->getJson('/api/vibe-css/can-proceed')
        ->assertStatus(200)
        ->assertJsonStructure(['canProceed']);
});
