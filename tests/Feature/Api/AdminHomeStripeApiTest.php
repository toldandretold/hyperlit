<?php

/**
 * Admin conversion-tests, homepage curation, and Stripe (ConversionTestController,
 * HomePageServerController, StripeController). Happy paths run a Python subprocess
 * / hit Stripe / rebuild the homepage via pgsql_admin, so we pin auth, admin-gating,
 * and the Stripe webhook signature guard.
 */

afterEach(fn () => $this->cleanupApiFixtures());

/* ─── conversion-tests (auth:sanctum + admin) ─────────────────────── */

dataset('conversion_test_routes', [
    '/api/conversion-tests/run',
    '/api/conversion-tests/add-fixture',
    '/api/conversion-tests/upload-fixture',
]);

test('conversion-test endpoints require authentication', function (string $route) {
    $this->assertApiError($this->postJson($route, []), 401);
})->with('conversion_test_routes');

test('conversion-test endpoints 403 for a non-admin', function (string $route) {
    $this->loginUser();   // ordinary user, not admin
    $this->assertApiError($this->postJson($route, []), 403);
})->with('conversion_test_routes');

/* ─── homepage curation (author) ──────────────────────────────────── */

test('GET /api/homepage/books requires an author', function () {
    $this->assertApiError($this->getJson('/api/homepage/books'), 401);
});

test('POST /api/homepage/books/update requires an author', function () {
    $this->assertApiError($this->postJson('/api/homepage/books/update', []), 401);
});

/* ─── stripe ──────────────────────────────────────────────────────── */

test('POST /api/billing/checkout requires authentication', function () {
    $this->assertApiError($this->postJson('/api/billing/checkout', ['amount' => 10]), 401);
});

test('POST /api/billing/checkout 422s on an out-of-range amount (before Stripe)', function () {
    $this->loginUser();
    // amount must be 5..500 — below the floor is rejected before any Stripe call.
    $this->assertApiError($this->postJson('/api/billing/checkout', ['amount' => 1]), 422);
});

test('POST /api/stripe/webhook 400s without a valid signature', function () {
    // Public endpoint (no auth); guarded by Stripe signature verification.
    $this->postJson('/api/stripe/webhook', ['type' => 'checkout.session.completed'])
        ->assertStatus(400);
});
