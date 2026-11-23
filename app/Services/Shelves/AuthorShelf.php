<?php

namespace App\Services\Shelves;

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\ShelfCacheInvalidator;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * An author's shelf — THE single writer of a `kind = 'author'` shelf's
 * membership, and of the `archive_sources` row that gives it /a/{slug}
 * (docs/authors.md).
 *
 * An author page is an archive whose shelf is MAINTAINED, not curated: a real
 * system-owned public shelf holding exactly the public, content-bearing books
 * where the author holds role `author` in `book_authors`. Being a real shelf is
 * the point — every archive feature (the feeds, full-text and semantic search,
 * cited texts, the vault export) reads shelf members, so they all work
 * unchanged. Being real also means it can drift, hence one writer: `sync()`,
 * called by AuthorLinker on every link change and by the visibility / import
 * hooks, with `reconcile()` (daily, `authors:reconcile`) as the backstop.
 * ShelfKinds::isSystem refuses every hand edit.
 *
 * The page is minted lazily, on the author's first public book — an author
 * known only from a private upload gets no empty public page.
 */
class AuthorShelf
{
    public const KIND = 'author';

    public const ARCHIVE_KIND = 'author';

    private static function db()
    {
        return DB::connection('pgsql_admin');
    }

    /** Is this archive_sources row an author's page? The one question readers may ask about the kind. */
    public static function isAuthorArchive(?object $archive): bool
    {
        return ($archive->kind ?? null) === self::ARCHIVE_KIND;
    }

    /** The shelf behind this author's page, if the page exists yet. */
    public static function shelfIdFor(string $authorId): ?string
    {
        $id = self::db()->table('archive_sources')->where('author_id', $authorId)->value('shelf_id');

        return $id ? (string) $id : null;
    }

