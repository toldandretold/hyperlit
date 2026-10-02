<?php

/**
 * App furniture is marked `translate="no"`; the BOOK is not.
 *
 * Browser translation is for the text a reader came to read. Translating the app
 * around it is at best useless and at worst actively broken: the nav labels sit
 * in a fixed-position icon cluster that reflows when the strings change length,
 * and the loading chrome's text is rewritten from JS as the load progresses, so
 * a translator racing those writes is churn for nothing.
 *
 * The marking is ADDITIVE on purpose. The tidier-looking inversion
 * (`<body translate="no">` + `<main translate="yes">`) depends on re-enabling
 * under a `no` ancestor, which could not be verified for Chrome's built-in
 * translator — and if it is not honoured, the whole page silently becomes
 * untranslatable AND the language detection that decides whether a translation
 * is even offered may be suppressed. So `<main>` is simply never marked.
 *
 * Also pinned: a footnote MARKER is never translated. It is a number, and
 * translating it breaks the link to its definition — in a target language with
 * its own numerals it stops matching anything at all. The client does the same
 * marking in `lazyLoader/chunkRender.ts`; this covers the server-prerendered
 * chunk, which paints BEFORE any JS runs and is therefore what a translator
 * acting on first paint actually sees.
 */

use App\Services\BookCache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** Fixed-position / JS-driven chrome that must not be translated. */
const FURNITURE_IDS = [
    'logoNavWrapper',          // "Account" / "Home" / "Open" / "New"
    'topRightContainer',       // sync status + cloudRef
    'hyperlight-buttons',      // selection popup
    'bottom-left-buttons',
    'bottom-right-buttons',
    'initial-navigation-overlay', // "Loading..." / "Initializing...", rewritten from JS
];

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    foreach ($this->tnBooks ?? [] as $book) {
        foreach (['nodes', 'library'] as $table) {
            try { $admin->table($table)->where('book', $book)->delete(); } catch (\Throwable $e) {}
        }
        app(BookCache::class)->invalidate($book);
    }
});

function seedTranslateNoBook(object $test): string
{
    $book = 'tntest_' . Str::random(12);
    $test->tnBooks = array_merge($test->tnBooks ?? [], [$book]);

    $admin = DB::connection('pgsql_admin');
    $admin->table('library')->insert([
        'book' => $book, 'title' => 'Translate Furniture', 'visibility' => 'public',
        'creator' => null, 'creator_token' => null, 'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ]);
    $admin->table('nodes')->insert([
        'book' => $book, 'startLine' => 0, 'chunk_id' => 0, 'node_id' => $book . '_n0',
        'content' => '<p>Real prose a reader wants translated'
            . '<sup fn-count-id="1" id="Fn1" class="footnote-ref">1</sup></p>',
        'plainText' => 'Real prose a reader wants translated1', 'type' => 'p',
        'footnotes' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    return $book;
}

test('reader furniture declares translate="no"', function () {
    $book = seedTranslateNoBook($this);
    $html = $this->get("/{$book}")->assertStatus(200)->getContent();

    foreach (FURNITURE_IDS as $id) {
        // Match the opening tag for that id and assert the attribute is on it,
        // rather than just "the attribute appears somewhere in the document".
        expect($html)->toMatch('/<[a-z]+[^>]*\bid="' . preg_quote($id, '/') . '"[^>]*>/i');
        preg_match('/<[a-z]+[^>]*\bid="' . preg_quote($id, '/') . '"[^>]*>/i', $html, $m);
        expect($m[0] ?? '')->toContain('translate="no"');
    }
});

test('the BOOK itself is never marked untranslatable', function () {
    $book = seedTranslateNoBook($this);
    $html = $this->get("/{$book}")->assertStatus(200)->getContent();

    preg_match('/<main[^>]*class="main-content"[^>]*>/i', $html, $m);
    expect($m[0] ?? '')->not->toContain('translate');
});

test('a prerendered footnote MARKER is marked untranslatable', function () {
    // Needs a warm cache, since that is what the prerender reads.
    $book = seedTranslateNoBook($this);
    app(BookCache::class)->warm($book);

    $html = $this->get("/{$book}")->assertStatus(200)->getContent();
    expect($html)->toContain('data-prerendered="true"');

    preg_match('/<sup[^>]*fn-count-id[^>]*>/i', $html, $m);
    expect($m[0] ?? '')->toContain('translate="no"');

    // ...while the prose around it stays translatable.
    expect($html)->toContain('Real prose a reader wants translated');
    preg_match('/<p[^>]*>Real prose/i', $html, $p);
    expect($p[0] ?? '')->not->toContain('translate');
});
