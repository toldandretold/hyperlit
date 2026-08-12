<?php

/**
 * HarvestShelf::syncJournalShelfMembership — shelf_items must track the
 * canonical_source.journal_source_id join (the journal page's feeds are
 * shelf-backed). Locks: eligible = public + content-bearing best version;
 * private / content-less / versionless skipped; idempotent; shelf_id stamped
 * on the journal row; pre-rendered shelf nodes flushed on change; biblio
 * (year/volume/issue) healed onto version rows from their canonicals.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (docs/journal-harvest.md).
 */

use App\Models\JournalSource;
use App\Services\SourceHarvest\HarvestShelf;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function jshelfDb()
{
    return DB::connection('pgsql_admin');
}

function jshelfCleanup(): void
{
    $db = jshelfDb();
    $shelfIds = $db->table('shelves')->where('name', 'LIKE', 'Journal: JShelf%')->pluck('id');
    foreach ($shelfIds as $shelfId) {
        $db->table('nodes')->where('book', 'LIKE', 'shelf_' . $shelfId . '_%')->delete();
        $db->table('library')->where('book', 'LIKE', 'shelf_' . $shelfId . '_%')->delete();
        $db->table('shelf_items')->where('shelf_id', $shelfId)->delete();
    }
    $db->table('shelves')->whereIn('id', $shelfIds)->delete();
    $db->table('canonical_source')->where('title', 'LIKE', 'JShelf %')->delete();
    $db->table('library')->where('title', 'LIKE', 'JShelf %')->delete();
    $db->table('journal_sources')->where('display_name', 'LIKE', 'JShelf %')->delete();
}

beforeEach(fn() => jshelfCleanup());

function jshelfSeedJournal(): JournalSource
{
    $id = (string) Str::uuid();
    jshelfDb()->table('journal_sources')->insert([
        'id'                 => $id,
        'openalex_source_id' => 'SJSHELF' . Str::upper(Str::random(6)),
        'display_name'       => 'JShelf Journal ' . Str::random(4),
        'slug'               => 'jshelf-' . Str::lower(Str::random(8)),
        'is_diamond'         => true,
        'created_at'         => now(),
        'updated_at'         => now(),
    ]);
    return JournalSource::on('pgsql_admin')->find($id);
}

function jshelfSeedWork(string $journalId, array $canonical = [], ?array $version = null): ?string
{
    $book = null;
    if ($version !== null) {
        $book = 'book_jshelf_' . Str::lower(Str::random(8));
        jshelfDb()->table('library')->insert(array_merge([
            'book'       => $book,
            'title'      => 'JShelf Version',
            'visibility' => 'public',
            'listed'     => false,
            'has_nodes'  => true,
            'type'       => 'book',
            'raw_json'   => '[]',
            'timestamp'  => 0,
            'created_at' => now(),
        ], $version));
    }

    jshelfDb()->table('canonical_source')->insert(array_merge([
        'id'                => (string) Str::uuid(),
        'title'             => 'JShelf Work ' . Str::random(4),
        'journal_source_id' => $journalId,
        'auto_version_book' => $book,
        'created_at'        => now(),
        'updated_at'        => now(),
    ], $canonical));

    return $book;
}

test('adds exactly the eligible books, stamps shelf_id, is idempotent', function () {
    $journal = jshelfSeedJournal();

    $eligible = jshelfSeedWork($journal->id, [], ['title' => 'JShelf Version Eligible']);
    jshelfSeedWork($journal->id, [], ['title' => 'JShelf Version Private', 'visibility' => 'private']);
    jshelfSeedWork($journal->id, [], ['title' => 'JShelf Version Stub', 'has_nodes' => false]);
    jshelfSeedWork($journal->id); // versionless

    $shelf = app(HarvestShelf::class);

    expect($shelf->syncJournalShelfMembership($journal))->toBe(1);

    $shelfId = jshelfDb()->table('journal_sources')->where('id', $journal->id)->value('shelf_id');
    expect($shelfId)->not->toBeNull();

    $items = jshelfDb()->table('shelf_items')->where('shelf_id', $shelfId)->pluck('book')->all();
    expect($items)->toBe([$eligible]);

    // Second run: nothing new.
    expect($shelf->syncJournalShelfMembership($journal->fresh()))->toBe(0);
});

test('flushes pre-rendered shelf nodes when membership changes', function () {
    $journal = jshelfSeedJournal();
    jshelfSeedWork($journal->id, [], ['title' => 'JShelf Version First']);

    $shelf = app(HarvestShelf::class);
    $shelf->syncJournalShelfMembership($journal);
    $shelfId = jshelfDb()->table('journal_sources')->where('id', $journal->id)->value('shelf_id');

    // Simulate a stale rendered feed.
    $staleBook = 'shelf_' . $shelfId . '_published_pub';
    jshelfDb()->table('nodes')->insert([
        'book' => $staleBook, 'chunk_id' => 0, 'startLine' => 1,
        'node_id' => $staleBook . '_1', 'content' => '<p>stale</p>', 'plainText' => 'stale',
        'type' => 'p', 'created_at' => now(), 'updated_at' => now(),
    ]);

    // New eligible work → sync inserts → flush wipes the stale render.
    jshelfSeedWork($journal->id, [], ['title' => 'JShelf Version Second']);
    expect($shelf->syncJournalShelfMembership($journal->fresh()))->toBe(1);

    expect(jshelfDb()->table('nodes')->where('book', $staleBook)->exists())->toBeFalse();
});

test('heals year/volume/issue on version rows from their canonicals', function () {
    $journal = jshelfSeedJournal();
    $book = jshelfSeedWork(
        $journal->id,
        ['year' => 2023, 'volume' => '7', 'issue' => '2'],
        ['title' => 'JShelf Version NeedsBiblio', 'year' => null]
    );

    app(HarvestShelf::class)->syncJournalShelfMembership($journal);

    $row = jshelfDb()->table('library')->where('book', $book)->first(['year', 'volume', 'issue']);
    expect($row->year)->toBe('2023'); // library.year is a TEXT display column
    expect($row->volume)->toBe('7');
    expect($row->issue)->toBe('2');
});
