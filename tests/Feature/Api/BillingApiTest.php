<?php

/**
 * Billing reads + admin credit grant (BillingController). auth:sanctum.
 * `balance` is computed (credits − debits accessor on User), not a column.
 */

use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

dataset('billing_auth_routes', [
    ['get',  '/api/billing/balance'],
    ['get',  '/api/billing/ledger'],
    ['get',  '/api/billing/ledger/' . '00000000-0000-0000-0000-000000000000'],
    ['post', '/api/billing/credits'],
]);

test('billing endpoints require authentication', function (string $method, string $route) {
    $this->assertApiError($this->json(strtoupper($method), $route), 401);
})->with('billing_auth_routes');

test('GET /api/billing/balance returns the balance envelope', function () {
    $this->loginUser();
    $this->getJson('/api/billing/balance')
        ->assertStatus(200)
        ->assertJsonStructure(['credits', 'debits', 'balance']);
});

test('GET /api/billing/ledger returns a paginated list', function () {
    $this->loginUser();
    $this->getJson('/api/billing/ledger')
        ->assertStatus(200)
        ->assertJsonStructure(['data', 'current_page', 'total']);
});

test('GET /api/billing/ledger/{id} 404s for an unknown entry', function () {
    $this->loginUser();
    $this->assertApiError($this->getJson('/api/billing/ledger/' . Str::uuid()), 404);
});

test('POST /api/billing/credits 422s on missing fields', function () {
    // Validation runs before the admin check.
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/billing/credits', []), 422);
});

test('POST /api/billing/credits 403s for a non-admin with valid fields', function () {
    $user = $this->loginUser();
    $this->assertApiError(
        $this->postJson('/api/billing/credits', ['user_id' => $user->id, 'amount' => 1.0]),
        403
    );
});
