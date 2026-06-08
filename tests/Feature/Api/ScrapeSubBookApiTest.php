<?php

/**
 * Scraping + sub-book creation (ScrapeController, SubBookController). `author`.
 * Scrape happy paths fetch a remote URL (Http::get), so only validation is
 * tested there. Sub-book create/migrate write nodes+library via the default
 * connection on the happy path — we pin auth + validation (returns before write).
 */

afterEach(fn () => $this->cleanupApiFixtures());

dataset('scrape_subbook_routes', [
    '/api/scrape/novel/chapters',
    '/api/scrape/novel/chapter',
    '/api/db/sub-books/create',
    '/api/db/sub-books/migrate-existing',
]);

test('scrape + sub-book endpoints require an author', function (string $route) {
    $this->assertApiError($this->postJson($route, []), 401);
})->with('scrape_subbook_routes');

test('POST /api/scrape/novel/chapters 422s without a url (before any fetch)', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/scrape/novel/chapters', []), 422);
});

test('POST /api/scrape/novel/chapter 422s without a url (before any fetch)', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/scrape/novel/chapter', []), 422);
});

test('POST /api/db/sub-books/create 422s on missing type/parentBook/itemId', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/sub-books/create', []), 422);
});

test('POST /api/db/sub-books/migrate-existing 422s on missing fields', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/sub-books/migrate-existing', []), 422);
});
