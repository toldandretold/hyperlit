<?php

/**
 * Likes (POST/DELETE /api/books/{book}/like, GET /api/books/{book}/likes).
 *
 * The contract under test: logged-in only (guests 401 on the write verbs);
 * one like per (book, user) with an idempotent double-like; RLS makes another
 * user's like untouchable; the public count endpoint aggregates past RLS via
 * pgsql_admin; and ReadStatsCounter is the sole writer of library.total_likes.
 *
 * The count/liked assertions seed book_likes via pgsql_admin (the controller
 * counts through the admin connection, which cannot see rows still inside the
 * test's uncommitted default-connection transaction); those committed rows are
 * removed by cleanupApiFixtures.
 */

use App\Services\Stats\ReadStatsCounter;
use Illuminate\Support\Facades\DB;

afterEach(fn () => $this->cleanupApiFixtures());

test('guests cannot like or unlike', function () {
    $book = $this->makeBook(null, ['visibility' => 'public']);

    $this->postJson("/api/books/{$book}/like")->assertStatus(401);
    $this->deleteJson("/api/books/{$book}/like")->assertStatus(401);
});

test('a logged-in user can like once — a double-like is a no-op, not an error', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    $this->postJson("/api/books/{$book}/like")->assertOk();
    $this->postJson("/api/books/{$book}/like")->assertOk();

    // Default connection: RLS shows the requester their own rows.
    expect(DB::table('book_likes')->where('book', $book)->where('creator', $user->name)->count())->toBe(1);
});

test('unlike removes the row', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    $this->postJson("/api/books/{$book}/like")->assertOk();
    $this->deleteJson("/api/books/{$book}/like")->assertOk();

    expect(DB::table('book_likes')->where('book', $book)->count())->toBe(0);
});

test('RLS: one user cannot delete another user\'s like', function () {
    $victim = $this->apiUser();
    $book = $this->makeBook($victim, ['visibility' => 'public']);
    DB::connection('pgsql_admin')->table('book_likes')->insert([
        'book' => $book,
        'creator' => $victim->name,
        'created_at' => now(),
    ]);

    $this->loginUser();
    $this->deleteJson("/api/books/{$book}/like")->assertOk(); // deletes NOTHING of the victim's

    expect(DB::connection('pgsql_admin')->table('book_likes')->where('book', $book)->count())->toBe(1);
});

test('the public count endpoint returns the aggregate and the requester\'s own liked state', function () {
    $liker = $this->apiUser();
    $other = $this->apiUser();
    $book = $this->makeBook($liker, ['visibility' => 'public']);
    foreach ([$liker, $other] as $u) {
        DB::connection('pgsql_admin')->table('book_likes')->insert([
            'book' => $book,
            'creator' => $u->name,
            'created_at' => now(),
        ]);
    }

    // Anonymous: full count, never "liked".
    $this->getJson("/api/books/{$book}/likes")
        ->assertOk()
        ->assertJson(['count' => 2, 'liked' => false]);

    // The liker themselves: same count, liked=true.
    $this->actingAs($liker)
        ->getJson("/api/books/{$book}/likes")
        ->assertOk()
        ->assertJson(['count' => 2, 'liked' => true]);
});

test('ReadStatsCounter recomputes library.total_likes as the row count', function () {
    $user = $this->apiUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);
    DB::connection('pgsql_admin')->table('book_likes')->insert([
        'book' => $book,
        'creator' => $user->name,
        'created_at' => now(),
    ]);

    (new ReadStatsCounter())->recomputeLikes([$book]);

    $likes = DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('total_likes');
    expect((int) $likes)->toBe(1);
});
