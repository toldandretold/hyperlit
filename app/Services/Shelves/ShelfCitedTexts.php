<?php

namespace App\Services\Shelves;

use App\Services\Connections\ConnectionCountQuery;
use App\Services\Connections\ConnectionRefresher;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * The texts a shelf CITES: public, content-bearing books that a member of the
 * shelf hypercites and that are not themselves members. ONE definition, so the
 * archive/journal page's search, its vault export and anything else that
 * says "beyond this collection" agree on what that means.
 *
 * OUTBOUND ONLY, deliberately. A hypercite is minted by whoever edits the
 * CITING book, so an inbound edge (someone else's book citing a member) is an
 * open door: anyone could cite a shelf text from their own book and ride into
 * the archive's search results and download. An outbound edge is vouched for
 * twice — the curator chose the member, and the member's author chose the
 * citation. (The hero map, JournalHyperciteMap, still draws inbound partners
 * as "beyond this archive" dots; that is a picture, not a corpus — user
 * decision 2026-11-17 to leave it as is for now.)
 *
 * One hop only: a member citing Capital brings Capital in; Capital's own
 * citations are not the collection's claim.
 *
 * Edge storage: a hypercite row lives on the CITED book (`hypercites.book`),
 * and its `citedIN` array names the citing books ("/book_x#hypercite_y").
 * So the shelf's outbound partners are the rows whose root book is NOT a
 * member and whose citedIN names one that is. The table is small and the
 * citing side only exists inside those strings, so this is the same
 * whole-table walk the map does (JournalHyperciteMap::edges), filtered in PHP.
 *
 * Reads on pgsql_admin with EXPLICIT public + has_nodes gates: the answer is
 * viewer-independent, which is what makes caching it safe, and an invisible
 * book's existence must never leak into a public page.
 */
class ShelfCitedTexts
{
    /** Same horizon as the hero map's cache: a new hypercite shows within this. */
    public const CACHE_TTL_SECONDS = 900;

    /**
     * Cited-text ids for a shelf given its member ids, cached per
     * (shelf, member set). The members are part of the key so adding a book to
     * the shelf is never answered from a stale set.
     *
     * @param  string[]  $members  the shelf's member book ids (already visibility-filtered by the caller)
     * @return string[] book ids, sorted
     */
    public function forShelf(string $shelfId, array $members): array
    {
        if ($members === []) {
            return [];
        }

        return Cache::remember(
            self::cacheKey($shelfId, $members),
            self::CACHE_TTL_SECONDS,
            fn () => $this->citedBy($members),
        );
    }

    /**
     * Uncached: the public, content-bearing root books hypercited by any of
     * $members that are not members themselves.
     *
     * @param  string[]  $members
     * @return string[] sorted book ids
     */
    public function citedBy(array $members): array
    {
        $memberSet = [];
        foreach ($members as $m) {
            $memberSet[ConnectionCountQuery::rootBook((string) $m)] = true;
        }
        if ($memberSet === []) {
            return [];
        }

        $rows = DB::connection('pgsql_admin')->table('hypercites')
            ->whereRaw('"citedIN" IS NOT NULL AND "citedIN"::text NOT IN (\'[]\', \'null\')')
            ->get(['book', 'citedIN']);

        $candidates = [];
        foreach ($rows as $r) {
            $cited = ConnectionCountQuery::rootBook((string) $r->book);
            if ($cited === '' || isset($memberSet[$cited])) {
                continue; // a member citing a member is an internal edge, not a partner
            }
            foreach (ConnectionRefresher::booksFromCitedIn($r->citedIN) as $citing) {
                if (isset($memberSet[$citing])) {
                    $candidates[$cited] = true;
                    break;
                }
            }
        }
        if ($candidates === []) {
            return [];
        }

        // Visibility gate — the only access guard, since this runs as admin.
        $visible = [];
        foreach (array_chunk(array_keys($candidates), 1000) as $ids) {
            $found = DB::connection('pgsql_admin')->table('library')
                ->whereIn('book', $ids)
                ->where('visibility', 'public')
                ->where('has_nodes', true)
                ->where('type', '!=', 'sub_book')
                ->where('book', 'NOT LIKE', '%/%')
                ->where('book', 'NOT LIKE', 'shelf_%')
                ->pluck('book')
                ->all();
            array_push($visible, ...$found);
        }
        sort($visible);

        return $visible;
    }

    /** @param string[] $members */
    public static function cacheKey(string $shelfId, array $members): string
    {
        $sorted = array_values(array_unique(array_map('strval', $members)));
        sort($sorted);

        return 'shelf-cited-texts:v1:' . $shelfId . ':' . md5(implode("\0", $sorted));
    }
}
