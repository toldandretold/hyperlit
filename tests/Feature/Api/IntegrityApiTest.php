<?php

/**
 * Integrity / feedback reports (IntegrityReportController). `author`-gated
 * (claimPremium also auth:sanctum). These email + log; no DB writes except
 * claimPremium (users.status, default connection — happy path omitted to avoid a
 * cleanup deadlock on the admin-seeded user row).
 */

use Illuminate\Support\Facades\Mail;

afterEach(fn () => $this->cleanupApiFixtures());

dataset('integrity_routes', [
    '/api/integrity/report',
    '/api/integrity/paste-glitch',
    '/api/integrity/conversion-feedback',
    '/api/integrity/claim-premium',
]);

test('integrity endpoints require an author', function (string $route) {
    $this->assertApiError($this->postJson($route, []), 401);
})->with('integrity_routes');

test('POST /api/integrity/report 422s without a bookId', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/integrity/report', []), 422);
});

test('POST /api/integrity/report accepts a report (no real mail sent)', function () {
    Mail::fake();
    $this->loginUser();
    $this->postJson('/api/integrity/report', ['bookId' => 'apitest_book'])
        ->assertStatus(200)
        ->assertJson(['status' => 'received']);
});

test('POST /api/integrity/conversion-feedback 422s without bookId + rating', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/integrity/conversion-feedback', []), 422);
});
