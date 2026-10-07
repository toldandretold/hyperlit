<?php

/**
 * Deep-section pages: /{book}/text?page=N — the crawlable form of chunks 2..N.
 *
 * WHY: only the FIRST chunk of a book was ever server-rendered, and chunks 2..N
 * had no URL at all, so long-tail exact-phrase search over a book's body was
 * structurally unavailable (Capital Vol I exposed 622 chars of a ~2M-char
 * book). Each ?page=N (1-based manifest ordinal) serves the NORMAL reader view
 * with that chunk prerendered — a human landing from a search result gets the
 * actual reader at the passage; a crawler gets the same HTML plus hidden
 * prev/next <a> links to walk the book. An early inline replaceState tidies the
 * address bar to the canonical book path before any module JS reads
 * location.pathname, so the SPA/history machinery sees a plain book URL.
 *
 * Seeding mirrors ReaderPrerenderTest (admin inserts + BookCache::warm +
 * afterEach cleanup — RefreshDatabase cannot roll back admin commits).
 */

use App\Services\BookCache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    foreach ($this->btpBooks ?? [] as $book) {
        foreach (['nodes', 'library'] as $table) {
            try { $admin->table($table)->where('book', $book)->delete(); } catch (\Throwable $e) {}
        }
        app(BookCache::class)->invalidate($book);
    }
});

