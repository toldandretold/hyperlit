<?php

/**
 * The homepage feeds (most-recent / most-connected / most-lit) after the
 * generation unification: HomePageServerController delegates ranking to
 * ConnectionCountQuery::sortConnected()/sortLit() and card HTML to
 * LibraryCardGenerator — the same delegation every shelf/user feed uses.
 *
 * Asserts BEHAVIOR the string-scan gate in ConnectionScoreSingleDefinitionTest
 * can't: the served order actually follows the one connectedness definition,
 * and the cards are generator-shaped (data-node-id, card-citation, escaped).
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (afterEach admin deletes
 * deadlock against the open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use App\Http\Controllers\HomePageServerController;
use App\Services\CanonicalVersions\AutoVersionResolver;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function hfeedDb()
{
    return DB::connection('pgsql_admin');
}

function hfeedCleanup(): void
{
    $db = hfeedDb();
    foreach (['hypercites', 'hyperlights', 'bibliography', 'library'] as $table) {
        $db->table($table)->where('book', 'LIKE', 'book_hfeed_%')->delete();
    }
    $db->table('nodes')->whereIn('book', ['most-recent', 'most-connected', 'most-lit'])
        ->where('node_id', 'LIKE', '%book_hfeed_%')->delete();
}

beforeEach(fn () => hfeedCleanup());
afterAll(fn () => hfeedCleanup());

/**
 * Seed LISTED public books (the population the homepage ranks).
 *
 * @param  array<string, array>  $books  label => extra library fields
 * @return array<string, string> label => book id
 */
function hfeedSeedBooks(array $books): array
{
    $db = hfeedDb();
    $ids = [];
    $i = 0;
    foreach ($books as $label => $fields) {
        $book = 'book_hfeed_' . Str::lower(Str::random(10));
        $ids[$label] = $book;
        $db->table('library')->insert(array_merge([
            'book'       => $book,
            'title'      => 'HFeed ' . $label,
            'visibility' => 'public',
            'listed'     => true,
            'has_nodes'  => true,
            'creator'    => AutoVersionResolver::CREATOR,
            'type'       => 'book',
            'raw_json'   => '[]',
            'timestamp'  => 0,
            'created_at' => now()->subMinutes(count($books) - $i),
        ], $fields));
        $i++;
    }

    return $ids;
}

function hfeedHypercite(string $cited, string $citing): void
{
    hfeedDb()->table('hypercites')->insert([
        'book'        => $cited,
        'hyperciteId' => 'hypercite_' . Str::lower(Str::random(8)),
        'citedIN'     => json_encode(['/' . $citing . '#anchor_' . Str::lower(Str::random(6))]),
        'raw_json'    => '{}',
        'charData'    => '{}',
        'created_at'  => now(),
    ]);
}

/** Rebuild the three feed books (forced, so no cache short-circuit). */
function hfeedRebuild(): void
{
    (new HomePageServerController())->updateHomePageBooks(new Request(), true);
}

/** The feed's seeded-book labels, in served order (other corpus books skipped). */
function hfeedOrder(string $feedBook): array
{
    return hfeedDb()->table('nodes')
        ->where('book', $feedBook)
        ->orderBy('startLine')
        ->pluck('plainText')
        ->map(fn ($t) => preg_match('/HFeed \w+/', $t, $m) ? $m[0] : null)
        ->filter()
        ->values()
        ->all();
}

test('most-connected serves the ConnectionCountQuery order: hypercited > referenced > quiet', function () {
    $ids = hfeedSeedBooks([
        'quiet'      => [],
        'refonly'    => [],
        'hypercited' => [],
        'outsider'   => [],
    ]);

    hfeedHypercite($ids['hypercited'], $ids['outsider']);
    hfeedDb()->table('bibliography')->insert([
        'book'              => $ids['refonly'],
        'referenceId'       => 'ref_' . Str::lower(Str::random(6)),
        'content'           => 'HFeed reference',
        'foundation_source' => $ids['outsider'],
        'created_at'        => now(),
    ]);

    hfeedRebuild();

    // hypercited (inbound hypercite, weight 2) > outsider (outbound hypercite +
    // inbound reference) > refonly (reference edge only) > quiet (nothing).
    expect(hfeedOrder('most-connected'))
        ->toBe(['HFeed hypercited', 'HFeed outsider', 'HFeed refonly', 'HFeed quiet']);
});

test('most-lit ranks on hyperlights + hypercites and ignores reference edges', function () {
    $ids = hfeedSeedBooks([
        'highlighted' => [],
        'referenced'  => [],
        'citer'       => [],
    ]);

    // `referenced` gains a reference edge (counts for Connected, not Lit);
    // `highlighted` gains hyperlights (counts for Lit only).
    hfeedDb()->table('bibliography')->insert([
        'book'              => $ids['citer'],
        'referenceId'       => 'ref_' . Str::lower(Str::random(6)),
        'content'           => 'HFeed reference',
        'foundation_source' => $ids['referenced'],
        'created_at'        => now(),
    ]);
    foreach (range(1, 4) as $n) {
        hfeedDb()->table('hyperlights')->insert([
            'book' => $ids['highlighted'], 'hyperlight_id' => 'hfeed_hl_' . $n,
            'raw_json' => '{}', 'created_at' => now(),
        ]);
    }

    hfeedRebuild();

    expect(hfeedOrder('most-lit')[0])->toBe('HFeed highlighted');
    expect(hfeedOrder('most-connected')[0])->toBe('HFeed referenced');
});

test('most-recent serves newest first', function () {
    hfeedSeedBooks(['oldest' => [], 'middle' => [], 'newest' => []]);

    hfeedRebuild();

    expect(hfeedOrder('most-recent'))->toBe(['HFeed newest', 'HFeed middle', 'HFeed oldest']);
});

test('homepage cards are generator-shaped: data-node-id + card-citation wrapper', function () {
    $ids = hfeedSeedBooks(['shape' => []]);

    hfeedRebuild();

    $node = hfeedDb()->table('nodes')
        ->where('book', 'most-recent')
        ->where('node_id', 'most-recent_' . $ids['shape'] . '_card')
        ->first();

    expect($node)->not->toBeNull();
    expect($node->content)->toContain('data-node-id="most-recent_' . $ids['shape'] . '_card"');
    expect($node->content)->toContain('<span class="card-citation">');
    expect($node->content)->toContain('class="book-actions" data-book="' . $ids['shape'] . '"');
});

test('hostile citation metadata is escaped in homepage cards', function () {
    $ids = hfeedSeedBooks([
        'hostile' => [
            'title'  => '<img src=x onerror=alert(1)>',
            'author' => '<script>alert(2)</script>',
        ],
    ]);

    hfeedRebuild();

    $content = hfeedDb()->table('nodes')
        ->where('book', 'most-recent')
        ->where('node_id', 'most-recent_' . $ids['hostile'] . '_card')
        ->value('content');

    expect($content)->not->toContain('<img src=x');
    expect($content)->not->toContain('<script>alert');
    expect($content)->toContain('&lt;img');
    expect($content)->toContain('&lt;script&gt;');
});
