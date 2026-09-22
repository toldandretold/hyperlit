<?php

/**
 * Reserved book ids — the create-time impersonation gap.
 *
 * A book is reachable at /{book} via the catch-all (routes/web.php), so a book
 * id'd `admin` owns the /admin page — the same risk we already block for
 * usernames and vanity slugs. Book ids are USER-CHOSEN plain words (the
 * cite-form mints e.g. `nkrumah1965`), and until now nothing checked them
 * against the reserved lists: `validateBookId` did existence-only and
 * `bulkCreate` took `book` verbatim. This pins both gates.
 *
 * Only the ~30 reserved words are refused; every other plain-word id passes,
 * and the check keys on the FIRST path segment so sub-books are unaffected.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/* ── validateBookId: the live create-form probe ──────────────────────── */

it('flags a reserved word as reserved', function () {
    $this->actingAs($this->seedUser());

    $this->postJson('/api/validate-book-id', ['book' => 'admin'])
        ->assertOk()
        ->assertJsonPath('reserved', true);
});

it('flags a reserved word case-insensitively', function () {
    $this->actingAs($this->seedUser());

    $this->postJson('/api/validate-book-id', ['book' => 'ADMIN'])
        ->assertOk()
        ->assertJsonPath('reserved', true);
});

it('does NOT flag an ordinary plain-word id', function () {
    $this->actingAs($this->seedUser());

    $this->postJson('/api/validate-book-id', ['book' => 'nkrumah1965'])
        ->assertOk()
        ->assertJsonPath('reserved', false)
        ->assertJsonPath('exists', false);
});

it('does NOT flag a sub-book of a normal parent', function () {
    $this->actingAs($this->seedUser());

    // First segment is `book_123` — never a reserved word.
    $this->postJson('/api/validate-book-id', ['book' => 'book_123/Fn1'])
        ->assertOk()
        ->assertJsonPath('reserved', false);
});

/* ── bulkCreate: the server backstop for a direct POST ───────────────── */

it('refuses to create a book id\'d a reserved word', function () {
    $this->actingAs($this->seedUser());

    $this->postJson('/api/db/library/bulk-create', ['data' => [
        'book' => 'admin',
        'title' => 'Impersonator',
    ]])->assertStatus(422)->assertJson(['success' => false]);

    expect(DB::connection('pgsql_admin')->table('library')->where('book', 'admin')->exists())->toBeFalse();
});

it('refuses a sub-book claiming a reserved parent', function () {
    $this->actingAs($this->seedUser());

    $this->postJson('/api/db/library/bulk-create', ['data' => [
        'book' => 'admin/Fn1',
        'title' => 'Impersonator sub-book',
    ]])->assertStatus(422);

    expect(DB::connection('pgsql_admin')->table('library')->where('book', 'admin/Fn1')->exists())->toBeFalse();
});

it('allows a book id\'d an ordinary plain word', function () {
    $this->actingAs($this->seedUser());
    $book = 'nkrumah'.Str::random(6);

    // Assert on the response, not a DB read: the controller writes on the default
    // connection inside RefreshDatabase's transaction, which a separate
    // pgsql_admin connection cannot see. A 200 + the created record IS the proof
    // the reserved gate let it through.
    $this->postJson('/api/db/library/bulk-create', ['data' => [
        'book' => $book,
        'title' => 'Neo-Colonialism',
    ]])->assertStatus(200)
        ->assertJson(['success' => true])
        ->assertJsonPath('library.book', $book);
});
