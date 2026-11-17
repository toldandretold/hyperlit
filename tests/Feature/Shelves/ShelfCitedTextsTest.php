<?php

/**
 * ShelfCitedTexts — the ONE definition of "the texts a shelf cites", shared by
 * the archive/journal page search and the vault export. Outbound hypercites
 * only (a member citing an outside book), public + content-bearing root books,
 * never a member, never a book that merely cites a member.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (afterEach admin deletes
 * deadlock against the open RefreshDatabase transaction).
 */

use App\Services\Shelves\ShelfCitedTexts;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function sctDb()
{
    return DB::connection('pgsql_admin');
}

function sctCleanup(): void
{
    sctDb()->table('hypercites')->where('book', 'LIKE', 'sctbook_%')->delete();
    sctDb()->table('library')->where('book', 'LIKE', 'sctbook_%')->delete();
}

beforeEach(fn () => sctCleanup());

function sctBook(string $tag, string $visibility = 'public', bool $hasNodes = true, string $type = 'book'): string
{
    $book = 'sctbook_' . $tag . '_' . Str::lower(Str::random(6));
    sctDb()->table('library')->insert([
        'book' => $book, 'title' => 'Sct ' . $tag, 'author' => 'Sct Author',
        'visibility' => $visibility, 'listed' => false, 'has_nodes' => $hasNodes,
        'type' => $type, 'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
    ]);

    return $book;
}

/** A hypercite row on $cited naming $citing (the row lives on the CITED book). */
function sctCite(string $cited, string $citing): void
{
    sctDb()->table('hypercites')->insert([
        'book' => $cited,
        'hyperciteId' => 'hypercite_' . Str::lower(Str::random(7)),
        'citedIN' => json_encode(['/' . $citing . '#hypercite_' . Str::lower(Str::random(7))]),
        'raw_json' => '{}',
        'created_at' => now(), 'updated_at' => now(),
    ]);
}

test('outbound partners only: cited by a member, public, with content, not a member', function () {
    $m1 = sctBook('member1');
    $m2 = sctBook('member2');
    $cited = sctBook('cited');
    $citedPrivate = sctBook('citedprivate', 'private');
    $citedEmpty = sctBook('citedempty', 'public', false);
    $citedSubBook = sctBook('citedsub', 'public', true, 'sub_book');
    $inbound = sctBook('inbound');

    sctCite($cited, $m1);          // member → outside book: a partner
    sctCite($citedPrivate, $m1);   // private target: invisible, never named
    sctCite($citedEmpty, $m1);     // no content: nothing to search or export
    sctCite($citedSubBook, $m1);   // a sub_book row is a part of a page, not a work
    sctCite($m2, $m1);             // member → member: internal edge, not a partner
    sctCite($m1, $inbound);        // outside book → member: the open door; stays shut

    $service = new ShelfCitedTexts();

    expect($service->citedBy([$m1, $m2]))->toBe([$cited]);
});

test('sub-book endpoints fold to their root: a footnote citing, and a highlight cited', function () {
    $m1 = sctBook('member');
    $cited = sctBook('target');

    // The citing side is the member's footnote sub-book; the cited side is a
    // highlight sub-book of the target. Both fold to their roots.
    sctDb()->table('hypercites')->insert([
        'book' => $cited . '/HL_abc',
        'hyperciteId' => 'hypercite_fold',
        'citedIN' => json_encode(['/' . $m1 . '/Fn1#hypercite_x']),
        'raw_json' => '{}',
        'created_at' => now(), 'updated_at' => now(),
    ]);

    expect((new ShelfCitedTexts())->citedBy([$m1]))->toBe([$cited]);
});

test('no members → nothing; the cached answer is keyed by the member set', function () {
    $m1 = sctBook('m1');
    $cited = sctBook('c');
    sctCite($cited, $m1);
    $shelfId = (string) Str::uuid();
    $service = new ShelfCitedTexts();

    expect($service->forShelf($shelfId, []))->toBe([]);
    expect($service->forShelf($shelfId, [$m1]))->toBe([$cited]);

    // A different member set is a different question — not the cached answer.
    $other = sctBook('m2');
    expect($service->forShelf($shelfId, [$other]))->toBe([]);
    expect(ShelfCitedTexts::cacheKey($shelfId, [$m1, $other]))
        ->toBe(ShelfCitedTexts::cacheKey($shelfId, [$other, $m1]))
        ->not->toBe(ShelfCitedTexts::cacheKey($shelfId, [$m1]));
});
