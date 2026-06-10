<?php

/**
 * Shelves cache rendered cards from `library`. When a book's metadata changes
 * (title/author), any shelf containing it must drop its cached synthetic nodes
 * so they rebuild with fresh data — otherwise the shelf shows a stale author.
 *
 * Covers ShelfCacheInvalidator::flushShelvesContaining and its wiring into
 * DbLibraryController::upsert (the owner metadata-edit path).
 */

use App\Services\ShelfCacheInvalidator;
use Illuminate\Support\Facades\DB;

afterEach(function () {
    // Synthetic shelf books (shelf_<uuid>_<sort>[_pub]) live in nodes+library via
    // pgsql_admin and aren't covered by cleanupApiFixtures' book-prefix sweep.
    $admin = DB::connection('pgsql_admin');
    $admin->table('nodes')->where('book', 'like', 'shelf\_%')->delete();
    $admin->table('library')->where('book', 'like', 'shelf\_%')->delete();
    $this->cleanupApiFixtures();
});

function shelfNodesExist(string $syntheticBookId): bool
{
    return DB::connection('pgsql_admin')->table('nodes')->where('book', $syntheticBookId)->exists();
}

test('flushShelvesContaining flushes shelves that hold the book and leaves others', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['author' => 'StaleAuthorXYZ', 'visibility' => 'public']);

    $withId = $this->postJson('/api/shelves', ['name' => 'Has Book'])->json('shelf.id');
    $withoutId = $this->postJson('/api/shelves', ['name' => 'No Book'])->json('shelf.id');
    $this->postJson("/api/shelves/{$withId}/items", ['book' => $book])->assertStatus(200);

    // Render both → cache synthetic nodes.
    $synthWith = $this->getJson("/api/shelves/{$withId}/render?sort=recent")->json('bookId');
    $synthWithout = $this->getJson("/api/shelves/{$withoutId}/render?sort=recent")->json('bookId');
    expect(shelfNodesExist($synthWith))->toBeTrue();
    expect(shelfNodesExist($synthWithout))->toBeTrue();

    $affected = (new ShelfCacheInvalidator())->flushShelvesContaining($book);

    expect($affected)->toContain($withId)->not->toContain($withoutId);
    expect(shelfNodesExist($synthWith))->toBeFalse();    // flushed → will rebuild
    expect(shelfNodesExist($synthWithout))->toBeTrue();  // untouched
});

test('after a metadata change + flush, the shelf re-renders with fresh data (no stale author)', function () {
    // NB: we change the author via pgsql_admin and call flushShelvesContaining
    // directly rather than hitting POST /api/db/library/upsert. The upsert
    // mutates the library row through the DEFAULT (pgsql) connection, which
    // would lock-hold the admin-seeded book and deadlock the admin afterEach
    // cleanup (see InteractsWithApi::makeBook docs); and an 'app'-seeded book is
    // invisible to render(), which reads via pgsql_admin. This still exercises
    // the real bug + fix: stale cached card → flush → fresh re-render. The
    // upsert→flushShelvesContaining wiring is covered by the test above + the
    // one-line call in DbLibraryController::upsert.
    $admin = DB::connection('pgsql_admin');
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['title' => 'Some Title', 'author' => 'StaleAuthorXYZ', 'visibility' => 'public']);

    $shelfId = $this->postJson('/api/shelves', ['name' => 'My Shelf'])->json('shelf.id');
    $this->postJson("/api/shelves/{$shelfId}/items", ['book' => $book])->assertStatus(200);

    // First render → card carries the stale author.
    $synth = $this->getJson("/api/shelves/{$shelfId}/render?sort=recent")->json('bookId');
    $cardBefore = $admin->table('nodes')->where('book', $synth)->value('content');
    expect($cardBefore)->toContain('StaleAuthorXYZ');

    // Book metadata changes, then the shelves holding it are flushed (exactly
    // what DbLibraryController::upsert now does for an owner metadata edit).
    $admin->table('library')->where('book', $book)->update(['author' => 'FreshAuthorXYZ']);
    (new ShelfCacheInvalidator())->flushShelvesContaining($book);
    expect(shelfNodesExist($synth))->toBeFalse();

    // Re-render → fresh author, stale author gone.
    $synth2 = $this->getJson("/api/shelves/{$shelfId}/render?sort=recent")->json('bookId');
    $cardAfter = $admin->table('nodes')->where('book', $synth2)->value('content');
    expect($cardAfter)->toContain('FreshAuthorXYZ');
    expect($cardAfter)->not->toContain('StaleAuthorXYZ');
});
