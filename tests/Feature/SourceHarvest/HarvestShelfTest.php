<?php

/**
 * HarvestShelf — the "Harvested from: <Title>" shelf the Source Network
 * Harvester collects its sources onto. No-network: the service is called
 * directly against admin-seeded rows. Admin writes commit (RefreshDatabase
 * can't roll them back), so everything seeded here is cleaned in afterEach.
 */

use App\Services\SourceHarvest\HarvestShelf;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function hshelfDb()
{
    return DB::connection('pgsql_admin');
}

function hshelfSeedBook(array $opts = []): string
{
    $book = $opts['book'] ?? ('harvtest_' . Str::random(10));
    hshelfDb()->table('library')->insert(array_merge([
        'book'       => $book,
        'title'      => 'HarvTest Root Book',
        'visibility' => 'private',
        'raw_json'   => json_encode(['book' => $book]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $opts));
    return $book;
}

afterEach(function () {
    $shelfIds = hshelfDb()->table('shelves')->where('name', 'like', 'Harvested from: HarvTest%')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        hshelfDb()->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        hshelfDb()->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
    hshelfDb()->table('library')->where('book', 'like', 'harvtest\_%')->delete();
});

test('creates the shelf for a named owner and adds the harvested books', function () {
    $root = hshelfSeedBook(['title' => 'HarvTest Neoliberalism', 'creator' => 'harvtest_user']);
    $a = hshelfSeedBook(['title' => 'HarvTest Source A']);
    $b = hshelfSeedBook(['title' => 'HarvTest Source B']);

    $svc = app(HarvestShelf::class);
    $shelf = $svc->ensureShelfFor($root);

    expect($shelf)->not->toBeNull();
    expect($shelf->name)->toBe('Harvested from: HarvTest Neoliberalism');
    expect($shelf->slug)->toBe('harvested-from-harvtest-neoliberalism');
    expect($shelf->creator)->toBe('harvtest_user');

    $row = hshelfDb()->table('shelves')->where('id', $shelf->id)->first();
    expect($row->visibility)->toBe('private');
    expect($row->creator_token)->toBeNull();

    $svc->addBooks($shelf->id, [$a, $b]);
    expect(hshelfDb()->table('shelf_items')->where('shelf_id', $shelf->id)->count())->toBe(2);
});

test('re-harvest finds the SAME shelf and appends without duplicates', function () {
    $root = hshelfSeedBook(['title' => 'HarvTest Rerun', 'creator' => 'harvtest_user']);
    $a = hshelfSeedBook(['title' => 'HarvTest Source A']);
    $b = hshelfSeedBook(['title' => 'HarvTest Source B']);

    $svc = app(HarvestShelf::class);
    $first = $svc->ensureShelfFor($root);
    $svc->addBooks($first->id, [$a]);

    $second = $svc->ensureShelfFor($root);
    expect($second->id)->toBe($first->id);

    $svc->addBooks($second->id, [$a, $b]); // $a again + one new
    expect(hshelfDb()->table('shelf_items')->where('shelf_id', $first->id)->count())->toBe(2);
});

test('a max-length (255-char) title is truncated to fit the shelf name column', function () {
    // library.title is varchar(255); the "Harvested from: " prefix would push
    // the untruncated name past shelves.name's 255 cap, so it must truncate.
    $root = hshelfSeedBook([
        'title'   => 'HarvTest ' . str_repeat('X', 246), // exactly 255 chars
        'creator' => 'harvtest_user',
    ]);

    $shelf = app(HarvestShelf::class)->ensureShelfFor($root);

    expect($shelf)->not->toBeNull();
    expect(mb_strlen($shelf->name))->toBeLessThanOrEqual(255);
    expect($shelf->name)->toStartWith('Harvested from: HarvTest');
});

test('returns null when the root book has no named owner (anonymous or missing)', function () {
    // Anonymously-owned books get no shelf: shelves need a named creator and
    // only live on a user page.
    $anon = hshelfSeedBook(['title' => 'HarvTest Anon Book', 'creator' => null, 'creator_token' => (string) Str::uuid()]);
    expect(app(HarvestShelf::class)->ensureShelfFor($anon))->toBeNull();
    expect(app(HarvestShelf::class)->ensureShelfFor('harvtest_no_such_book'))->toBeNull();
});

test('addBooks flushes the shelf render cache (synthetic nodes removed)', function () {
    $root = hshelfSeedBook(['title' => 'HarvTest CacheFlush', 'creator' => 'harvtest_user']);
    $a = hshelfSeedBook(['title' => 'HarvTest Source A']);

    $svc = app(HarvestShelf::class);
    $shelf = $svc->ensureShelfFor($root);

    // Simulate a previously rendered synthetic shelf book
    hshelfSeedBook(['book' => "shelf_{$shelf->id}_recent", 'title' => 'HarvTest Synthetic']);

    $svc->addBooks($shelf->id, [$a]);

    expect(hshelfDb()->table('library')->where('book', "shelf_{$shelf->id}_recent")->exists())->toBeFalse();
});
