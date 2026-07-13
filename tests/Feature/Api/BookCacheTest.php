<?php

/**
 * The backend file cache (App\Services\BookCache) sits transparently in front of the
 * DatabaseToIndexedDBController read path. These tests pin the load-bearing guarantees:
 *
 *   1. CONTRACT  — a cache HIT response is byte-identical to the live-path response
 *                  (modulo the volatile metadata.generated_at), so the client never
 *                  needs to know which served it.
 *   2. INVARIANT — cached chunk files hold NO per-requester annotation arrays, so
 *                  hyperlights/hypercites are necessarily merged live (gate/ownership
 *                  correctness can't regress through the cache).
 *   3. INDEX     — the deep-link index maps footnote / hypercite / hyperlight / startLine
 *                  targets to their chunk_id.
 *   4. STALENESS — a bump to library.timestamp makes the cache not-fresh (→ live + rewarm).
 */

use App\Services\BookCache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

uses(\Tests\Feature\Api\Support\InteractsWithApi::class);

afterEach(function () {
    // makeBook cleanup only removes library/users; remove the content we admin-seeded too,
    // and wipe the on-disk cache for every book this file touched.
    $admin = DB::connection('pgsql_admin');
    foreach ($this->bcBooks ?? [] as $book) {
        foreach (['nodes', 'footnotes', 'bibliography', 'hyperlights', 'hypercites'] as $table) {
            try {
                $admin->table($table)->where('book', $book)->delete();
            } catch (\Throwable $e) {
                // table absent in this schema state — ignore
            }
        }
        app(BookCache::class)->invalidate($book);
    }
    $this->cleanupApiFixtures();
});

