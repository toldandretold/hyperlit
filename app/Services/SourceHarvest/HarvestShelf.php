<?php

namespace App\Services\SourceHarvest;

use App\Services\ShelfCacheInvalidator;
use App\Services\ShelfSlug;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The "Harvested from: <Title>" shelf: every source the harvester imports
 * for a book is collected onto one shelf on the owner's page, so the whole
 * network is one click away. Keyed per (creator, name) — re-harvests of the
 * same book find the same shelf and append (the shelf_items PK dedupes).
 *
 * Owner resolution reads the ROOT book's library row: the harvest is
 * owner-triggered, so the book owner IS the triggering user. Shelves require
 * a named creator (shelves.creator is NOT NULL) and only exist on a user's
 * page, so anonymously-owned books get no shelf — returns null, and the
 * harvest simply skips the shelf step.
 *
 * All writes via pgsql_admin (queue-worker context). Caveat accepted by
 * design: two different books with the SAME title share a shelf.
 */
class HarvestShelf
{
    /** Shelf display-name prefix; the slug derives from the full name. */
    public const NAME_PREFIX = 'Harvested from: ';

    /**
     * Find-or-create the harvest shelf for a root book.
     * Returns {id, name, slug, creator} or null when the root book (and so
     * an owner) can't be resolved.
     */
    public function ensureShelfFor(string $rootBook): ?object
    {
        $db = DB::connection('pgsql_admin');

        $root = $db->table('library')
            ->where('book', $rootBook)
            ->select(['title', 'creator'])
            ->first();
        // Shelves require a named creator and only exist on a user page.
        if (!$root || !$root->creator) {
            return null;
        }

        // Keep prefix + title under the shelves.name varchar(255) cap.
        $name = self::NAME_PREFIX . Str::limit($root->title ?: $rootBook, 230, '…');

        $existing = $db->table('shelves')
            ->where('creator', $root->creator)
            ->where('name', $name)
            ->select(['id', 'name', 'slug', 'creator'])
            ->first();
        if ($existing) {
            return $existing;
        }

        $id = (string) Str::uuid();
        $slug = ShelfSlug::unique($name, $root->creator);

        // A commons book (system creator) has no user owner, so its harvest
        // shelf is a shared public artifact anyone can browse; a normal user's
        // harvest shelf stays private to them (unchanged).
        $isCommons = $root->creator === \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR;

        $db->table('shelves')->insert([
            'id'            => $id,
            'creator'       => $root->creator,
            'creator_token' => null,
            'name'          => $name,
            'slug'          => $slug,
            'description'   => 'Open-access sources cited by ' . ($root->title ?: $rootBook) . ', imported by the Source Network Harvester.',
            'visibility'    => $isCommons ? 'public' : 'private',
            'default_sort'  => 'recent',
            'created_at'    => now(),
            'updated_at'    => now(),
        ]);

        return (object) ['id' => $id, 'name' => $name, 'slug' => $slug, 'creator' => $root->creator];
    }

    /**
     * Upsert harvested books onto the shelf and flush its render cache.
     */
    public function addBooks(string $shelfId, array $bookIds): void
    {
        if (empty($bookIds)) {
            return;
        }

        $db = DB::connection('pgsql_admin');
        foreach (array_values(array_unique($bookIds)) as $bookId) {
            $db->table('shelf_items')->updateOrInsert(
                ['shelf_id' => $shelfId, 'book' => $bookId],
                ['added_at' => now()]
            );
        }

        app(ShelfCacheInvalidator::class)->flush($shelfId);
    }
}
