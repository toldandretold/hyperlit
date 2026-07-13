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
        foreach (['nodes', 'footnotes', 'hyperlights', 'library', 'user_reading_positions'] as $table) {
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
            'footnotes' => json_encode([]),
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

    // NB: assert on the element attribute (data-prerendered="true"), not the bare string — the
    // blade's flash-guard CSS rule (.chunk[data-prerendered]) legitimately contains "data-prerendered".
    expect($html)->not->toContain('data-prerendered="true"');
    expect($html)->not->toContain('<p>Alpha opening line</p>');
});

test('STALE cache → no prerender (content changed, cache not rebuilt yet)', function () {
    $book = seedPrerenderBook($this);
    app(BookCache::class)->warm($book);
    DB::connection('pgsql_admin')->table('library')->where('book', $book)->update(['timestamp' => 5000]);

    $html = $this->get("/{$book}")->assertStatus(200)->getContent();

    expect($html)->not->toContain('data-prerendered="true"');
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

test('QUERY target (?target=) → SPA fetch path prerenders THAT chunk (flash fix)', function () {
    // The SPA reader-HTML fetch forwards the deep-link as ?target= (the browser strips a URL #hash,
    // but the JS-built fetch can carry it). show() must prerender the TARGET chunk so the client
    // adopts it and the deep-link nav scrolls straight to it — no flash of the lowest chunk.
    $book = seedPrerenderBook($this);
    app(BookCache::class)->warm($book);

    $html = $this->get("/{$book}?target=HL_1")->assertStatus(200)->getContent();

    expect($html)->toContain('data-prerendered="true"');
    expect($html)->toContain('data-chunk-id="1"');               // the hyperlight's chunk
    expect($html)->not->toContain('<p>Alpha opening line</p>');  // NOT the lowest chunk
});

test('RESUME: a logged-in user with a saved position prerenders THAT chunk (not the lowest) + Cache-Control private', function () {
    // No deep-link (bare /{book}) for a known user → prerender the chunk the user last read,
    // resolved from user_reading_positions exactly like the client resume=true fetch.
    $book = seedPrerenderBook($this);
    app(BookCache::class)->warm($book);

    DB::connection('pgsql_admin')->table('user_reading_positions')->insert([
        'book' => $book, 'user_name' => 'reader1', 'anon_token' => null,
        'chunk_id' => 1, 'element_id' => '2', 'updated_at' => now(),
    ]);

    $user = new \App\Models\User();
    $user->name = 'reader1';

    $res = $this->actingAs($user)->get("/{$book}");
    $html = $res->assertStatus(200)->getContent();

    expect($html)->toContain('data-chunk-id="1"');                 // the saved chunk, not the lowest
    expect($html)->toContain('Gamma in chunk one');                // chunk 1's node
    expect($html)->not->toContain('<p>Alpha opening line</p>');    // NOT chunk 0
    // Per-user prerender must not be shared-cacheable (Cloudflare etc.). `no-store` is OUR marker
    // (the framework already adds `no-cache, private` to session responses; no-store is distinctive).
    expect($res->headers->get('Cache-Control'))->toContain('no-store');
});

test('RESUME: a saved position whose chunk no longer exists falls back to the lowest chunk (no orphan, not private)', function () {
    // Content edits can shift chunk ids; a stale bookmark chunk must NOT be prerendered (it would
    // orphan in the DOM). Fall back to the public lowest chunk — and that fallback is shared-cacheable.
    $book = seedPrerenderBook($this);
    app(BookCache::class)->warm($book);

    DB::connection('pgsql_admin')->table('user_reading_positions')->insert([
        'book' => $book, 'user_name' => 'reader1', 'anon_token' => null,
        'chunk_id' => 99, 'element_id' => null, 'updated_at' => now(),  // 99 is not in the manifest
    ]);

    $user = new \App\Models\User();
    $user->name = 'reader1';

    $res = $this->actingAs($user)->get("/{$book}");
    $html = $res->assertStatus(200)->getContent();

    expect($html)->toContain('data-chunk-id="0"');             // lowest chunk
    expect($html)->toContain('<p>Alpha opening line</p>');
    expect($html)->not->toContain('Gamma in chunk one');
    // The public lowest-chunk fallback is NOT marked no-store (only bookmark-derived prerenders are).
    expect($res->headers->get('Cache-Control') ?? '')->not->toContain('no-store');
});

test('target NOT in the index (created after warm) still prerenders its chunk via LIVE fallback', function () {
    // The index only rebuilds on a content re-warm, so a hypercite/hyperlight created afterwards is
    // absent from index.json. The prerender must fall back to a live table lookup (like the API does)
    // — otherwise it prerenders the lowest chunk and the deep-link flashes. Here HL_2 is added AFTER warm.
    $book = seedPrerenderBook($this);
    app(BookCache::class)->warm($book);                       // index built WITHOUT HL_2

    \App\Models\PgHyperlight::on('pgsql_admin')->create([
        'book' => $book, 'hyperlight_id' => 'HL_2', 'node_id' => [$book . '_n2'], // node in chunk 1
        'charData' => [$book . '_n2' => ['charStart' => 0, 'charEnd' => 5]],
        'time_since' => 1, 'hidden' => false, 'raw_json' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $html = $this->get("/{$book}?target=HL_2")->assertStatus(200)->getContent();

    expect($html)->toContain('data-chunk-id="1"');               // resolved via live lookup → chunk 1
    expect($html)->not->toContain('<p>Alpha opening line</p>');  // NOT the lowest chunk
});
