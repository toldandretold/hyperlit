<?php

/**
 * Node history / time machine (NodeHistoryController). Most routes are `author`
 * -gated; getSnapshots is public but gated by checkBookPermission. The restore
 * endpoints write through the default connection, so we pin the auth + input
 * guards that return before any write.
 */

afterEach(fn () => $this->cleanupApiFixtures());

dataset('history_author_routes', [
    ['get',  '/api/nodes/apitest_x/N1/history'],
    ['get',  '/api/books/apitest_x/changes'],
    ['post', '/api/nodes/apitest_x/N1/restore'],
    ['post', '/api/books/apitest_x/restore'],
]);

test('node-history endpoints require an author', function (string $method, string $route) {
    $this->assertApiError($this->json(strtoupper($method), $route), 401);
})->with('history_author_routes');

test('GET /api/books/{book}/timemachine-data is public for a PUBLIC book and refused for a private one', function () {
    // Public on purpose: a work under a custom licence BOOK links logged-out readers to the
    // licence's terms as of the moment it was applied (/{book}/timemachine?at=…), which loads
    // through this endpoint. Behind `author` it 401'd exactly those readers (licenses.spec).
    $owner = $this->loginUser();
    $public = $this->makeBook($owner, ['visibility' => 'public']);
    $private = $this->makeBook($owner, ['visibility' => 'private']);
    auth()->logout();

    $at = rawurlencode(now()->toIso8601String());
    // Public book with no nodes: past the permission check (404 = nothing at that instant).
    $this->assertApiError($this->getJson("/api/books/{$public}/timemachine-data?at={$at}"), 404);
    $this->assertApiError($this->getJson("/api/books/{$private}/timemachine-data?at={$at}"), 403);
    $this->assertApiError($this->getJson('/api/books/apitest_nope/timemachine-data?at='.$at), 403);
});

test('GET /api/books/{book}/snapshots is public but denies access to an unknown book', function () {
    // Public route, but checkBookPermission denies a book the caller can't see.
    $this->assertApiError($this->getJson('/api/books/apitest_nope/snapshots'), 403);
});

test('POST /api/books/{book}/restore 400s without a timestamp (owner, before any write)', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);   // owner can pass the permission check
    $this->assertApiError($this->postJson("/api/books/{$book}/restore", []), 400);
});

test('GET /api/books/{book}/timemachine-data 400s without an "at" param', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $this->assertApiError($this->getJson("/api/books/{$book}/timemachine-data"), 400);
});
