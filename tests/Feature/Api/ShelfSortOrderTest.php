<?php

/**
 * Shelf render sort orders — the journal-page feeds ride these. Locks the
 * 'published' sort (publication order: year → volume → issue, all desc,
 * numeric-aware volume/issue strings, nulls sink) and the plain 'year' sort
 * (kept for non-journal archives).
 *
 * Seeds via pgsql_admin (shelves/shelf_items/nodes are RLS'd or admin-written),
 * beforeEach-only cleanup (afterEach admin deletes deadlock against the open
 * RefreshDatabase transaction — docs/journal-harvest.md).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function jsortDb()
{
    return DB::connection('pgsql_admin');
}

function jsortCleanup(): void
{
    $db = jsortDb();
    $shelfIds = $db->table('shelves')->where('name', 'LIKE', 'JSort %')->pluck('id');
    foreach ($shelfIds as $shelfId) {
        $db->table('nodes')->where('book', 'LIKE', 'shelf_' . $shelfId . '_%')->delete();
        $db->table('library')->where('book', 'LIKE', 'shelf_' . $shelfId . '_%')->delete();
        $db->table('shelf_items')->where('shelf_id', $shelfId)->delete();
    }
    $db->table('shelves')->whereIn('id', $shelfIds)->delete();
    $db->table('library')->where('title', 'LIKE', 'JSort %')->delete();
}

beforeEach(fn() => jsortCleanup());

/** Seed a public shelf holding books with the given biblio fields. Returns shelf id. */
function jsortSeedShelf(array $books): string
{
    $db = jsortDb();
    $shelfId = (string) Str::uuid();
    $db->table('shelves')->insert([
        'id'           => $shelfId,
        'creator'      => 'jsort_creator',
        'name'         => 'JSort ' . Str::random(6),
        'slug'         => 'jsort-' . Str::lower(Str::random(8)),
        'visibility'   => 'public',
        'default_sort' => 'recent',
        'created_at'   => now(),
        'updated_at'   => now(),
    ]);

    foreach ($books as $i => $fields) {
        $book = 'book_jsort_' . Str::lower(Str::random(8));
        $db->table('library')->insert(array_merge([
            'book'       => $book,
            'title'      => 'JSort ' . ($fields['_label'] ?? $i),
            'visibility' => 'public',
            'listed'     => false,
            'has_nodes'  => true,
            'type'       => 'book',
            'raw_json'   => '[]',
            'timestamp'  => 0,
            'created_at' => now()->subMinutes(count($books) - $i), // later seeds = newer
        ], collect($fields)->except('_label')->all()));
        $db->table('shelf_items')->insert([
            'shelf_id' => $shelfId,
            'book'     => $book,
            'added_at' => now(),
        ]);
    }

    return $shelfId;
}

/** Render the public shelf with a sort and return card titles in feed order. */
function jsortRenderedTitles(string $shelfId, string $sort): array
{
    $response = test()->getJson("/api/public/shelves/{$shelfId}/render?sort={$sort}");
    $response->assertOk();
    $bookId = $response->json('bookId');
    expect($bookId)->toBe("shelf_{$shelfId}_{$sort}_pub");

    return jsortDb()->table('nodes')
        ->where('book', $bookId)
        ->orderBy('startLine')
        ->pluck('plainText')
        ->map(fn ($t) => preg_match('/JSort \w+/', $t, $m) ? $m[0] : $t)
        ->all();
}

test('published sort: year desc, then volume desc, then issue desc, numeric-aware, nulls sink', function () {
    $shelfId = jsortSeedShelf([
        ['_label' => 'nulls',      'year' => null, 'volume' => null,  'issue' => null],
        ['_label' => 'y2020',      'year' => 2020, 'volume' => '8',   'issue' => '4'],
        ['_label' => 'v3i2',       'year' => 2024, 'volume' => '3',   'issue' => '2'],
        ['_label' => 'v12',        'year' => 2024, 'volume' => '12',  'issue' => '1'],
        ['_label' => 'vS1',        'year' => 2024, 'volume' => 'S1',  'issue' => '1'],
        ['_label' => 'v3i11',      'year' => 2024, 'volume' => '3',   'issue' => '11'],
    ]);

    $titles = jsortRenderedTitles($shelfId, 'published');

    // 2024 first: volume 12 → volume 3 (issue 11 before issue 2) → S1(=1);
    // then 2020; biblio-less last.
    expect($titles)->toBe([
        'JSort v12',
        'JSort v3i11',
        'JSort v3i2',
        'JSort vS1',
        'JSort y2020',
        'JSort nulls',
    ]);
});

test('year sort: plain publication year desc, nulls sink', function () {
    $shelfId = jsortSeedShelf([
        ['_label' => 'none', 'year' => null],
        ['_label' => 'old',  'year' => 2020],
        ['_label' => 'new',  'year' => 2024],
    ]);

    $titles = jsortRenderedTitles($shelfId, 'year');

    expect($titles)->toBe(['JSort new', 'JSort old', 'JSort none']);
});
