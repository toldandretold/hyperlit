<?php

/**
 * The keystone: ContentFetchService converts journal HTML to app-native
 * citations via the shared paste engine, GATED so a page that isn't provably
 * the article can never become a canonical version (requirement 3).
 *
 * Two layers tested:
 *  - assessArticleAuthenticity (deterministic, no Node): identity × completeness
 *    → reject / unverified / verified.
 *  - importViaPasteEngine end-to-end (shells the real scripts/paste-convert.mjs):
 *    persists nodes + bibliography + footnotes and tags conversion_method so an
 *    unverified scrape stays out of SYSTEM_CONVERSION_METHODS.
 */

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\ContentFetchService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

function pasteDb()
{
    return DB::connection('pgsql_admin');
}

function pasteSeedStub(array $opts = []): string
{
    $book = $opts['book'] ?? ('book_canonv_paste_' . Str::random(8));
    pasteDb()->table('library')->insert([
        'book'              => $book,
        'title'             => $opts['title'] ?? 'Towards theorizing peer review',
        'doi'               => $opts['doi'] ?? '10.1162/qss_a_00195',
        'visibility'        => 'public',
        'listed'            => false,
        'has_nodes'         => false,
        'conversion_method' => null,
        'raw_json'          => '[]',
        'timestamp'         => 0,
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);
    return $book;
}

function pasteCleanup(string $book): void
{
    foreach (['nodes', 'bibliography', 'footnotes'] as $t) {
        pasteDb()->table($t)->where('book', $book)->delete();
        pasteDb()->table($t)->where('book', 'like', $book . '/%')->delete();
    }
    pasteDb()->table('library')->where('book', $book)->delete();
    pasteDb()->table('library')->where('book', 'like', $book . '/%')->delete();
    @File_delete_dir(resource_path('markdown/' . $book));
}
if (!function_exists('File_delete_dir')) {
    function File_delete_dir($d) { if (is_dir($d)) { array_map('unlink', glob("$d/*") ?: []); @rmdir($d); } }
}

function callGate(string $html, array $engine, string $book): string
{
    $svc = app(ContentFetchService::class);
    $m = new ReflectionMethod($svc, 'assessArticleAuthenticity');
    $m->setAccessible(true);
    return $m->invoke($svc, $html, $engine, $book);
}

// ── Gate: identity × completeness ──────────────────────────────────

test('gate REJECTS when the page DOI contradicts the stub', function () {
    $book = pasteSeedStub(['doi' => '10.1162/qss_a_00195']);
    try {
        $html = '<meta name="citation_doi" content="10.9999/some-other-paper">';
        $engine = ['formatType' => 'mit-press', 'references' => [['referenceId' => 'a', 'content' => 'x']]];
        expect(callGate($html, $engine, $book))->toBe('reject');
    } finally {
        pasteCleanup($book);
    }
});

test('gate VERIFIES when DOI matches and a real processor found references', function () {
    $book = pasteSeedStub(['doi' => '10.1162/qss_a_00195']);
    try {
        $html = '<meta name="citation_doi" content="https://doi.org/10.1162/qss_a_00195">';
        $engine = ['formatType' => 'mit-press', 'references' => [['referenceId' => 'a', 'content' => 'x']]];
        expect(callGate($html, $engine, $book))->toBe('verified');
    } finally {
        pasteCleanup($book);
    }
});

test('gate stays UNVERIFIED when identity confirmed but only the general processor matched', function () {
    $book = pasteSeedStub();
    try {
        $html = '<meta name="citation_doi" content="10.1162/qss_a_00195">';
        $engine = ['formatType' => 'general', 'references' => [['referenceId' => 'a', 'content' => 'x']]];
        expect(callGate($html, $engine, $book))->toBe('unverified');
    } finally {
        pasteCleanup($book);
    }
});

test('gate stays UNVERIFIED when no page metadata pins identity (e.g. clipboard selection)', function () {
    $book = pasteSeedStub();
    try {
        $html = '<div>no citation meta here</div>';
        $engine = ['formatType' => 'mit-press', 'references' => [['referenceId' => 'a', 'content' => 'x']]];
        expect(callGate($html, $engine, $book))->toBe('unverified');
    } finally {
        pasteCleanup($book);
    }
});

test('gate verifies via title similarity when DOI meta is absent but titles match', function () {
    $book = pasteSeedStub(['title' => 'Towards theorizing peer review']);
    try {
        $html = '<meta name="citation_title" content="Towards theorizing peer review">';
        $engine = ['formatType' => 'mit-press', 'references' => [['referenceId' => 'a', 'content' => 'x']]];
        expect(callGate($html, $engine, $book))->toBe('verified');
    } finally {
        pasteCleanup($book);
    }
});

// ── End-to-end persist (shells the real paste engine) ──────────────

test('importViaPasteEngine persists nodes + bibliography + footnotes and gates a clipboard scrape to unverified', function () {
    $fixture = base_path('tests/paste/fixtures/clipboard/MITpress.html');
    if (!file_exists($fixture)) {
        $this->markTestSkipped('MITpress.html fixture not present');
    }

    $book = pasteSeedStub();
    try {
        $svc = app(ContentFetchService::class);
        $m = new ReflectionMethod($svc, 'importViaPasteEngine');
        $m->setAccessible(true);
        $res = $m->invoke($svc, file_get_contents($fixture), $book, 'https://doi.org/test');

        expect($res['status'])->toBe('imported');
        expect(pasteDb()->table('nodes')->where('book', $book)->count())->toBeGreaterThan(50);
        expect(pasteDb()->table('bibliography')->where('book', $book)->count())->toBeGreaterThan(50);

        // No MIT processor yet → general fallback → gate withholds canonical status.
        $method = pasteDb()->table('library')->where('book', $book)->value('conversion_method');
        expect($method)->toBe('html_scrape_unverified');
        expect(in_array($method, AutoVersionResolver::SYSTEM_CONVERSION_METHODS, true))
            ->toBeFalse('unverified scrape must never be a system auto-version');
    } finally {
        pasteCleanup($book);
    }
});
