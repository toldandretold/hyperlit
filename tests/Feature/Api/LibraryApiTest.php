<?php

/**
 * Library CRUD + stats endpoints (DbLibraryController).
 *
 * Mostly auth/validation/ownership characterization — the happy-path writes go
 * through the default connection (and `destroy` through pgsql_admin via
 * BookDeletionService), so we assert the guards that return BEFORE any write.
 */

afterEach(fn () => $this->cleanupApiFixtures());

/* ─── validate-book-id ────────────────────────────────────────────── */

test('POST /api/validate-book-id requires an author', function () {
    $this->assertApiError($this->postJson('/api/validate-book-id', ['book' => 'x']), 401);
});

test('POST /api/validate-book-id 400s without a book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/validate-book-id', []), 400);
});

test('POST /api/validate-book-id reports existence for a known book', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $this->postJson('/api/validate-book-id', ['book' => $book])
        ->assertStatus(200)
        ->assertJsonStructure(['success', 'exists'])
        ->assertJson(['success' => true, 'exists' => true]);
});

/* ─── upsert ──────────────────────────────────────────────────────── */

test('POST /api/db/library/upsert requires an author', function () {
    $this->assertApiError($this->postJson('/api/db/library/upsert', ['data' => ['book' => 'x']]), 401);
});

test('POST /api/db/library/upsert 422s without data.book (standard envelope; F5/F6/F7)', function () {
    $this->loginUser();
    // Standardized: inline Validator + ApiResponse → 422 {success:false, message, errors}
    // (was a bare 400). Consumer keys off response.ok, so the code change is transparent.
    $this->postJson('/api/db/library/upsert', ['data' => []])
        ->assertStatus(422)
        ->assertJson(['success' => false])
        ->assertJsonStructure(['success', 'message', 'errors']);
});

/* ─── bulk-create + stats ─────────────────────────────────────────── */

test('POST /api/db/library/bulk-create requires an author', function () {
    $this->assertApiError($this->postJson('/api/db/library/bulk-create', ['data' => ['data' => []]]), 401);
});

test('POST /api/db/library/bulk-create persists license/custom_license_text/gate_defaults/annotations_updated_at when sent', function () {
    // Symmetric-with-upsert fix: bulkCreate used to silently drop these four; the created record
    // returned by the controller must now carry the client-sent values (matters for import flows).
    $this->loginUser();
    $book = 'apitest_' . \Illuminate\Support\Str::random(10);

    $this->postJson('/api/db/library/bulk-create', ['data' => [
        'book' => $book,
        'title' => 'BulkCreate License Test',
        'license' => 'MIT',
        'custom_license_text' => 'my custom terms',
        'gate_defaults' => ['hideAI' => true],
        'annotations_updated_at' => 4242,
    ]])
        ->assertStatus(200)
        ->assertJson(['success' => true, 'library' => [
            'license' => 'MIT',
            'custom_license_text' => 'my custom terms',
            'gate_defaults' => ['hideAI' => true],
            'annotations_updated_at' => 4242,
        ]]);
});

test('POST /api/db/library/bulk-create falls back to DB defaults when those fields are omitted', function () {
    $this->loginUser();
    $book = 'apitest_' . \Illuminate\Support\Str::random(10);

    $this->postJson('/api/db/library/bulk-create', ['data' => [
        'book' => $book,
        'title' => 'BulkCreate Defaults Test',
    ]])
        ->assertStatus(200)
        ->assertJson(['success' => true, 'library' => [
            'license' => 'CC-BY-SA-4.0-NO-AI',
            'custom_license_text' => null,
            'gate_defaults' => null,
            'annotations_updated_at' => 0,
        ]]);
});

test('POST /api/library/{book}/update-stats requires an author', function () {
    $this->assertApiError($this->postJson('/api/library/apitest_x/update-stats'), 401);
});

test('POST /api/library/update-all-stats requires an author', function () {
    $this->assertApiError($this->postJson('/api/library/update-all-stats'), 401);
});

/* ─── update-timestamp ────────────────────────────────────────────── */

test('POST /api/db/library/update-timestamp requires an author', function () {
    $this->assertApiError($this->postJson('/api/db/library/update-timestamp', ['book' => 'x', 'timestamp' => 1]), 401);
});

test('POST /api/db/library/update-timestamp 400s without a book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/library/update-timestamp', ['timestamp' => 1]), 400);
});

/* ─── set-slug ────────────────────────────────────────────────────── */

test('POST /api/db/library/set-slug rejects an invalid slug format (422, before any write)', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);   // owner can read their own private book
    $this->assertApiError(
        $this->postJson('/api/db/library/set-slug', ['book' => $book, 'slug' => 'NOT A SLUG!']),
        422
    );
});

test('POST /api/db/library/set-slug is set-once: first set succeeds, overwrite and clear both 422', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $slug = 'apitest-' . strtolower(\Illuminate\Support\Str::random(10));

    // First set succeeds (the creator, slug currently null).
    $this->postJson('/api/db/library/set-slug', ['book' => $book, 'slug' => $slug])
        ->assertStatus(200)
        ->assertJson(['success' => true, 'slug' => $slug]);
    $this->assertDatabaseHas('library', ['book' => $book, 'slug' => $slug]);

    // Overwriting is refused — a slug is a permanent public address.
    $this->assertApiError(
        $this->postJson('/api/db/library/set-slug', ['book' => $book, 'slug' => $slug . '-v2']),
        422
    );

    // Clearing is refused too (removal kills external links just the same).
    $this->assertApiError(
        $this->postJson('/api/db/library/set-slug', ['book' => $book, 'slug' => '']),
        422
    );

    $this->assertDatabaseHas('library', ['book' => $book, 'slug' => $slug]);
});