/** Seed a public book + 2 chunks of nodes, a footnote, a hyperlight and a hypercite. */
function seedCachedBook(object $test): string
{
    $book = 'apitest_' . Str::random(12);
    $test->bcBooks = array_merge($test->bcBooks ?? [], [$book]);

    $admin = DB::connection('pgsql_admin');
    $admin->table('library')->insert([
        'book' => $book, 'title' => 'Cache Test Book', 'visibility' => 'public',
        'creator' => null, 'creator_token' => null, 'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ]);
    $node = function (float $startLine, float $chunkId, string $nodeId, string $content, array $footnotes = []) use ($admin, $book) {
        $admin->table('nodes')->insert([
            'book'      => $book,
            'startLine' => $startLine,
            'chunk_id'  => $chunkId,
            'node_id'   => $nodeId,
            'content'   => $content,
            'plainText' => strip_tags($content),
            'type'      => 'p',
            'footnotes' => json_encode($footnotes),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    };

    // Chunk 0: two nodes, the second carries a footnote ref. Chunk 1: one node.
    $node(0, 0, $book . '_n0', '<p>First node</p>');
    $node(1, 0, $book . '_n1', '<p>Second node</p>', ['Fn1']);
    $node(2, 1, $book . '_n2', '<p>Third node in chunk one</p>');

    $admin->table('footnotes')->insert([
        'book' => $book, 'footnoteId' => 'Fn1', 'content' => 'A footnote', 'created_at' => now(), 'updated_at' => now(),
    ]);

    // A hyperlight on node n1 (chunk 0) and a hypercite on node n2 (chunk 1).
    \App\Models\PgHyperlight::on('pgsql_admin')->create([
        'book' => $book, 'hyperlight_id' => 'HL_1', 'node_id' => [$book . '_n1'],
        'charData' => [$book . '_n1' => ['charStart' => 0, 'charEnd' => 4]],
        'annotation' => 'note', 'time_since' => 123, 'hidden' => false, 'raw_json' => json_encode(['x' => 1]),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    \App\Models\PgHypercite::on('pgsql_admin')->create([
        'book' => $book, 'hyperciteId' => 'hypercite_1', 'node_id' => [$book . '_n2'],
        'charData' => [$book . '_n2' => ['charStart' => 0, 'charEnd' => 5]],
        'citedIN' => [], 'relationshipStatus' => 'neutral', 'time_since' => 456,
        'raw_json' => ['x' => 1], 'created_at' => now(), 'updated_at' => now(),
    ]);

    return $book;
}

/** Strip the one volatile field so live and cache responses can be compared directly. */
function stripVolatile(array $json): array
{
    unset($json['metadata']['generated_at']);
    return $json;
}

test('initial-chunk: cache HIT response equals the live-path response', function () {
    $book = seedCachedBook($this);

    $live = stripVolatile($this->getJson("/api/database-to-indexeddb/books/{$book}/initial")->assertStatus(200)->json());

    app(BookCache::class)->warm($book);
    expect(app(BookCache::class)->isFresh($book, 1000))->toBeTrue();

    $cached = stripVolatile($this->getJson("/api/database-to-indexeddb/books/{$book}/initial")->assertStatus(200)->json());

    expect($cached)->toEqual($live);
    // And the merged node still carries its live annotation array.
    $n1 = collect($cached['initial_chunk'])->firstWhere('node_id', $book . '_n1');
    expect($n1['hyperlights'])->toHaveCount(1);
});

test('single-chunk and full-data: cache HIT equals live for every read variant', function () {
    $book = seedCachedBook($this);

    $liveChunk = $this->getJson("/api/database-to-indexeddb/books/{$book}/chunk/0")->assertStatus(200)->json();
    $liveData  = stripVolatile($this->getJson("/api/database-to-indexeddb/books/{$book}/data")->assertStatus(200)->json());
    $liveBatch = $this->getJson("/api/database-to-indexeddb/books/{$book}/data/batch?from=0&to=1")->assertStatus(200)->json();

    app(BookCache::class)->warm($book);

    $cachedChunk = $this->getJson("/api/database-to-indexeddb/books/{$book}/chunk/0")->assertStatus(200)->json();
    $cachedData  = stripVolatile($this->getJson("/api/database-to-indexeddb/books/{$book}/data")->assertStatus(200)->json());
    $cachedBatch = $this->getJson("/api/database-to-indexeddb/books/{$book}/data/batch?from=0&to=1")->assertStatus(200)->json();

    expect($cachedChunk)->toEqual($liveChunk);
    expect($cachedData)->toEqual($liveData);
    expect($cachedBatch)->toEqual($liveBatch);
});

test('cached chunk files hold base nodes only — no annotation arrays', function () {
    $book = seedCachedBook($this);
    app(BookCache::class)->warm($book);

    $base = app(BookCache::class)->getChunk($book, 0);
    expect($base)->not->toBeNull();
    foreach ($base as $node) {
        expect($node)->not->toHaveKey('hyperlights');
        expect($node)->not->toHaveKey('hypercites');
        expect($node)->toHaveKeys(['node_id', 'content', 'chunk_id', 'startLine']);
    }
});

test('deep-link index maps footnote / hypercite / hyperlight / startLine to chunk_id', function () {
    $book = seedCachedBook($this);
    app(BookCache::class)->warm($book);

    // chunk_id values round-trip through JSON as ints when whole (0.0→0); the controller
    // casts with (float) at use, so compare as float.
    $index = app(BookCache::class)->getIndex($book);
    expect((float) $index['Fn1'])->toBe(0.0);            // footnote lives in chunk 0
    expect((float) $index['HL_1'])->toBe(0.0);           // hyperlight's node is in chunk 0
    expect((float) $index['hypercite_1'])->toBe(1.0);    // hypercite's node is in chunk 1
    expect((float) $index['2'])->toBe(1.0);              // startLine 2 → chunk 1
});

test('DEEP-LINK: ?target=hypercite_ resolves to its chunk via the cached index (no PG chain)', function () {
    // This is the url.com/book#hyperciteID path: the client turns the hash into ?target=,
    // and getInitialChunk resolves it. On a fresh cache it must come from index.json — proven
    // here by target_reason='index' and the correct chunk (the hypercite's node is in chunk 1).
    $book = seedCachedBook($this);
    app(BookCache::class)->warm($book);

    $resp = $this->getJson("/api/database-to-indexeddb/books/{$book}/initial?target=hypercite_1")
        ->assertStatus(200)
        ->json();

    expect((float) $resp['target_chunk_id'])->toBe(1.0);
    expect($resp['target_reason'])->toBe('index');

    // A footnote target resolves the same way (Fn1 lives in chunk 0).
    $resp2 = $this->getJson("/api/database-to-indexeddb/books/{$book}/initial?target=Fn1")
        ->assertStatus(200)
        ->json();
    expect((float) $resp2['target_chunk_id'])->toBe(0.0);
    expect($resp2['target_reason'])->toBe('index');
});

test('DEEP-LINK fallback: a stale index is NOT used — resolution falls back to the PG tables', function () {
    // Warm the index, then make the cache stale (bump library.timestamp). The same
    // ?target=hypercite_1 must still resolve to the right chunk, but via the original
    // database-table path (reason='hypercite'), NOT the index (reason would be 'index').
    $book = seedCachedBook($this);
    app(BookCache::class)->warm($book);

    DB::connection('pgsql_admin')->table('library')->where('book', $book)->update(['timestamp' => 9999]);

    $resp = $this->getJson("/api/database-to-indexeddb/books/{$book}/initial?target=hypercite_1")
        ->assertStatus(200)
        ->json();

    expect((float) $resp['target_chunk_id'])->toBe(1.0);   // still correct…
    expect($resp['target_reason'])->toBe('hypercite');     // …but via PG, not the stale index
});

test('a bump to library.timestamp makes the cache not-fresh', function () {
    $book = seedCachedBook($this);
    $cache = app(BookCache::class);

    $cache->warm($book);
    expect($cache->isFresh($book, $cache->freshTimestamp($book)))->toBeTrue();

    DB::connection('pgsql_admin')->table('library')->where('book', $book)->update(['timestamp' => 2000]);
    expect($cache->isFresh($book, $cache->freshTimestamp($book)))->toBeFalse();
});

test('TIMESTAMP MATCH → the cache is genuinely served (not a silent live read)', function () {
    // Warm the cache, then DELETE the underlying Postgres nodes WITHOUT touching the
    // library timestamp. The cache is still "fresh" (meta == library.timestamp), so the
    // endpoint must serve the cached nodes from disk even though the nodes table is empty —
    // a decisive proof that the HIT path reads files, not Postgres.
    $book = seedCachedBook($this);
    app(BookCache::class)->warm($book);

    DB::connection('pgsql_admin')->table('nodes')->where('book', $book)->delete();

    $resp = $this->getJson("/api/database-to-indexeddb/books/{$book}/chunk/0")->assertStatus(200)->json();
    expect($resp['nodes'])->toHaveCount(2);                       // came from disk
    expect($resp['nodes'][0]['content'])->toContain('First node');
});

test('TIMESTAMP MISMATCH → the stale cache is bypassed and fresh content is served', function () {
    // Real-world edit: warm the cache, then change a node's content AND bump the content
    // timestamp (exactly what updateBookTimestamp/unified-sync do on an edit). The next read
    // must return the EDITED content, proving the stale cache was bypassed for the live path.
    $book = seedCachedBook($this);
    $cache = app(BookCache::class);
    $cache->warm($book);

    $admin = DB::connection('pgsql_admin');
    $admin->table('nodes')->where('book', $book)->where('node_id', $book . '_n0')
        ->update(['content' => '<p>EDITED node</p>']);
    $admin->table('library')->where('book', $book)->update(['timestamp' => 2000]);

    $resp = $this->getJson("/api/database-to-indexeddb/books/{$book}/initial")->assertStatus(200)->json();
    $n0 = collect($resp['initial_chunk'])->firstWhere('node_id', $book . '_n0');
    expect($n0['content'])->toBe('<p>EDITED node</p>');          // fresh, not the cached 'First node'

    // …and the read re-warmed the cache to the new timestamp (warmAsync ran after response).
    expect($cache->isFresh($book, 2000))->toBeTrue();
});

test('MISMATCH then empty PG → stale cache bypassed, live path returns the real (404) state', function () {
    // Complements the match test: once the cache is stale, the endpoint must NOT fall back to
    // serving stale cached nodes. Empty the nodes table AND bump the timestamp → the read goes
    // live, finds nothing, and 404s (rather than serving the old cached chunk).
    $book = seedCachedBook($this);
    app(BookCache::class)->warm($book);

    $admin = DB::connection('pgsql_admin');
    $admin->table('nodes')->where('book', $book)->delete();
    $admin->table('library')->where('book', $book)->update(['timestamp' => 2000]);

    $this->getJson("/api/database-to-indexeddb/books/{$book}/chunk/0")->assertStatus(404);
});

test('warm INDEXES heading anchor ids (kills the content-scan), but NOT inline ids', function () {
    // Heading anchors (#chapter-3 TOC targets) are the real content-scan targets; index them. Inline
    // ids in non-heading content are deliberately NOT indexed (selectivity — they bloat the map).
    $book = 'apitest_' . Str::random(12);
    $this->bcBooks = array_merge($this->bcBooks ?? [], [$book]);
    $admin = DB::connection('pgsql_admin');
    $admin->table('library')->insert([
        'book' => $book, 'title' => 'Headings', 'visibility' => 'public', 'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ]);
    $admin->table('nodes')->insert([
        'book' => $book, 'startLine' => 0, 'chunk_id' => 0, 'node_id' => $book . '_h',
        'content' => '<h2 id="sec-3" data-node-id="' . $book . '_h">Section 3</h2>',
        'plainText' => 'Section 3', 'type' => 'h2', 'footnotes' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $admin->table('nodes')->insert([
        'book' => $book, 'startLine' => 1, 'chunk_id' => 0, 'node_id' => $book . '_p',
        'content' => '<p id="inline-thing">body <span id="x9">w</span></p>',
        'plainText' => 'body w', 'type' => 'p', 'footnotes' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    app(BookCache::class)->warm($book);
    $index = app(BookCache::class)->getIndex($book);

    expect((float) $index['sec-3'])->toBe(0.0);        // heading anchor → its chunk (no content-scan)
    expect($index)->not->toHaveKey('inline-thing');    // <p> inline id NOT indexed
    expect($index)->not->toHaveKey('x9');              // <span> id NOT indexed
});

test('addToIndex incrementally adds a post-warm annotation; cold cache → no-op', function () {
    $cache = app(BookCache::class);

    // Cold (un-warmed) book: addToIndex must be a no-op (no index file to update).
    $cold = seedCachedBook($this);
    $cache->addToIndex($cold, ['hypercite_x' => 1.0]);
    expect($cache->getIndex($cold))->toBeNull();

    // Warm book: a cite created AFTER warm isn't in the index → addToIndex puts it there.
    $book = seedCachedBook($this);          // node $book_n2 lives in chunk 1
    $cache->warm($book);
    expect($cache->getIndex($book))->not->toHaveKey('hypercite_new');

    $chunks = $cache->chunkIdsForNodes($book, ['hypercite_new' => $book . '_n2']);
    expect($chunks)->toEqual(['hypercite_new' => 1.0]); // resolved its first node's chunk
    $cache->addToIndex($book, $chunks);

    expect((float) $cache->getIndex($book)['hypercite_new'])->toBe(1.0);
});
