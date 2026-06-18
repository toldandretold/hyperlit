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
