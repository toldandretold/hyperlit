<?php

/**
 * The DB→IndexedDB read path the SPA boots from (DatabaseToIndexedDBController).
 * These routes are public (RLS + per-book authorization decides visibility), so
 * the key assertions are the not-found / access-denied / deleted envelopes the
 * frontend branches on. Reads only — no deadlock risk from admin-seeded fixtures.
 */

afterEach(fn () => $this->cleanupApiFixtures());

test('GET …/books/{book}/data 404s for a book that does not exist', function () {
    $this->getJson('/api/database-to-indexeddb/books/apitest_nope/data')
        ->assertStatus(404)
        ->assertJson(['error' => 'Book not found']);
});

test('GET …/books/{book}/data 403s for a private book read by a non-owner', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'private']);
    // Guest (no session) reading a private book → access_denied.
    $this->getJson("/api/database-to-indexeddb/books/{$book}/data")
        ->assertStatus(403)
        ->assertJson(['error' => 'access_denied']);
});

test('GET …/books/{book}/chunk/{chunkId} 404s for a non-numeric chunk id', function () {
    // Route constrains chunkId to [0-9]+, so a non-numeric segment never matches.
    $this->getJson('/api/database-to-indexeddb/books/apitest_x/chunk/abc')
        ->assertStatus(404);
});

test('POST …/books/{book}/reading-position 401s without a user identity', function () {
    $this->postJson('/api/database-to-indexeddb/books/apitest_x/reading-position', ['chunk_id' => 1])
        ->assertStatus(401)
        ->assertJson(['error' => 'No user identity']);
});

/* ─── the other read variants: not-found / access-denied envelopes ── */

test('the headings/initial/batch reads 404 for a book that does not exist', function (string $suffix) {
    $this->getJson("/api/database-to-indexeddb/books/apitest_nope/{$suffix}")
        ->assertStatus(404);
})->with([
    'headings',
    'initial',
    'data/batch',
]);

test('GET …/books/{book}/annotations 403s for a private book read by a non-owner', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'private']);
    $this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(403)
        ->assertJson(['error' => 'access_denied']);
});

test('GET …/books/{book}/library 404s for a book with no library record', function () {
    // Library/bibliography is public even for private books, so the only failure
    // here is "no record" → 404 (not 403).
    $this->getJson('/api/database-to-indexeddb/books/apitest_nope/library')
        ->assertStatus(404);
});

test('GET …/books/{book}/library round-trips volume/issue/booktitle/chapter/editor (no silent loss)', function () {
    // These bibliographic sub-fields are written by upsert and editable in the form. The LOAD must
    // return them — otherwise a reload leaves the edit-form inputs blank and the next save regenerates
    // bibtex WITHOUT them (silent data loss). This pins the symmetric load↔write round-trip.
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, [
        'volume' => 'V12', 'issue' => 'I3', 'booktitle' => 'The Big Book',
        'chapter' => 'Ch4', 'editor' => 'Ada Lovelace',
    ]);

    $this->getJson("/api/database-to-indexeddb/books/{$book}/library")
        ->assertStatus(200)
        ->assertJson(['success' => true, 'library' => [
            'volume' => 'V12', 'issue' => 'I3', 'booktitle' => 'The Big Book',
            'chapter' => 'Ch4', 'editor' => 'Ada Lovelace',
        ]]);
});

test('the sub-book read variants 404 for an unknown parent/sub', function (string $suffix) {
    // {parentBook}/{subId} reconstructs "parent/sub" and delegates to the parent
    // method, so an unknown sub-book surfaces the same not-found envelope.
    $this->getJson("/api/database-to-indexeddb/books/apitest_nope/Fn1/{$suffix}")
        ->assertStatus(404);
})->with(['data', 'initial']);
