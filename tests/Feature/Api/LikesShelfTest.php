<?php

/**
 * The Likes shelf — every user's likes surfaced as a real shelf.
 *
 * The contract under test: liking mirrors into a `kind = 'likes'` shelf that
 * behaves like any other shelf presentationally (rename, visibility, sort,
 * public render), while its MEMBERSHIP has exactly one writer. That asymmetry
 * is the whole design, so the tests here are mostly about what CANNOT happen:
 * no manual add, no delete, and no way to edit the shelf apart from the likes
 * it mirrors.
 *
 * Why real rows rather than a view over book_likes: that table is owner-only
 * on SELECT, so a derived shelf could never be rendered for a visitor. Real
 * shelf_items let a public Likes shelf use the identical render path — which
 * "public likes shelf renders like any other" locks in.
 */

use App\Services\Shelves\LikesShelf;
use Illuminate\Support\Facades\DB;

afterEach(fn () => $this->cleanupApiFixtures());

/** The user's likes shelf row, read past RLS. */
function likesShelf(string $creator): ?object
{
    return DB::connection('pgsql_admin')->table('shelves')
        ->where('creator', $creator)->where('kind', 'likes')->first();
}

function likesShelfBooks(string $creator): array
{
    $shelf = likesShelf($creator);
    if (! $shelf) {
        return [];
    }

    return DB::connection('pgsql_admin')->table('shelf_items')
        ->where('shelf_id', $shelf->id)->pluck('book')->sort()->values()->all();
}

test('liking a book creates the Likes shelf and puts the book in it', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    expect(likesShelf($user->name))->toBeNull(); // created lazily, not at registration

    $this->postJson("/api/books/{$book}/like")->assertOk();

    $shelf = likesShelf($user->name);
    expect($shelf)->not->toBeNull();
    expect($shelf->kind)->toBe('likes');
    // Private by default: liking was a private act before this shipped, so the
    // shelf must not out anyone's back catalogue of likes.
    expect($shelf->visibility)->toBe('private');
    expect(likesShelfBooks($user->name))->toBe([$book]);
});

test('unliking removes the book from the Likes shelf', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    $this->postJson("/api/books/{$book}/like")->assertOk();
    expect(likesShelfBooks($user->name))->toBe([$book]);

    $this->deleteJson("/api/books/{$book}/like")->assertOk();
    expect(likesShelfBooks($user->name))->toBe([]);
});

test('the shelf list exposes `kind` so the client can tell the system shelf apart', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);
    $this->postJson("/api/books/{$book}/like")->assertOk();

    $shelves = collect($this->getJson('/api/shelves')->assertOk()->json('shelves'));

    $likes = $shelves->firstWhere('kind', 'likes');
    expect($likes)->not->toBeNull();
    expect($likes['item_count'])->toBe(1);
});

test('a book cannot be ADDED to the Likes shelf by hand — liking is the only way in', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);
    $other = $this->makeBook($user, ['visibility' => 'public']);
    $this->postJson("/api/books/{$book}/like")->assertOk();

    $shelf = likesShelf($user->name);
    $this->postJson("/api/shelves/{$shelf->id}/items", ['book' => $other])->assertStatus(422);

    expect(likesShelfBooks($user->name))->toBe([$book]);
});

test('removing from the Likes shelf actually UNLIKES — else the row returns on the next sync', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);
    $this->postJson("/api/books/{$book}/like")->assertOk();

    $shelf = likesShelf($user->name);
    $this->deleteJson("/api/shelves/{$shelf->id}/items/" . urlencode($book))->assertOk();

    expect(likesShelfBooks($user->name))->toBe([]);
    expect(DB::table('book_likes')->where('book', $book)->where('creator', $user->name)->exists())->toBeFalse();
});

test('the Likes shelf cannot be deleted — the likes would survive and rebuild it empty', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);
    $this->postJson("/api/books/{$book}/like")->assertOk();

    $shelf = likesShelf($user->name);
    $this->deleteJson("/api/shelves/{$shelf->id}")->assertStatus(422);

    expect(likesShelf($user->name))->not->toBeNull();
});

test('presentational edits behave like any other shelf (rename, visibility, sort)', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);
    $this->postJson("/api/books/{$book}/like")->assertOk();

    $shelf = likesShelf($user->name);
    $this->patchJson("/api/shelves/{$shelf->id}", [
        'name' => 'Things I loved',
        'visibility' => 'public',
        'default_sort' => 'recent',
    ])->assertOk();

    $after = likesShelf($user->name);
    expect($after->name)->toBe('Things I loved');
    expect($after->visibility)->toBe('public');
    expect($after->default_sort)->toBe('recent');
    // Still the likes shelf: everything keys on `kind`, never on the name.
    expect($after->kind)->toBe('likes');
});

test('reconcile() repairs a shelf whose sync half failed', function () {
    $user = $this->loginUser();
    $liked = $this->makeBook($user, ['visibility' => 'public']);
    $stale = $this->makeBook($user, ['visibility' => 'public']);

    // Seed the like through pgsql_admin, not the API: reconcile() reads
    // book_likes on the admin connection, which cannot see rows still inside
    // this test's uncommitted default-connection transaction (the same
    // cross-connection caveat BookLikeTest documents). cleanupApiFixtures
    // removes the committed row.
    DB::connection('pgsql_admin')->table('book_likes')->insert([
        'book' => $liked, 'creator' => $user->name, 'created_at' => now(),
    ]);

    // Drift both ways: a like whose mirror never landed, and a shelf row whose
    // like was removed behind the service's back.
    $shelfId = LikesShelf::ensureFor($user->name);
    DB::connection('pgsql_admin')->table('shelf_items')->insert([
        'shelf_id' => $shelfId, 'book' => $stale, 'added_at' => now(),
    ]);

    LikesShelf::reconcile($user->name);

    expect(likesShelfBooks($user->name))->toBe([$liked]);
});

test('a user already owning a shelf named "Likes" still gets one on their first like', function () {
    $user = $this->loginUser();
    $this->postJson('/api/shelves', ['name' => 'Likes'])->assertStatus(201);

    $book = $this->makeBook($user, ['visibility' => 'public']);
    $this->postJson("/api/books/{$book}/like")->assertOk();

    $shelf = likesShelf($user->name);
    expect($shelf)->not->toBeNull();
    expect($shelf->name)->not->toBe('Likes'); // fell back rather than colliding
    expect(likesShelfBooks($user->name))->toBe([$book]);
});
