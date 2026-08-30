<?php

/**
 * The "Most Connected" / "Most Lit" feeds end to end — what a journal page
 * (/j/{slug}) actually serves when those buttons are pressed.
 *
 * Before this, both feeds sorted `library.total_citations`, which was NULL for
 * every harvested journal article (the recompute filtered `listed = true`;
 * harvest mints `listed = false`), so the order was whatever arbitrary order the
 * shelf_items ⋈ library join produced — and it was then FROZEN in `nodes` as
 * `shelf_{id}_{sort}_pub` because nothing ever invalidated a shelf render when a
 * count changed. Both halves of that are locked here.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (afterEach admin deletes
 * deadlock against the open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Connections\ConnectionCountQuery;
use App\Services\Connections\ConnectionRefresher;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function cfeedDb()
{
    return DB::connection('pgsql_admin');
}

function cfeedCleanup(): void
{
    $db = cfeedDb();
    $shelfIds = $db->table('shelves')->where('name', 'LIKE', 'CFeed %')->pluck('id');
    foreach ($shelfIds as $shelfId) {
        $db->table('nodes')->where('book', 'LIKE', 'shelf_' . $shelfId . '_%')->delete();
        $db->table('library')->where('book', 'LIKE', 'shelf_' . $shelfId . '_%')->delete();
        $db->table('shelf_items')->where('shelf_id', $shelfId)->delete();
    }
    $db->table('shelves')->whereIn('id', $shelfIds)->delete();
    foreach (['hypercites', 'hyperlights', 'bibliography', 'library'] as $table) {
        $db->table($table)->where('book', 'LIKE', 'book_cfeed_%')->delete();
    }
}

beforeEach(fn () => cfeedCleanup());

// Hypercite edges are global state — the docuverse endpoint counts every edge
// in the table, so rows left behind by this file break unrelated suites.
// afterAll runs after the last RefreshDatabase transaction closes, so the admin
// deletes cannot deadlock against it.
afterAll(fn () => cfeedCleanup());

/**
 * A public shelf of harvested-shaped articles: `visibility = public,
 * listed = false, creator = canonicalizer_v1` — exactly what
 * SystemVersionMinter produces, i.e. the corpus the old recompute skipped.
 *
 * @param  array<string, array>  $books  label => extra library fields
 * @return array{0:string, 1:array<string,string>} shelf id, label => book id
 */
function cfeedSeedShelf(array $books): array
{
    $db = cfeedDb();
    $shelfId = (string) Str::uuid();
    $db->table('shelves')->insert([
        'id'           => $shelfId,
        'creator'      => AutoVersionResolver::CREATOR,
        'name'         => 'CFeed ' . Str::random(6),
        'slug'         => 'cfeed-' . Str::lower(Str::random(8)),
        'visibility'   => 'public',
        'default_sort' => 'recent',
        'created_at'   => now(),
        'updated_at'   => now(),
    ]);

    $ids = [];
    $i = 0;
    foreach ($books as $label => $fields) {
        $book = 'book_cfeed_' . Str::lower(Str::random(10));
        $ids[$label] = $book;
        $db->table('library')->insert(array_merge([
            'book'       => $book,
            'title'      => 'CFeed ' . $label,
            'visibility' => 'public',
            'listed'     => false,
            'has_nodes'  => true,
            'creator'    => AutoVersionResolver::CREATOR,
            'type'       => 'book',
            'raw_json'   => '[]',
            'timestamp'  => 0,
            'created_at' => now()->subMinutes(count($books) - $i),
        ], $fields));
        $db->table('shelf_items')->insert([
            'shelf_id' => $shelfId,
            'book'     => $book,
            'added_at' => now(),
        ]);
        $i++;
    }

    return [$shelfId, $ids];
}

function cfeedHypercite(string $cited, string $citing): void
{
    cfeedDb()->table('hypercites')->insert([
        'book'        => $cited,
        'hyperciteId' => 'hypercite_' . Str::lower(Str::random(8)),
        'citedIN'     => json_encode(['/' . $citing . '#anchor_' . Str::lower(Str::random(6))]),
        'raw_json'    => '{}',
        'charData'    => '{}',
        'created_at'  => now(),
    ]);
}

/** Render the public shelf feed and return card labels in order. */
function cfeedOrder(string $shelfId, string $sort): array
{
    $response = test()->getJson("/api/public/shelves/{$shelfId}/render?sort={$sort}");
    $response->assertOk();

    return cfeedDb()->table('nodes')
        ->where('book', $response->json('bookId'))
        ->orderBy('startLine')
        ->pluck('plainText')
        ->map(fn ($t) => preg_match('/CFeed \w+/', $t, $m) ? $m[0] : $t)
        ->all();
}

