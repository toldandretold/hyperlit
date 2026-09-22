<?php

/**
 * Private-highlight privacy: the fail-closed derived-sub-book-id pass.
 *
 * The 2026-09-21 leak: every privacy layer (RLS policy, getHyperlights filter,
 * find(), the client gate) keyed off hyperlights.sub_book_id → library and
 * FAILED OPEN when the linkage was missing — and SubBookController::
 * setVisibility's missing-row grace path wrote the private library row without
 * ever stamping sub_book_id (nor slug-resolving the parent). Result: a reader's
 * "private" highlight was fully visible to the book owner via its deep link.
 *
 * These tests pin the repro shape (a hyperlight row with a NULL sub_book_id
 * next to a private library row at the DERIVED id {book}/{hyperlight_id}) and
 * the two repair paths (setVisibility stamps the linkage + resolves slugs;
 * bulkCreate mints the sub-book row honouring sub_book_visibility).
 */

use Illuminate\Support\Facades\DB;

// cleanupApiFixtures defers internally (past the rollback) and clears the
// admin-seeded hyperlights too — see InteractsWithApi.
afterEach(fn () => $this->cleanupApiFixtures());

/** The repro shape: highlight row WITHOUT linkage + private library row at the derived id. */
function seedUnlinkedPrivateHighlight(string $book, string $hlId, $creatorUser): string
{
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book,
        'hyperlight_id' => $hlId,
        'sub_book_id' => null, // ← the missing linkage
        'creator' => $creatorUser->name,
        'highlightedText' => 'a privately marked passage',
        'raw_json' => json_encode([]),
        'hidden' => false,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    $derived = $book.'/'.$hlId;
    DB::connection('pgsql_admin')->table('library')->insert([
        'book' => $derived,
        'creator' => $creatorUser->name,
        'visibility' => 'private',
        'listed' => false,
        'title' => 'Annotation: '.$hlId,
        'type' => 'sub_book',
        'raw_json' => json_encode([]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $derived;
}

test('an UNLINKED private highlight is hidden from the book owner on the deep-link pull (the leak repro)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $reader = $this->apiUser();
    seedUnlinkedPrivateHighlight($book, 'HL_leak1', $reader);

    // The book OWNER follows the deep link — must 404, not serve the highlight.
    $this->actingAs($owner);
    $this->getJson("/api/db/hyperlights/find/{$book}/HL_leak1")->assertStatus(404);
});

test('the creator still sees their own unlinked private highlight via find', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $reader = $this->apiUser();
    seedUnlinkedPrivateHighlight($book, 'HL_leak2', $reader);

    $this->actingAs($reader);
    $resp = $this->getJson("/api/db/hyperlights/find/{$book}/HL_leak2")->assertStatus(200);
    expect($resp->json('hyperlight.sub_book_visibility'))->toBe('private');
});

test('an UNLINKED private highlight is excluded from the annotations payload for non-creators', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $reader = $this->apiUser();
    seedUnlinkedPrivateHighlight($book, 'HL_leak3', $reader);

    $this->actingAs($owner);
    $ids = collect($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hyperlights'))->pluck('hyperlight_id');
    expect($ids)->not->toContain('HL_leak3');

    $this->actingAs($reader);
    $ids = collect($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hyperlights'))->pluck('hyperlight_id');
    expect($ids)->toContain('HL_leak3');
});

test('RLS itself hides an unlinked private highlight from a stranger (raw select, app role)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $reader = $this->apiUser();
    seedUnlinkedPrivateHighlight($book, 'HL_leak4', $reader);
    $stranger = $this->apiUser();

    // Default (RLS-enforced) connection as the stranger.
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$stranger->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$stranger->user_token]);
    $visible = DB::table('hyperlights')->where('book', $book)->pluck('hyperlight_id');
    expect($visible)->not->toContain('HL_leak4');

    // …and shows the creator their own row.
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$reader->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$reader->user_token]);
    $visible = DB::table('hyperlights')->where('book', $book)->pluck('hyperlight_id');
    expect($visible)->toContain('HL_leak4');
});

