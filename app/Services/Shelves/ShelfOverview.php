<?php

namespace App\Services\Shelves;

use Illuminate\Support\Facades\DB;

/**
 * A shelf's OVERVIEW book (shelves.overview_book) — the member the owner
 * nominated as the shelf's intro / readme. This is the one place that decides
 * whether the stored value still counts:
 *
 *  - it must still be a MEMBER of the shelf (removed from the shelf, or
 *    deleted — BookDeletionService drops memberships — and it is inert);
 *  - for anything a VISITOR sees (the pinned card, the archive page's about,
 *    the vault's hub note) it must also be a public, readable, unencrypted book.
 *
 * Reads on pgsql_admin: shelves/shelf_items are RLS'd owner-only, and callers
 * (public renders, archive pages, export jobs) run in visitor or worker context.
 */
class ShelfOverview
{
    /** The nominated book id if it is still on the shelf, else null. */
    public static function memberBook(string $shelfId): ?string
    {
        $db = DB::connection('pgsql_admin');
        $book = $db->table('shelves')->where('id', $shelfId)->value('overview_book');
        if (!$book) {
            return null;
        }

        return $db->table('shelf_items')->where('shelf_id', $shelfId)->where('book', $book)->exists() ? $book : null;
    }

    /**
     * The overview as visitors may see it: its library row (book, title, slug,
     * creator, timestamp), or null when there is none / it isn't public + readable.
     */
    public static function publicBook(string $shelfId): ?object
    {
        $book = self::memberBook($shelfId);
        if (!$book) {
            return null;
        }

        return DB::connection('pgsql_admin')->table('library')
            ->where('book', $book)
            ->where('visibility', 'public')
            ->where('has_nodes', true)
            ->where(fn ($q) => $q->where('encrypted', false)->orWhereNull('encrypted'))
            ->first(['book', 'title', 'slug', 'creator', 'timestamp']);
    }

    /** Forget a book as overview wherever it is nominated (removed from a shelf / deleted). */
    public static function forget(string $book, ?string $shelfId = null): void
    {
        DB::connection('pgsql_admin')->table('shelves')
            ->where('overview_book', $book)
            ->when($shelfId !== null, fn ($q) => $q->where('id', $shelfId))
            ->update(['overview_book' => null]);
    }
}
