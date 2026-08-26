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

    /** Shelf display-name prefix for journal-level harvests. */
    public const JOURNAL_NAME_PREFIX = 'Journal: ';

    /**
     * Find-or-create the public shelf for a journal-level harvest. Owned by
     * the system creator (like commons harvest shelves): the journal's corpus
     * is a shared commons artifact, not any user's collection.
     * Returns {id, name, slug, creator}.
     */
    public function ensureJournalShelfFor(\App\Models\JournalSource $journal): object
    {
        $db = DB::connection('pgsql_admin');
        $creator = \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR;

        $name = self::JOURNAL_NAME_PREFIX . Str::limit($journal->display_name, 230, '…');

        $existing = $db->table('shelves')
            ->where('creator', $creator)
            ->where('name', $name)
            ->select(['id', 'name', 'slug', 'creator'])
            ->first();
        if ($existing) {
            return $existing;
        }

        $id = (string) Str::uuid();
        $slug = ShelfSlug::unique($name, $creator);

        $db->table('shelves')->insert([
            'id'            => $id,
            'creator'       => $creator,
            'creator_token' => null,
            'name'          => $name,
            'slug'          => $slug,
            'description'   => 'Open-access articles from ' . $journal->display_name
                . ($journal->is_diamond ? ' (diamond open access)' : '')
                . ', imported by the journal harvester.',
            'visibility'    => 'public',
            'default_sort'  => 'recent',
            'created_at'    => now(),
            'updated_at'    => now(),
        ]);

        return (object) ['id' => $id, 'name' => $name, 'slug' => $slug, 'creator' => $creator];
    }

    /** Shelf display-name prefix for cited-works collections (hypercite console imports). */
    public const CITED_NAME_PREFIX = 'Cited by: ';

    /**
     * Find-or-create the public shelf collecting external works imported from
     * the hypercite console for one scope (a journal or a public shelf).
     * Owned by the system creator like journal shelves — the works belong to
     * other publishers entirely, so the collection is a commons artifact, not
     * any user's. Keyed (creator, name) like its siblings, so re-imports for
     * the same scope find the same shelf. Returns {id, name, slug, creator}.
     */
    public function ensureCitedShelfFor(string $scopeLabel): object
    {
        $db = DB::connection('pgsql_admin');
        $creator = \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR;

        $name = self::CITED_NAME_PREFIX . Str::limit($scopeLabel, 230, '…');

        $existing = $db->table('shelves')
            ->where('creator', $creator)
            ->where('name', $name)
            ->select(['id', 'name', 'slug', 'creator'])
            ->first();
        if ($existing) {
            return $existing;
        }

        $id = (string) Str::uuid();
        $slug = ShelfSlug::unique($name, $creator);

        $db->table('shelves')->insert([
            'id'            => $id,
            'creator'       => $creator,
            'creator_token' => null,
            'name'          => $name,
            'slug'          => $slug,
            'description'   => 'Open-access works cited by ' . $scopeLabel
                . ', imported from the hypercite console.',
            'visibility'    => 'public',
            'default_sort'  => 'recent',
            'created_at'    => now(),
            'updated_at'    => now(),
        ]);

        return (object) ['id' => $id, 'name' => $name, 'slug' => $slug, 'creator' => $creator];
    }

    /**
     * Reconcile a journal's shelf with the canonical truth: every canonical of
     * the journal whose best version is public and content-bearing belongs on
     * the shelf. Additive only (BookDeletionService handles removals). Also
     * heals biblio fields (year/volume/issue) on the version library rows from
     * their canonicals — version books minted before those columns were copied
     * need them for the journal page's publication-order sort.
     *
     * Returns the number of shelf_items inserted.
     */
    public function syncJournalShelfMembership(\App\Models\JournalSource $journal): int
    {
        $db = DB::connection('pgsql_admin');

        $shelfRow = $this->ensureJournalShelfFor($journal);
        if ($journal->shelf_id !== $shelfRow->id) {
            // A never-harvested journal reconciled by the command alone still
            // gets its shelf pointer.
            $db->table('journal_sources')->where('id', $journal->id)->update(['shelf_id' => $shelfRow->id]);
            $journal->shelf_id = $shelfRow->id;
        }

        $bestVersion = \App\Services\CanonicalVersions\BestVersionService::sqlCoalesceExpression('cs');

        // Heal biblio fields first, so a flushed re-render sorts correctly.
        // library.year is TEXT (display column); canonical_source.year is int.
        $db->statement("
            UPDATE library l SET
                year   = COALESCE(NULLIF(l.year, ''), cs.year::text),
                volume = COALESCE(NULLIF(l.volume, ''), cs.volume),
                issue  = COALESCE(NULLIF(l.issue, ''), cs.issue)
            FROM canonical_source cs
            WHERE cs.journal_source_id = ?
              AND l.book = ({$bestVersion})
              AND (
                    ((l.year IS NULL OR l.year = '') AND cs.year IS NOT NULL)
                 OR ((l.volume IS NULL OR l.volume = '') AND cs.volume IS NOT NULL)
                 OR ((l.issue IS NULL OR l.issue = '') AND cs.issue IS NOT NULL)
              )
        ", [$journal->id]);

        $eligible = $db->table('canonical_source as cs')
            ->join('library as l', 'l.book', '=', DB::raw("({$bestVersion})"))
            ->where('cs.journal_source_id', $journal->id)
            ->where('l.has_nodes', true)
            ->where('l.visibility', 'public')
            ->distinct()
            ->pluck('l.book');

        $existing = $db->table('shelf_items')
            ->where('shelf_id', $shelfRow->id)
            ->pluck('book');

        $missing = $eligible->diff($existing)->values();
        if ($missing->isEmpty()) {
            return 0;
        }

        foreach ($missing->chunk(500) as $chunk) {
            $db->table('shelf_items')->insert(
                $chunk->map(fn ($book) => [
                    'shelf_id' => $shelfRow->id,
                    'book'     => $book,
                    'added_at' => now(),
                ])->all()
            );
        }

        app(ShelfCacheInvalidator::class)->flush($shelfRow->id);

        return $missing->count();
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
