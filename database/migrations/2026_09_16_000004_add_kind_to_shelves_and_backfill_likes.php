<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * The Likes shelf — every user's likes, surfaced as a real shelf.
 *
 * `kind` distinguishes the one system shelf ('likes') from user-made ones
 * ('user'). It is a REAL shelves row with REAL shelf_items, not a view over
 * book_likes, and that is forced by RLS rather than chosen for convenience:
 * book_likes is owner-only on SELECT, so a derived shelf could never be
 * rendered for a visitor without punching a hole in that policy. Real rows let
 * a public Likes shelf go through the identical render/search/pin path as any
 * other shelf.
 *
 * The cost of real rows is drift, so membership has exactly ONE writer —
 * App\Services\Shelves\LikesShelf, called from BookLikeController::toggle.
 * Nothing else may INSERT into a kind='likes' shelf (ShelfController::addItem
 * refuses), and this migration is the only bulk populater.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement(
            "ALTER TABLE shelves ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'user'"
        );

        // One Likes shelf per user. Partial unique index so user-made shelves
        // are untouched by it — the existing (creator, name) unique still
        // governs those.
        DB::connection('pgsql_admin')->statement(
            "CREATE UNIQUE INDEX IF NOT EXISTS shelves_creator_likes_unique
             ON shelves (creator) WHERE kind = 'likes'"
        );

        $this->backfill();
    }

    /**
     * Give every user who already has likes a populated Likes shelf, so the
     * feature doesn't start empty for existing users.
     */
    private function backfill(): void
    {
        $creators = DB::connection('pgsql_admin')
            ->table('book_likes')
            ->distinct()
            ->pluck('creator');

        foreach ($creators as $creator) {
            if (! $creator) {
                continue;
            }

            $existing = DB::connection('pgsql_admin')->table('shelves')
                ->where('creator', $creator)->where('kind', 'likes')->value('id');

            $shelfId = $existing ?: DB::connection('pgsql_admin')->table('shelves')->insertGetId([
                'creator' => $creator,
                'creator_token' => null,
                // A user may already own a shelf literally called "Likes" —
                // (creator, name) is unique, so fall back rather than blow up
                // the whole migration on one collision.
                'name' => $this->freeName($creator),
                'slug' => $this->freeSlug($creator),
                'description' => null,
                'visibility' => 'private', // private until the owner opts in
                'default_sort' => 'added',
                'kind' => 'likes',
                'created_at' => now(),
                'updated_at' => now(),
            ], 'id');

            // Mirror this creator's likes in as shelf_items. ON CONFLICT so a
            // re-run (or a partially-applied migration) is idempotent.
            DB::connection('pgsql_admin')->statement(
                "INSERT INTO shelf_items (shelf_id, book, added_at)
                 SELECT ?, book, created_at FROM book_likes WHERE creator = ?
                 ON CONFLICT (shelf_id, book) DO NOTHING",
                [$shelfId, $creator]
            );
        }
    }

    private function freeName(string $creator): string
    {
        foreach (['Likes', 'Liked', 'My Likes'] as $candidate) {
            $taken = DB::connection('pgsql_admin')->table('shelves')
                ->where('creator', $creator)->where('name', $candidate)->exists();
            if (! $taken) {
                return $candidate;
            }
        }

        return 'Likes ' . substr(md5($creator), 0, 6);
    }

    private function freeSlug(string $creator): string
    {
        foreach (['likes', 'liked', 'my-likes'] as $candidate) {
            $taken = DB::connection('pgsql_admin')->table('shelves')
                ->where('creator', $creator)->where('slug', $candidate)->exists();
            if (! $taken) {
                return $candidate;
            }
        }

        return 'likes-' . substr(md5($creator), 0, 6);
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DELETE FROM shelves WHERE kind = 'likes'");
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS shelves_creator_likes_unique');
        DB::connection('pgsql_admin')->statement('ALTER TABLE shelves DROP COLUMN IF EXISTS kind');
    }
};
