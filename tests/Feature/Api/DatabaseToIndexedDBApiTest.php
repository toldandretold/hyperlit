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

test('GET …/books/{book}/library returns 200 library:null for a book with no library record', function () {
    // A missing library row is an EXPECTED, benign condition (freshly-authored sub-books
    // have no server row until they sync, and the per-load freshness check fetches this for
    // every book). It answers 200 {success:false, library:null} — NOT 404 — so the browser
    // doesn't log a console error on every such fetch (which trips the e2e no-console-errors
    // gate). Library/bibliography is public even for private books, so there's no 403 here.
    $this->getJson('/api/database-to-indexeddb/books/apitest_nope/library')
        ->assertStatus(200)
        ->assertJson(['success' => false, 'library' => null]);
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

test('the sub-book /library route exists and answers 200 library:null when missing', function () {
    // Sub-book ids ("parent/sub") can't ride the single-segment {bookId}/library route — the
    // "/" overflows the segment (raw) or is rejected (%2F), so EVERY footnote/hyperlight
    // freshness check 404'd at the router (the e2e "404 storm"). The {parentBook}/{subId}/library
    // route fixes that; like the parent route a missing row is 200 library:null, NOT 404, so the
    // browser logs no console error. Deep nests (2/HL_1/Fn_2) must route too.
    $this->getJson('/api/database-to-indexeddb/books/apitest_nope/Fn1/library')
        ->assertStatus(200)
        ->assertJson(['success' => false, 'library' => null]);

    $this->getJson('/api/database-to-indexeddb/books/apitest_nope/2/HL_1/Fn_2/library')
        ->assertStatus(200)
        ->assertJson(['success' => false, 'library' => null]);
});

// Clean node/bibliography fixtures this file seeds via pgsql_admin (cleanupApiFixtures only does library).
afterEach(function () {
    $admin = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    $admin->table('nodes')->where('book', 'like', 'apitest\_%')->delete();
    $admin->table('bibliography')->where('book', 'like', 'apitest\_%')->delete();
});

test('the bibliography payload carries web-stub + reference-decision fields (live AND cache paths)', function () {
    $admin = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    $book = 'apitest_' . \Illuminate\Support\Str::random(12);

    $admin->table('library')->insert([
        'book' => $book, 'title' => 'Payload Book', 'visibility' => 'public', 'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ]);
    // A WebFetch scrape stub the reference points at.
    $stub = 'web_' . \Illuminate\Support\Str::random(12);
    $admin->table('library')->insert([
        'book' => $stub, 'title' => 'Stub', 'creator' => 'WebFetch', 'visibility' => 'public',
        'type' => 'web_source', 'has_nodes' => true, 'url' => 'https://progressive.international/havana',
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    $admin->table('nodes')->insert([
        'book' => $book, 'startLine' => 0, 'chunk_id' => 0, 'node_id' => $book . '_n0',
        'content' => '<p>Body</p>', 'plainText' => 'Body', 'type' => 'p',
        'footnotes' => '[]', 'created_at' => now(), 'updated_at' => now(),
    ]);
    // Ref A: matched to a web stub. Ref B: author already verified the canonical match.
    $admin->table('bibliography')->insert([
        'book' => $book, 'referenceId' => 'refWeb', 'content' => 'Web ref.', 'source_id' => $stub,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $admin->table('bibliography')->insert([
        'book' => $book, 'referenceId' => 'refVerified', 'content' => 'Verified ref.',
        'canonical_source_id' => '11111111-1111-1111-1111-111111111111',
        'reference_match_method' => 'user_verified', 'reference_verified_at' => now(),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $assert = function () use ($book) {
        $bib = $this->getJson("/api/database-to-indexeddb/books/{$book}/data")
            ->assertOk()->json('bibliography.data');
        expect($bib['refWeb']['source_is_web_stub'])->toBeTrue();
        expect($bib['refWeb']['source_external_url'])->toBe('https://progressive.international/havana');
        expect($bib['refVerified']['source_is_web_stub'])->toBeFalse();
        expect($bib['refVerified']['reference_match_method'])->toBe('user_verified');
    };

    // Live path (cache cold).
    $assert();
    // Cache path — the two getBibliography impls must agree.
    app(\App\Services\BookCache::class)->warm($book);
    $assert();
});

// NOTE: the "upsertReferences doesn't clobber reference_match_method" invariant is guarded
// structurally — DbReferencesController::upsertReferences writes an explicit column list
// (book/referenceId/source_id/canonical_source_id/content only), so a client re-sync can't touch
// the human decision — and the round-trip of reference_match_method through getBibliography is
// covered above. A live POST test would deadlock the RefreshDatabase tx: the controller's
// default-connection updateOrInsert locks the pgsql_admin-committed bibliography row, and the
// pgsql_admin cleanup DELETE below then blocks on that lock until rollback.
