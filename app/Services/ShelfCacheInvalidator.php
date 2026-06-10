<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class ShelfCacheInvalidator
{
    /**
     * Flush all synthetic book nodes for a given shelf.
     * Deletes nodes for all sort variants (shelf_{id}_recent, shelf_{id}_views, etc.)
     */
    public function flush(string $shelfId): void
    {
        $pattern = 'shelf_' . $shelfId . '_%';

        $deleted = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', 'LIKE', $pattern)
            ->delete();

        // Also delete the library records for synthetic books
        DB::connection('pgsql_admin')->table('library')
            ->where('book', 'LIKE', $pattern)
            ->delete();

        if ($deleted > 0) {
            Log::info('ShelfCacheInvalidator: flushed shelf cache', [
                'shelf_id' => $shelfId,
                'nodes_deleted' => $deleted,
            ]);
        }
    }

    /**
     * Flush system shelf synthetic books for a user (public/private home pages).
     * Called when a book is deleted to ensure the home page reflects the change.
     */
    public function flushUserHomeShelves(string $username): void
    {
        $sanitized = str_replace(' ', '', $username);

        // Regeneration is handled by UserHomeServerController on next visit,
        // but we bump the timestamp to signal staleness.
        DB::connection('pgsql_admin')->table('library')
            ->whereIn('book', [$sanitized, $sanitized . 'Private'])
            ->update(['timestamp' => round(microtime(true) * 1000)]);
    }

    /**
     * Flush the render cache of every shelf that CONTAINS this book, without
     * removing the book from any shelf. Use when a book's library metadata
     * (title/author/visibility/…) changes: shelf synthetic books cache the
     * rendered cards, so without this they keep showing stale metadata until the
     * shelf is otherwise mutated. The cards regenerate (joining `library` afresh)
     * on the next render.
     *
     * Returns the affected shelf IDs.
     */
    public function flushShelvesContaining(string $book): array
    {
        $shelfIds = DB::connection('pgsql_admin')->table('shelf_items')
            ->where('book', $book)
            ->distinct()
            ->pluck('shelf_id')
            ->toArray();

        foreach ($shelfIds as $shelfId) {
            $this->flush($shelfId);
        }

        return $shelfIds;
    }

    /**
     * Remove a book from all shelves it belongs to.
     * Returns the shelf IDs that were affected so callers can flush them.
     */
    public function removeBookFromAllShelves(string $book): array
    {
        $affectedShelfIds = DB::connection('pgsql_admin')->table('shelf_items')
            ->where('book', $book)
            ->pluck('shelf_id')
            ->toArray();

        if (!empty($affectedShelfIds)) {
            DB::connection('pgsql_admin')->table('shelf_items')
                ->where('book', $book)
                ->delete();

            foreach ($affectedShelfIds as $shelfId) {
                $this->flush($shelfId);
            }
        }

        // Also remove from shelf_pins
        DB::connection('pgsql_admin')->table('shelf_pins')
            ->where('book', $book)
            ->delete();

        return $affectedShelfIds;
    }
}