test('POST /api/db/library/set-slug 403s for a non-creator', function () {
    // Public, or RLS hides the row from the non-creator and the test would
    // exercise the 404 branch instead of the creator check.
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser(); // somebody else
    $this->assertApiError(
        $this->postJson('/api/db/library/set-slug', ['book' => $book, 'slug' => 'apitest-stolen-slug']),
        403
    );
});

/* ─── slug-info ───────────────────────────────────────────────────── */

test('GET /api/db/library/slug-info requires a logged-in user', function () {
    $this->assertApiError($this->getJson('/api/db/library/slug-info?book=apitest_x'), 401);
});

test('GET /api/db/library/slug-info 403s for a non-creator', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();
    $this->assertApiError($this->getJson('/api/db/library/slug-info?book=' . $book), 403);
});

test('GET /api/db/library/slug-info offers a suggestion while unset, then reports the slug as locked', function () {
    $user = $this->loginUser();
    $token = strtolower(\Illuminate\Support\Str::random(12));
    $book = $this->makeBook($user, ['title' => "Apitest {$token} Slug Fixture"]);

    // Slug-less: claimable, with a collision-free suggestion from the title
    // (the same generator library:backfill-slugs uses).
    $this->getJson('/api/db/library/slug-info?book=' . $book)
        ->assertStatus(200)
        ->assertJson([
            'success' => true,
            'slug' => null,
            'canSet' => true,
            'encrypted' => false,
            'suggestion' => "apitest-{$token}-slug-fixture",
        ]);

    // Once set, slug-info reports it locked and stops suggesting.
    $slug = 'apitest-' . strtolower(\Illuminate\Support\Str::random(10));
    $this->postJson('/api/db/library/set-slug', ['book' => $book, 'slug' => $slug])->assertStatus(200);
    $this->getJson('/api/db/library/slug-info?book=' . $book)
        ->assertStatus(200)
        ->assertJson([
            'success' => true,
            'slug' => $slug,
            'canSet' => false,
            'suggestion' => null,
        ]);
});

/* ─── slug-check (the live availability probe) ────────────────────── */

test('GET /api/db/library/slug-check requires a logged-in user and a slug', function () {
    $this->assertApiError($this->getJson('/api/db/library/slug-check?slug=whatever'), 401);
    $this->loginUser();
    $this->assertApiError($this->getJson('/api/db/library/slug-check'), 400);
});

test('GET /api/db/library/slug-check runs the full SlugRules gauntlet, not a bare existence probe', function () {
    $user = $this->loginUser();

    // Free + well-formed → available.
    $free = 'apitest-free-' . strtolower(\Illuminate\Support\Str::random(8));
    $this->getJson('/api/db/library/slug-check?slug=' . $free)
        ->assertStatus(200)->assertJson(['success' => true, 'available' => true, 'message' => null]);

    // A reserved ROUTE word is refused even though no book owns it.
    $this->getJson('/api/db/library/slug-check?slug=maintainer')
        ->assertStatus(200)->assertJson(['available' => false])
        ->assertJsonPath('message', fn ($m) => str_contains($m, 'reserved'));

    // An existing USERNAME is refused (the impersonation guard).
    $this->getJson('/api/db/library/slug-check?slug=' . strtolower(str_replace(' ', '', $user->name)))
        ->assertStatus(200)->assertJson(['available' => false]);

    // A slug already owned by another book is refused.
    // (Book-id collisions and the rest of the gauntlet are pinned in
    // SlugBackfillTest — this endpoint only delegates to SlugRules.)
    $otherSlug = 'apitest-taken-' . strtolower(\Illuminate\Support\Str::random(8));
    $this->makeBook($user, ['slug' => $otherSlug]);
    $this->getJson('/api/db/library/slug-check?slug=' . $otherSlug)
        ->assertStatus(200)->assertJson(['available' => false]);

    // Malformed input is a verdict, not an error.
    $this->getJson('/api/db/library/slug-check?slug=' . urlencode('NOT VALID!'))
        ->assertStatus(200)->assertJson(['available' => false]);
});

test('GET /api/db/library/slug-info reports an encrypted book as not claimable', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['encrypted' => true]);
    $this->getJson('/api/db/library/slug-info?book=' . $book)
        ->assertStatus(200)
        ->assertJson([
            'success' => true,
            'slug' => null,
            'encrypted' => true,
            'canSet' => false,
            'suggestion' => null,
        ]);
});

/* ─── destroy ─────────────────────────────────────────────────────── */

test('DELETE /api/books/{book} requires authentication', function () {
    $this->assertApiError($this->deleteJson('/api/books/apitest_x'), 401);
});

test('DELETE /api/books/{book} 404s for a book that does not exist', function () {
    $this->loginUser();
    $this->assertApiError($this->deleteJson('/api/books/apitest_nope'), 404);
});

test('DELETE /api/books/{book} 403s for a non-owner of a public book', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();   // different user
    $this->assertApiError($this->deleteJson("/api/books/{$book}"), 403);
});

// NOTE: the stale-write bibliographic-preservation fix (a late client sync must
// not revert a fresher title/bibtex — DbLibraryController::upsert's $isStale
// branch) is covered end-to-end by tests/e2e/specs/workflows/library-home-sync.spec.js
// and at the unit level by tests/Unit/LibraryCardBibtexTest.php. It is NOT tested
// here because a SUCCESSFUL upsert write deadlocks under RefreshDatabase: the
// write path (updateBookOnUserPage / ShelfCacheInvalidator) touches `library`
// via pgsql_admin while the test transaction holds the row on the default
// connection — the same cross-connection block this suite avoids by only
// asserting guards that return BEFORE any write (see the file docblock).