    /** Mint the shelf + /a/{slug} row for an author (idempotent). */
    public static function ensureFor(object $author): string
    {
        if ($existing = self::shelfIdFor($author->id)) {
            return $existing;
        }

        return self::db()->transaction(function () use ($author) {
            $shelfId = (string) Str::uuid();
            self::db()->table('shelves')->insert([
                'id' => $shelfId,
                'creator' => AutoVersionResolver::CREATOR,
                'creator_token' => null,
                // (creator, name) and (creator, slug) are unique; the author slug is.
                'name' => Str::limit("Works by {$author->display_name}", 200, '') . " ({$author->slug})",
                'slug' => 'author-' . $author->slug,
                'description' => null,
                'visibility' => 'public',
                'default_sort' => 'recent',
                'kind' => self::KIND,
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            self::db()->table('archive_sources')->insert([
                'id' => (string) Str::uuid(),
                'shelf_id' => $shelfId,
                'slug' => $author->slug,
                'display_name' => $author->display_name,
                'about' => self::aboutFor($author),
                'kind' => self::ARCHIVE_KIND,
                'author_id' => $author->id,
                'certified_at' => null,
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            return $shelfId;
        });
    }

    /**
     * Bring one author's shelf into agreement with book_authors. Set-based.
     *
     * @return bool whether membership changed
     */
    public static function sync(string $authorId): bool
    {
        $wanted = self::db()->table('book_authors')
            ->join('library', 'library.book', '=', 'book_authors.book')
            ->where('book_authors.author_id', $authorId)
            ->where('book_authors.role', 'author')
            ->where('library.visibility', 'public')
            ->where('library.has_nodes', true)
            ->where('library.book', 'NOT LIKE', '%/%')
            ->pluck('library.book')
            ->all();

        $shelfId = self::shelfIdFor($authorId);
        if ($shelfId === null) {
            if ($wanted === []) {
                return false;
            }
            $author = self::db()->table('authors')->where('id', $authorId)->first();
            if (! $author) {
                return false;
            }
            $shelfId = self::ensureFor($author);
        }

        $have = self::db()->table('shelf_items')->where('shelf_id', $shelfId)->pluck('book')->all();
        $add = array_values(array_diff($wanted, $have));
        $drop = array_values(array_diff($have, $wanted));
        if ($add === [] && $drop === []) {
            return false;
        }

        foreach ($add as $book) {
            self::db()->table('shelf_items')->updateOrInsert(
                ['shelf_id' => $shelfId, 'book' => $book],
                ['added_at' => now()]
            );
        }
        if ($drop !== []) {
            self::db()->table('shelf_items')->where('shelf_id', $shelfId)->whereIn('book', $drop)->delete();
        }

        self::db()->table('shelves')->where('id', $shelfId)->update(['updated_at' => now()]);
        (new ShelfCacheInvalidator())->flush($shelfId);

        return true;
    }

    /**
     * A book changed (linked, unlinked, published, hidden, finished importing):
     * re-sync every author it is linked to, plus every author shelf still
     * holding it (the link may be the thing that just went away).
     */
    public static function syncBook(string $book): void
    {
        $linked = self::db()->table('book_authors')->where('book', $book)->pluck('author_id')->all();

        $holding = self::db()->table('shelf_items')
            ->join('archive_sources', 'archive_sources.shelf_id', '=', 'shelf_items.shelf_id')
            ->where('shelf_items.book', $book)
            ->whereNotNull('archive_sources.author_id')
            ->pluck('archive_sources.author_id')
            ->all();

        foreach (array_unique(array_merge($linked, $holding)) as $authorId) {
            self::sync((string) $authorId);
        }
    }

    /** Cheap probe for hot paths: does anything about this book concern an author shelf? */
    public static function concerns(string $book): bool
    {
        return self::db()->table('book_authors')->where('book', $book)->exists();
    }

    /** Rebuild every author's shelf. @return int shelves whose membership changed */
    public static function reconcile(): int
    {
        $changed = 0;
        self::db()->table('authors')->orderBy('id')->pluck('id')->each(function ($authorId) use (&$changed) {
            if (self::sync((string) $authorId)) {
                $changed++;
            }
        });

        return $changed;
    }

    /** Take an author's page down entirely (the author is being removed). */
    public static function remove(string $authorId): void
    {
        $shelfId = self::shelfIdFor($authorId);
        if ($shelfId === null) {
            return;
        }
        (new ShelfCacheInvalidator())->flush($shelfId);
        self::db()->table('archive_sources')->where('author_id', $authorId)->delete();
        self::db()->table('shelf_likes')->where('shelf_id', $shelfId)->delete();
        self::db()->table('shelves')->where('id', $shelfId)->delete();
    }

    /**
     * Re-derive the hero line of every author page that still carries a GENERATED one (this
     * version's, or an earlier version's Wikidata-description blurb). Copy a maintainer wrote
     * is left alone.
     *
     * @return int pages rewritten
     */
    public static function refreshAbout(): int
    {
        $n = 0;
        $rows = self::db()->table('archive_sources')->whereNotNull('author_id')->get(['id', 'author_id', 'about']);
        foreach ($rows as $row) {
            $author = self::db()->table('authors')->where('id', $row->author_id)->first();
            if (! $author) {
                continue;
            }
            $fresh = self::aboutFor($author);
            $generated = $row->about === null || in_array($row->about, self::earlierAbouts($author), true);
            if ($generated && $fresh !== $row->about) {
                self::db()->table('archive_sources')->where('id', $row->id)->update(['about' => $fresh, 'updated_at' => now()]);
                $n++;
            }
        }

        return $n;
    }

    /**
     * The hero line: the author's name and dates — "Karl Marx (1818–1883)". Plain escaped text,
     * NOT a <p>: the page sets it as its hero heading, and a <p> nested in that heading takes
     * body-paragraph colour (white on the hero in dark mode).
     *
     * Deliberately not Wikidata's one-line description, which the first version used:
     * "German-born philosopher" is somebody's contestable summary, and the hero is no place for
     * it. The description stays on the author record; the page carries no biography at all.
     */
    private static function aboutFor(object $author): ?string
    {
        $dates = '';
        if ($author->born !== null || $author->died !== null) {
            $dates = ' (' . ($author->born ?? '?') . '–' . ($author->died ?? '') . ')';
        }

        return e(trim((string) $author->display_name) . $dates);
    }

    /** What earlier versions generated for this author, so refreshAbout can tell ours from a maintainer's. */
    private static function earlierAbouts(object $author): array
    {
        $description = ucfirst(trim((string) ($author->description ?? '')));
        if ($description === '') {
            return [];
        }
        $dates = ($author->born ?? '?') . '–' . ($author->died ?? '');
        $forms = [e($description), e($description . ' · ' . $dates)];

        return array_merge($forms, array_map(fn ($f) => "<p>{$f}</p>", $forms));
    }
}