test('setVisibility STAMPS the missing sub_book_id linkage on an unlinked row', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $reader = $this->apiUser();
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book,
        'hyperlight_id' => 'HL_stamp1',
        'sub_book_id' => null,
        'creator' => $reader->name,
        'raw_json' => json_encode([]),
        'hidden' => false,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $this->actingAs($reader);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_stamp1', 'visibility' => 'private',
    ])->assertStatus(200);

    $admin = DB::connection('pgsql_admin');
    expect($admin->table('hyperlights')->where('hyperlight_id', 'HL_stamp1')->value('sub_book_id'))
        ->toBe($book.'/HL_stamp1');
    expect($admin->table('library')->where('book', $book.'/HL_stamp1')->value('visibility'))
        ->toBe('private');
});

test('setVisibility resolves a SLUG parent so the sub-book id matches what readers derive', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'slug' => 'apitest-slug-'.\Illuminate\Support\Str::random(6)]);
    $slug = DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('slug');
    $reader = $this->apiUser();

    // Grace path: no hyperlight row yet, control posts the SLUG as parentBook.
    $this->actingAs($reader);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $slug, 'itemId' => 'HL_slug1', 'visibility' => 'private',
    ])->assertStatus(200);

    // The library row lands at the CANONICAL id — the id every reader endpoint
    // derives — never at "{slug}/HL_…", which nothing would ever check.
    $admin = DB::connection('pgsql_admin');
    expect($admin->table('library')->where('book', $book.'/HL_slug1')->exists())->toBeTrue();
    expect($admin->table('library')->where('book', $slug.'/HL_slug1')->exists())->toBeFalse();
});

test('flipping a highlight private RETRACTS the notification already sent for it', function () {
    // A highlight is born public → the owner is notified. Flipping it private
    // afterward must retract that notification (the residual leak the e2e
    // caught): the row is deleted, so an unread dot clears and a read row
    // vanishes from the feed.
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $reader = $this->apiUser();

    // Simulate the create-time notification (public highlight).
    DB::connection('pgsql_admin')->table('notifications')->insert([
        'recipient' => $owner->name,
        'actor' => $reader->name,
        'type' => 'hyperlight',
        'book' => $book,
        'root_book' => $book,
        'subject_id' => 'HL_retract1',
        'data' => json_encode(['context_label' => 'your book', 'snippet' => 'secret text']),
        'created_at' => now(),
    ]);
    // …and the highlight row the reader owns.
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book, 'hyperlight_id' => 'HL_retract1', 'sub_book_id' => null,
        'creator' => $reader->name, 'raw_json' => json_encode([]), 'hidden' => false,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    expect(DB::connection('pgsql_admin')->table('notifications')->where('recipient', $owner->name)->count())->toBe(1);

    $this->actingAs($reader);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_retract1', 'visibility' => 'private',
    ])->assertStatus(200);

    expect(DB::connection('pgsql_admin')->table('notifications')->where('recipient', $owner->name)->count())->toBe(0);
});

test('bulkCreate mints the sub-book library row and honours sub_book_visibility', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $reader = $this->loginUser();

    // bulk-create inserts via the query builder (no Eloquent casts), so json
    // columns ride the wire pre-encoded — matching the existing callers.
    $this->postJson('/api/db/hyperlights/bulk-create', ['data' => [[
        'book' => $book,
        'hyperlight_id' => 'HL_bulkpriv',
        'node_id' => json_encode([$book.'_100_aaaa']),
        'charData' => json_encode(new stdClass()),
        'highlightedText' => 'born private through bulk-create',
        'sub_book_visibility' => 'private',
    ]]])->assertStatus(200);

    // Row created on the default connection under the caller's RLS context.
    $sub = DB::table('library')->where('book', $book.'/HL_bulkpriv')->first();
    expect($sub)->not->toBeNull();
    expect($sub->visibility)->toBe('private');
    expect($sub->creator)->toBe($reader->name);

    // And a private birth stays silent for the book owner.
    expect(DB::connection('pgsql_admin')->table('notifications')
        ->where('recipient', $owner->name)->count())->toBe(0);
});
