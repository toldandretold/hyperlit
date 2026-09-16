<?php

namespace App\Services\Shelves;

use App\Services\ShelfCacheInvalidator;
use Illuminate\Support\Facades\DB;

/**
 * The Likes shelf — THE single writer of a `kind = 'likes'` shelf's membership.
 *
 * Every user gets one shelf that mirrors their likes. It is a real `shelves`
 * row with real `shelf_items`, so it renders, searches, pins, sorts and
 * publishes through the identical code path as any hand-made shelf — that is
 * the whole point ("it should function like a shelf"). RLS forces the choice
 * as much as parity does: `book_likes` is owner-only on SELECT, so a shelf
 * derived from it at read time could never be shown to a visitor.
 *
 * Real rows mean the shelf can DRIFT from book_likes, so membership has
 * exactly one entry point: `sync()`, called from BookLikeController::toggle in
 * the same request that writes the like. ShelfController refuses manual
 * addItem on this shelf, refuses to delete or rename it, and turns a
 * removeItem into a real unlike — so the two tables cannot be edited apart.
 * `reconcile()` repairs a shelf whose sync half failed.
 *
 * What the owner CAN change is everything presentational: visibility
 * (private by default — liking was a private act before this shipped, so the
 * backfilled shelf must not out anyone), description, sort, profile display.
 */
class LikesShelf
{
    public const KIND = 'likes';

    /** Is this shelf row (or id) the likes shelf? */
    public static function isLikesShelf(?object $shelf): bool
    {
        return ($shelf->kind ?? 'user') === self::KIND;
    }

    /**
     * The user's Likes shelf id, creating the row on first use.
     *
     * Created lazily rather than at registration: a user who never likes
     * anything never gets an empty system shelf cluttering their profile.
     */
    public static function ensureFor(string $creator): string
    {
        $existing = DB::connection('pgsql_admin')->table('shelves')
            ->where('creator', $creator)
            ->where('kind', self::KIND)
            ->value('id');

        if ($existing) {
            return (string) $existing;
        }

        return (string) DB::connection('pgsql_admin')->table('shelves')->insertGetId([
            'creator' => $creator,
            'creator_token' => null,
            'name' => self::freeValue($creator, 'name', ['Likes', 'Liked', 'My Likes']),
            'slug' => self::freeValue($creator, 'slug', ['likes', 'liked', 'my-likes']),
            'description' => null,
            'visibility' => 'private',
            'default_sort' => 'added',
            'kind' => self::KIND,
            'created_at' => now(),
            'updated_at' => now(),
        ], 'id');
    }

    /**
     * Mirror one like/unlike into the shelf. Called by BookLikeController after
     * the book_likes write, with the SAME already-root-resolved book id — the
     * shelf must not hold a sub-book the likes table doesn't.
     */
    public static function sync(string $creator, string $book, bool $liked): void
    {
        $shelfId = self::ensureFor($creator);

        if ($liked) {
            DB::connection('pgsql_admin')->table('shelf_items')->updateOrInsert(
                ['shelf_id' => $shelfId, 'book' => $book],
                ['added_at' => now()]
            );
        } else {
            DB::connection('pgsql_admin')->table('shelf_items')
                ->where('shelf_id', $shelfId)
                ->where('book', $book)
                ->delete();
        }

        DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $shelfId)
            ->update(['updated_at' => now()]);

        // Renders are cached as synthetic books keyed by shelf id + sort;
        // without this the shelf shows yesterday's likes (see the caching note
        // in ConnectionCountQuery's review gate — same invalidation trap).
        (new ShelfCacheInvalidator())->flush($shelfId);
    }

    /**
     * Force the shelf back into agreement with book_likes. Set-based, so it is
     * cheap enough to call on a read path if drift is ever suspected.
     */
    public static function reconcile(string $creator): void
    {
        $shelfId = self::ensureFor($creator);

        DB::connection('pgsql_admin')->statement(
            "INSERT INTO shelf_items (shelf_id, book, added_at)
             SELECT ?, book, created_at FROM book_likes WHERE creator = ?
             ON CONFLICT (shelf_id, book) DO NOTHING",
            [$shelfId, $creator]
        );

        DB::connection('pgsql_admin')->statement(
            "DELETE FROM shelf_items
             WHERE shelf_id = ?
               AND book NOT IN (SELECT book FROM book_likes WHERE creator = ?)",
            [$shelfId, $creator]
        );

        (new ShelfCacheInvalidator())->flush($shelfId);
    }

    /**
     * First unused value for a uniquely-indexed column. A user may already own
     * a shelf called "Likes"/slugged "likes"; (creator, name) and the slug are
     * unique, so collide gracefully instead of throwing on their first like.
     */
    private static function freeValue(string $creator, string $column, array $candidates): string
    {
        foreach ($candidates as $candidate) {
            $taken = DB::connection('pgsql_admin')->table('shelves')
                ->where('creator', $creator)
                ->where($column, $candidate)
                ->exists();

            if (! $taken) {
                return $candidate;
            }
        }

        return $candidates[0] . ' ' . substr(md5($creator), 0, 6);
    }
}
