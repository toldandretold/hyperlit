<?php

/**
 * Integrity / feedback reports (IntegrityReportController). `author`-gated
 * (claimPremium also auth:sanctum). These email + log; no DB writes except
 * claimPremium (users.status, default connection — happy path omitted to avoid a
 * cleanup deadlock on the admin-seeded user row).
 */

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

afterEach(fn () => $this->cleanupApiFixtures());

dataset('integrity_routes', [
    '/api/integrity/report',
    '/api/integrity/paste-glitch',
    '/api/integrity/conversion-feedback',
    '/api/integrity/import-failure',
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

test('POST /api/integrity/report keeps the out-of-order node category', function () {
    // `$request->validate()` returns ONLY the keys it has rules for, so an unlisted
    // category is dropped silently — a 200 proves nothing. Node ORDER is the one
    // integrity failure the per-node DOM↔IDB comparison cannot see (every node still
    // matches its own record; only the sequence is wrong), so if it gets stripped here
    // the report says "no problem found" about the exact defect it was raised for.
    Mail::fake();
    Log::spy();
    $this->loginUser();

    $this->postJson('/api/integrity/report', [
        'bookId' => 'apitest_book',
        'outOfOrderNodes' => [[
            'id' => '120',
            'previousId' => '220',
            'tag' => 'P',
            'nodeId' => 'apitest_book_1_abc',
            'textSnippet' => 'escaped from a numbered list',
        ]],
    ])->assertStatus(200);

    Log::shouldHaveReceived('warning')
        ->withArgs(fn ($message, $context = []) => $message === 'Integrity mismatch report'
            && ($context['outOfOrderNodes'][0]['id'] ?? null) === '120'
            && ($context['outOfOrderNodes'][0]['previousId'] ?? null) === '220')
        ->once();
});

test('POST /api/integrity/conversion-feedback 422s without bookId + rating', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/integrity/conversion-feedback', []), 422);
});

test('POST /api/integrity/conversion-feedback accepts a report and never 500s', function () {
    // Regression: enrichment (log grep / assessment read / consent write) must be
    // best-effort — a bug report must never itself throw. Here the book has no
    // markdown/ corpus dir (as on prod), so the consent-write branch is skipped and
    // the whole thing still returns 200.
    Mail::fake();
    $this->loginUser();
    $this->postJson('/api/integrity/conversion-feedback', [
        'bookId' => 'apitest_book',
        'rating' => 'bad',
        'issueTypes' => ['citations_not_matched'],
        'comment' => 'the harvested source is just a table of contents',
    ])->assertStatus(200)->assertJson(['status' => 'received']);
});
