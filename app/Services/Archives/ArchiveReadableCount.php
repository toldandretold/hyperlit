<?php

namespace App\Services\Archives;

use Illuminate\Support\Facades\DB;

/**
 * How many of an archive's documents can actually be READ: the books on its
 * shelf that have content and are visible to the CALLER. This is the "N
 * documents" figure on /a/{slug} and the homepage's certified-archive list —
 * one definition, two callers, mirroring JournalReadableCount.
 *
 * Split-connection read, deliberately: shelf_items' SELECT policy is
 * owner-only, so a guest's default connection sees an empty shelf — membership
 * comes via pgsql_admin (the archive's shelf is public by construction, gated
 * upstream). The library count then runs on the DEFAULT connection so
 * visibility stays the caller's RLS view: a guest must not be told about
 * documents they cannot open.
 */
class ArchiveReadableCount
{
    /**
     * Readable counts for many archives in one pass.
     *
     * @param  array<string, string>  $shelfByArchiveId  archive id => shelf_id
     * @return array<string, int>  archive id => readable count (absent = 0)
     */
    public function forArchives(array $shelfByArchiveId): array
    {
        if (empty($shelfByArchiveId)) {
            return [];
        }

        $items = DB::connection('pgsql_admin')->table('shelf_items')
            ->whereIn('shelf_id', array_values($shelfByArchiveId))
            ->get(['shelf_id', 'book']);
        if ($items->isEmpty()) {
            return [];
        }

        $readableBooks = DB::table('library')
            ->whereIn('book', $items->pluck('book')->unique()->all())
            ->where('has_nodes', true)
            ->pluck('book')
            ->flip();

        $byShelf = [];
        foreach ($items as $item) {
            if (isset($readableBooks[$item->book])) {
                $byShelf[$item->shelf_id] = ($byShelf[$item->shelf_id] ?? 0) + 1;
            }
        }

        $counts = [];
        foreach ($shelfByArchiveId as $archiveId => $shelfId) {
            $counts[$archiveId] = $byShelf[$shelfId] ?? 0;
        }

        return $counts;
    }

    /** Readable count for one archive's shelf. */
    public function for(string $archiveId, string $shelfId): int
    {
        return $this->forArchives([$archiveId => $shelfId])[$archiveId] ?? 0;
    }
}
