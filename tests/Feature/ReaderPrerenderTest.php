<?php

/**
 * Phase 2 — first-chunk injection for adoption. TextController::show injects the first chunk
 * (from the file cache, when fresh) into the reader's <main> as the REAL chunk element
 * (`<div class="chunk" data-chunk-id data-prerendered>`) so crawlers index the article body,
 * users get an instant paint, AND the client adopts it without re-rendering. These tests pin:
 *   - a FRESH cache → <main> contains the .chunk[data-prerendered] with node HTML + JSON-LD articleBody;
 *   - a COLD/STALE cache → no prerender (empty <main>, today's behaviour) — graceful fallback.
 */

use App\Services\BookCache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    foreach ($this->prBooks ?? [] as $book) {
        foreach (['nodes', 'footnotes', 'hyperlights', 'library'] as $table) {
            try { $admin->table($table)->where('book', $book)->delete(); } catch (\Throwable $e) {}
        }
        app(BookCache::class)->invalidate($book);
    }
});

function seedPrerenderBook(object $test): string
{
    $book = 'apitest_' . Str::random(12);
    $test->prBooks = array_merge($test->prBooks ?? [], [$book]);

    $admin = DB::connection('pgsql_admin');
    $admin->table('library')->insert([
        'book' => $book, 'title' => 'Prerender Test', 'visibility' => 'public',
        'creator' => null, 'creator_token' => null, 'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ]);
    foreach ([[0, 0, 'Alpha opening line'], [1, 0, 'Beta second line'], [2, 1, 'Gamma in chunk one']] as [$sl, $cid, $txt]) {
        $admin->table('nodes')->insert([
            'book' => $book, 'startLine' => $sl, 'chunk_id' => $cid, 'node_id' => $book . '_n' . $sl,
            'content' => "<p>{$txt}</p>", 'plainText' => $txt, 'type' => 'p',
            'footnotes' => json_encode([]), 'raw_json' => json_encode([]),
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
    // A hyperlight on node n2 (chunk 1) so a /book/HL_1 path deep-link resolves to chunk 1 via the index.
    \App\Models\PgHyperlight::on('pgsql_admin')->create([
        'book' => $book, 'hyperlight_id' => 'HL_1', 'node_id' => [$book . '_n2'],
        'charData' => [$book . '_n2' => ['charStart' => 0, 'charEnd' => 5]],
        'time_since' => 1, 'hidden' => false, 'raw_json' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    return $book;
}

test('FRESH cache → reader <main> server-renders the first chunk as an adoptable .chunk', function () {
    $book = seedPrerenderBook($this);
    app(BookCache::class)->warm($book);

    $html = $this->get("/{$book}")->assertStatus(200)->getContent();

    // The injected element is the REAL chunk wrapper (data-chunk-id + data-prerendered) the
    // client adopts — chunk 0 (startLine 0 + 1); the second chunk's node is NOT present (lazy).
    expect($html)->toContain('data-prerendered="true"');
    expect($html)->toContain('data-chunk-id="0"');
    expect($html)->toContain('<p>Alpha opening line</p>');
    expect($html)->toContain('<p>Beta second line</p>');
    expect($html)->not->toContain('Gamma in chunk one');
    // article body lands in the JSON-LD for crawlers
    expect($html)->toContain('articleBody');
    expect($html)->toContain('Alpha opening line Beta second line');
});

test('COLD cache → reader <main> stays empty (graceful fallback, no prerender)', function () {
    $book = seedPrerenderBook($this);
    // No warm() → cache cold.

    $html = $this->get("/{$book}")->assertStatus(200)->getContent();

    expect($html)->not->toContain('data-prerendered');
    expect($html)->not->toContain('<p>Alpha opening line</p>');
});

test('STALE cache → no prerender (content changed, cache not rebuilt yet)', function () {
    $book = seedPrerenderBook($this);
    app(BookCache::class)->warm($book);
    DB::connection('pgsql_admin')->table('library')->where('book', $book)->update(['timestamp' => 5000]);

    $html = $this->get("/{$book}")->assertStatus(200)->getContent();

    expect($html)->not->toContain('data-prerendered');
});

test('PATH target → server injects THAT chunk (resolved via the index), not the lowest', function () {
    // A path deep-link /book/HL_1 (hyperlight on a node in chunk 1) should inject chunk 1, not
    // chunk 0, so the client adopts exactly the chunk it will land on.
    $book = seedPrerenderBook($this);
    app(BookCache::class)->warm($book);

    $html = $this->get("/{$book}/HL_1")->assertStatus(200)->getContent();

    expect($html)->toContain('data-prerendered="true"');
    expect($html)->toContain('data-chunk-id="1"');
    expect($html)->toContain('Gamma in chunk one');     // chunk 1's node
    expect($html)->not->toContain('<p>Alpha opening line</p>'); // chunk 0 not injected
});