test('most connected: hypercited texts first, then reference-linked, then the rest', function () {
    [$shelfId, $ids] = cfeedSeedShelf([
        'quiet'     => [],
        'refonly'   => [],
        'hypercited' => [],
        'outsider'  => [],  // provides the edges, so it scores too
    ]);

    // hypercited is quoted by outsider; refonly's bibliography resolves to outsider.
    cfeedHypercite($ids['hypercited'], $ids['outsider']);
    cfeedDb()->table('bibliography')->insert([
        'book'              => $ids['refonly'],
        'referenceId'       => 'ref_' . Str::lower(Str::random(6)),
        'content'           => 'CFeed reference',
        'foundation_source' => $ids['outsider'],
        'created_at'        => now(),
    ]);

    (new ConnectionCountQuery())->recompute(array_values($ids));

    $order = cfeedOrder($shelfId, 'connected');

    // hypercited (inbound hypercite, weight 2) > outsider (1 outbound hypercite
    // + 1 inbound reference) on the hypercite key alone; refonly has only a
    // reference edge, so it sits below both; quiet has nothing.
    expect($order[0])->toBe('CFeed hypercited');
    expect($order[1])->toBe('CFeed outsider');
    expect($order[2])->toBe('CFeed refonly');
    expect($order[3])->toBe('CFeed quiet');
});

test('most connected gives an unlisted journal article a real score — the old recompute never touched it', function () {
    [, $ids] = cfeedSeedShelf(['a' => [], 'b' => []]);
    cfeedHypercite($ids['a'], $ids['b']);

    expect(cfeedDb()->table('library')->where('book', $ids['a'])->value('listed'))->toBeFalse();

    (new ConnectionCountQuery())->recompute();

    expect(cfeedDb()->table('library')->where('book', $ids['a'])->value('hypercite_connections'))
        ->toBe(ConnectionCountQuery::INBOUND_WEIGHT);
});

test('most lit counts hyperlights and ignores reference edges, so it differs from most connected', function () {
    [$shelfId, $ids] = cfeedSeedShelf([
        'highlighted' => [],
        'referenced'  => [],
        'citer'       => [],
    ]);

    // `referenced` wins on Connected (a reference edge); `highlighted` wins on
    // Lit (hyperlights, which Connected ignores).
    cfeedDb()->table('bibliography')->insert([
        'book'              => $ids['citer'],
        'referenceId'       => 'ref_' . Str::lower(Str::random(6)),
        'content'           => 'CFeed reference',
        'foundation_source' => $ids['referenced'],
        'created_at'        => now(),
    ]);
    foreach (range(1, 4) as $n) {
        cfeedDb()->table('hyperlights')->insert([
            'book' => $ids['highlighted'], 'hyperlight_id' => 'hl_' . $n,
            'raw_json' => '{}', 'created_at' => now(),
        ]);
    }

    (new ConnectionCountQuery())->recompute(array_values($ids));

    expect(cfeedOrder($shelfId, 'connected')[0])->toBe('CFeed referenced');
    expect(cfeedOrder($shelfId, 'lit')[0])->toBe('CFeed highlighted');
});

test('ties fall back to publication date instead of arbitrary join order', function () {
    [$shelfId] = cfeedSeedShelf(['oldest' => [], 'middle' => [], 'newest' => []]);

    // Nothing is connected: every score is 0, which is the normal state of a
    // freshly harvested journal. The feed must still be deterministic.
    expect(cfeedOrder($shelfId, 'connected'))->toBe(['CFeed newest', 'CFeed middle', 'CFeed oldest']);
});

// ── the render cache ─────────────────────────────────────────────────────────

test('a new hypercite invalidates the rendered feed, so the new order is served', function () {
    [$shelfId, $ids] = cfeedSeedShelf(['underdog' => [], 'favourite' => [], 'quoter' => []]);
    (new ConnectionCountQuery())->recompute(array_values($ids));

    // First render caches the unconnected order (newest first).
    expect(cfeedOrder($shelfId, 'connected')[0])->toBe('CFeed quoter');
    expect(cfeedDb()->table('nodes')->where('book', "shelf_{$shelfId}_connected_pub")->exists())->toBeTrue();

    // Someone hypercites the underdog.
    cfeedHypercite($ids['underdog'], $ids['quoter']);
    app(ConnectionRefresher::class)->refresh([$ids['underdog'], $ids['quoter']]);

    // The cached render is gone and the rebuilt feed leads with the underdog.
    expect(cfeedDb()->table('nodes')->where('book', "shelf_{$shelfId}_connected_pub")->exists())->toBeFalse();
    expect(cfeedOrder($shelfId, 'connected')[0])->toBe('CFeed underdog');
});

test('a ranking render expires on its own; a stable sort keeps its cache', function () {
    [$shelfId] = cfeedSeedShelf(['a' => [], 'b' => []]);

    cfeedOrder($shelfId, 'connected');
    cfeedOrder($shelfId, 'title');

    $connectedId = "shelf_{$shelfId}_connected_pub";
    $titleId = "shelf_{$shelfId}_title_pub";

    expect(ConnectionRefresher::cachedRenderIsStale($connectedId, 'connected'))->toBeFalse();
    expect(ConnectionRefresher::cachedRenderIsStale($titleId, 'title'))->toBeFalse();

    // Age both synthetic rows past the TTL.
    cfeedDb()->table('library')->whereIn('book', [$connectedId, $titleId])
        ->update(['updated_at' => now()->subSeconds(ConnectionRefresher::RENDER_TTL_SECONDS + 60)]);

    // Only the ranking sort expires — a title order cannot go stale behind you.
    expect(ConnectionRefresher::cachedRenderIsStale($connectedId, 'connected'))->toBeTrue();
    expect(ConnectionRefresher::cachedRenderIsStale($titleId, 'title'))->toBeFalse();
});