function seedTextPageBook(object $test, ?string $slug = null, array $attrs = []): string
{
    $book = 'apitest_' . Str::random(12);
    $test->btpBooks = array_merge($test->btpBooks ?? [], [$book]);

    $admin = DB::connection('pgsql_admin');
    $admin->table('library')->insert(array_merge([
        'book' => $book, 'title' => 'Text Pages Test', 'author' => 'TP Author',
        'slug' => $slug, 'visibility' => 'public',
        'creator' => null, 'creator_token' => null, 'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ], $attrs));
    foreach ([
        [0, 0, '<p>Alpha opening line</p>', 'Alpha opening line'],
        [1, 0, '<p>Beta second line</p>', 'Beta second line'],
        // A footnote marker in chunk 1 so the translate="no" decorator pass is
        // observable on the deep page (TranslateNoFurniture parity).
        [2, 1, '<p>Gamma in chunk one<sup fn-count-id="Fn1"><a href="#Fn1">1</a></sup></p>', 'Gamma in chunk one1'],
    ] as [$sl, $cid, $content, $plain]) {
        $admin->table('nodes')->insert([
            'book' => $book, 'startLine' => $sl, 'chunk_id' => $cid, 'node_id' => $book . '_n' . $sl,
            'content' => $content, 'plainText' => $plain, 'type' => 'p',
            'footnotes' => json_encode([]),
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    return $book;
}

/* ─── the pages themselves ─────────────────────────────────────────── */

test('page 1 serves the reader with chunk 1 prerendered, self-canonical at the bare /text', function () {
    $book = seedTextPageBook($this);
    app(BookCache::class)->warm($book);

    $html = $this->get("/{$book}/text")->assertStatus(200)->getContent();

    // The REAL adoptable chunk element, exactly like the book page's prerender.
    expect($html)->toContain('data-prerendered="true"');
    expect($html)->toContain('data-chunk-id="0"');
    expect($html)->toContain('<p>Alpha opening line</p>');
    expect($html)->not->toContain('Gamma in chunk one'); // page 2's content

    // Page 1 canonicalizes to the bare /text, never ?page=1.
    expect($html)->toContain('<link rel="canonical" href="' . url("/{$book}/text") . '">');
    expect($html)->toContain('— full text — Hyperlit</title>');

    // Crawl walk: next exists, prev does not (page 1).
    expect($html)->toContain('href="' . url("/{$book}/text?page=2") . '"');
    expect($html)->not->toContain('Previous page of');
});

test('page 2 serves ONLY its own chunk, canonical ?page=2, prev but no next (last page)', function () {
    $book = seedTextPageBook($this);
    app(BookCache::class)->warm($book);

    $html = $this->get("/{$book}/text?page=2")->assertStatus(200)->getContent();

    expect($html)->toContain('data-chunk-id="1"');
    expect($html)->toContain('Gamma in chunk one');
    expect($html)->not->toContain('<p>Alpha opening line</p>');

    expect($html)->toContain('<link rel="canonical" href="' . url("/{$book}/text?page=2") . '">');
    expect($html)->toContain(', page 2 — Hyperlit</title>');

    expect($html)->toContain('Previous page of');
    expect($html)->not->toContain('Next page of');
});

test('the replaceState tidy ships, carries the canonical book path, and precedes the module JS', function () {
    $book = seedTextPageBook($this);
    app(BookCache::class)->warm($book);

    $html = $this->get("/{$book}/text?page=2")->assertStatus(200)->getContent();

    // Page 2's tidy URL carries the chunk's first node id as a #hash — the
    // existing deep-link pathway (resolveBootstrapTarget priority 1) then does
    // the targeted initial fetch + seating. Fixture chunk 1's first startLine
    // is 2.
    expect($html)->toContain("history.replaceState(null, '', " . json_encode("/{$book}#2") . ')');

    // Page 1 is the book's own top: a bare book path, no hash.
    $p1 = $this->get("/{$book}/text")->assertStatus(200)->getContent();
    expect($p1)->toContain("history.replaceState(null, '', " . json_encode("/{$book}") . ')');
    // Parse-time inline script beats deferred modules regardless, but keep the
    // textual order pinned so a refactor can't push it below the entrypoint.
    expect(strpos($html, 'history.replaceState'))->toBeLessThan(strpos($html, 'readerEntry'));

    // And the plain book page must NOT carry the tidy.
    $bookHtml = $this->get("/{$book}")->assertStatus(200)->getContent();
    expect($bookHtml)->not->toContain('history.replaceState');
});

test('deep pages carry no Scholar citation_* meta and no JSON-LD — the book page owns those', function () {
    $book = seedTextPageBook($this);
    app(BookCache::class)->warm($book);

    $html = $this->get("/{$book}/text?page=2")->assertStatus(200)->getContent();

    expect($html)->not->toContain('citation_title');
    expect($html)->not->toContain('application/ld+json');
});

test('the decorator passes run on deep pages: a footnote marker is stamped translate="no"', function () {
    $book = seedTextPageBook($this);
    app(BookCache::class)->warm($book);

    $html = $this->get("/{$book}/text?page=2")->assertStatus(200)->getContent();

    expect($html)->toMatch('/<sup[^>]*translate="no"[^>]*fn-count-id="Fn1"|<sup[^>]*fn-count-id="Fn1"[^>]*translate="no"/');
});

/* ─── gates ────────────────────────────────────────────────────────── */

test('out-of-range and unknown 404; a junk page param falls back to page 1', function () {
    $book = seedTextPageBook($this);
    app(BookCache::class)->warm($book);

    $this->get("/{$book}/text?page=3")->assertStatus(404);
    $this->get('/zz-no-such-book/text')->assertStatus(404);
    $this->get("/{$book}/text?page=abc")->assertStatus(200); // (int)'abc' = 0 → page 1
});

test('a PRIVATE book 404s for everyone — anonymous and owner alike (shared-cacheable surface)', function () {
    $book = seedTextPageBook($this, null, ['visibility' => 'private', 'creator' => 'btp_owner']);
    app(BookCache::class)->warm($book);

    $this->get("/{$book}/text")->assertStatus(404);

    $owner = new \App\Models\User();
    $owner->name = 'btp_owner';
    $this->actingAs($owner)->get("/{$book}/text")->assertStatus(404);
});

test('an ENCRYPTED book 404s — its cached nodes are ciphertext', function () {
    $book = seedTextPageBook($this, null, ['encrypted' => true]);
    app(BookCache::class)->warm($book);

    $this->get("/{$book}/text")->assertStatus(404);
});

test('a user pseudo-book 404s — /{username}/text must not paginate a home feed', function () {
    $book = seedTextPageBook($this, null, ['raw_json' => json_encode(['type' => 'user_home'])]);
    app(BookCache::class)->warm($book);

    $this->get("/{$book}/text")->assertStatus(404);
});

/* ─── freshness ────────────────────────────────────────────────────── */

test('a COLD cache answers 503 + Retry-After and schedules the warm', function () {
    Queue::fake();
    $book = seedTextPageBook($this); // no warm()

    $res = $this->get("/{$book}/text");

    $res->assertStatus(503);
    expect($res->headers->get('Retry-After'))->toBe('300');
    Queue::assertPushed(\App\Jobs\WarmBookCacheJob::class, fn ($job) => $job->bookId === $book);
});

test('a STALE cache (library row newer than the warm) also 503s + warms', function () {
    Queue::fake();
    $book = seedTextPageBook($this);
    app(BookCache::class)->warm($book);
    DB::connection('pgsql_admin')->table('library')->where('book', $book)
        ->update(['timestamp' => (int) (microtime(true) * 1000)]);

    $this->get("/{$book}/text")->assertStatus(503);
    Queue::assertPushed(\App\Jobs\WarmBookCacheJob::class, fn ($job) => $job->bookId === $book);
});

test('a FRESH cache schedules nothing', function () {
    Queue::fake();
    $book = seedTextPageBook($this);
    app(BookCache::class)->warm($book);

    $this->get("/{$book}/text")->assertStatus(200);
    Queue::assertNotPushed(\App\Jobs\WarmBookCacheJob::class);
});

/* ─── slugs and discovery ──────────────────────────────────────────── */

test('the raw-id form 301s to /{slug}/text with the query preserved', function () {
    $slug = 'text-pages-' . strtolower(Str::random(6));
    $book = seedTextPageBook($this, $slug);
    app(BookCache::class)->warm($book);

    $this->get("/{$book}/text?page=2")
        ->assertStatus(301)
        ->assertRedirect("/{$slug}/text?page=2");
});

test('a public book page carries the hidden full-text crawl link; a private shell does not', function () {
    $book = seedTextPageBook($this);
    app(BookCache::class)->warm($book);

    $html = $this->get("/{$book}")->assertStatus(200)->getContent();
    expect($html)->toContain('href="/' . $book . '/text"');
    expect($html)->toContain('Full text of');

    $private = seedTextPageBook($this, null, ['visibility' => 'private']);
    $shell = $this->get("/{$private}")->assertStatus(200)->getContent();
    expect($shell)->not->toContain('/text"');
});

test('a slugged book\'s crawl link uses the slug path', function () {
    $slug = 'text-link-' . strtolower(Str::random(6));
    $book = seedTextPageBook($this, $slug);
    app(BookCache::class)->warm($book);

    $html = $this->followingRedirects()->get("/{$book}")->assertStatus(200)->getContent();
    expect($html)->toContain('href="/' . $slug . '/text"');
});
