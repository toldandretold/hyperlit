<?php

namespace App\Services\Shelves;

use App\Services\ShelfCacheInvalidator;
use App\Support\Licenses;
use Illuminate\Support\Facades\DB;

/**
 * "Might not be OK to publish" — THE single writer of a `kind = 'licence_review'` shelf.
 *
 * A user's upload that they VERIFIED as someone else's published work (the PDF of a journal
 * article: library.canonical_match_method = 'user_verified'), still PUBLIC, whose licence is
 * all rights reserved or unknown, might not be legal for them to publish. That is the owner's
 * call, not ours — HostingPolicy deliberately never hides a user's book — so instead of hiding
 * anything we collect those books on one private shelf they can work through, making each
 * private if they decide to. A book leaves the shelf when it stops matching (made private,
 * relicensed, deleted). The explainer book (config licensing.copyright_explainer_book) is
 * pinned first. No flagged books → no shelf.
 *
 * Membership has one entry point, reconcile(); ShelfController refuses manual add/remove on it
 * (ShelfKinds::isSystem). Private, like Likes: whether someone's books are flagged is nobody
 * else's business.
 */
class LicenceReviewShelf
{
    public const KIND = 'licence_review';

    /** Licences under which a verified third-party work might not be publishable. */
    public const FLAGGED_LICENCES = ['All-Rights-Reserved', Licenses::UNKNOWN];

    /** @return list<string> the owner's books that belong on the shelf (sorted) */
    public static function flaggedBooks(string $creator): array
    {
        return DB::connection('pgsql_admin')->table('library')
            ->where('creator', $creator)
            ->where('visibility', 'public')
            ->where('has_nodes', true)
            ->where('canonical_match_method', 'user_verified')
            ->whereIn('license', self::FLAGGED_LICENCES)
            ->where('book', 'not like', '%/%')
            ->orderBy('title')
            ->pluck('book')->map(fn ($b) => (string) $b)->all();
    }

    /** Users who have at least one flagged book, or a shelf that may need emptying. */
    public static function candidateCreators(): array
    {
        $flagged = DB::connection('pgsql_admin')->table('library')
            ->where('visibility', 'public')->where('has_nodes', true)
            ->where('canonical_match_method', 'user_verified')
            ->whereIn('license', self::FLAGGED_LICENCES)
            ->where('book', 'not like', '%/%')
            ->whereNotNull('creator')
            ->distinct()->pluck('creator');
        $shelved = DB::connection('pgsql_admin')->table('shelves')->where('kind', self::KIND)->pluck('creator');

        return $flagged->merge($shelved)->unique()->values()->all();
    }

    public static function explainerBook(): ?string
    {
        $ref = trim((string) config('licensing.copyright_explainer_book'));
        if ($ref === '') {
            return null;
        }

        return DB::connection('pgsql_admin')->table('library')
            ->where(fn ($q) => $q->where('book', $ref)->orWhere('slug', $ref))
            ->where('visibility', 'public')
            ->value('book');
    }

    public static function shelfFor(string $creator): ?object
    {
        return DB::connection('pgsql_admin')->table('shelves')
            ->where('creator', $creator)->where('kind', self::KIND)->first(['id', 'slug', 'name']);
    }

    /**
     * Bring the shelf into agreement with flaggedBooks(). Returns the flagged books (empty →
     * the shelf was removed, or never existed).
     *
     * @return list<string>
     */
    public static function reconcile(string $creator): array
    {
        $db = DB::connection('pgsql_admin');
        $books = self::flaggedBooks($creator);
        $shelf = self::shelfFor($creator);

        if (! $books) {
            if ($shelf) {
                $db->table('shelf_items')->where('shelf_id', $shelf->id)->delete();
                $db->table('shelves')->where('id', $shelf->id)->delete();
                (new ShelfCacheInvalidator())->flush((string) $shelf->id);
            }

            return [];
        }

        $shelfId = $shelf ? (string) $shelf->id : self::create($creator);
        $explainer = self::explainerBook();
        $want = $explainer ? array_merge([$explainer], $books) : $books;

        $db->table('shelf_items')->where('shelf_id', $shelfId)->whereNotIn('book', $want)->delete();
        foreach ($want as $i => $book) {
            $db->table('shelf_items')->updateOrInsert(
                ['shelf_id' => $shelfId, 'book' => $book],
                ['manual_position' => $i, 'added_at' => now()],
            );
        }
        $db->table('shelves')->where('id', $shelfId)->update(['updated_at' => now()]);
        (new ShelfCacheInvalidator())->flush($shelfId);

        return $books;
    }

    private static function create(string $creator): string
    {
        return (string) DB::connection('pgsql_admin')->table('shelves')->insertGetId([
            'creator' => $creator,
            'creator_token' => null,
            'name' => self::freeValue($creator, 'name', ['Might not be OK to publish', 'Licence check', 'Copyright check']),
            'slug' => self::freeValue($creator, 'slug', ['might-not-be-ok-to-publish', 'licence-check', 'copyright-check']),
            'description' => 'Books you have published that are someone else\'s work and might not be licensed for publishing. Your call — make any private if you decide to.',
            'visibility' => 'private',
            'default_sort' => 'manual',
            'kind' => self::KIND,
            'created_at' => now(),
            'updated_at' => now(),
        ], 'id');
    }

    private static function freeValue(string $creator, string $column, array $candidates): string
    {
        foreach ($candidates as $candidate) {
            if (! DB::connection('pgsql_admin')->table('shelves')->where('creator', $creator)->where($column, $candidate)->exists()) {
                return $candidate;
            }
        }

        return $candidates[0] . ' ' . substr(md5($creator), 0, 6);
    }
}
