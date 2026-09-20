<?php

/**
 * A web source whose verification already FAILED is not re-fetched every run.
 *
 * `ContentFetchService::importWebSource` records its failure reason in
 * `library.pdf_url_status` but leaves `conversion_method` NULL — and the vacuum
 * stage's query selects on `conversion_method IS NULL`. So a walled page was
 * handed a full browser fetch on EVERY run, forever, and nothing remembered.
 *
 * Measured on chacko: 36 of 52 unverified stubs carried a recorded wall (13
 * Cloudflare, 7 Akamai, 5 reCAPTCHA, 1 PerimeterX, plus body-absent pages).
 * With the window, 32 of the 52 are skipped — about 32 browser fetches, half an
 * hour, per rerun.
 *
 * These assert the QUERY SHAPE the vacuum stage uses, against real rows, rather
 * than running the stage (which needs a browser).
 */

use Illuminate\Support\Facades\DB;

function vacuumWebSourceQuery(string $bookId, bool $refetchWalled = false)
{
    $db = DB::connection('pgsql_admin');
    $hours = (int) config('services.source_fetch.web_verify_retry_hours', 168);

    return $db->table('bibliography as b')
        ->join('library as l', 'l.book', '=', 'b.foundation_source')
        ->where('b.book', $bookId)
        ->where('l.type', 'web_source')
        ->whereNull('l.conversion_method')
        ->whereNotNull('l.url')->where('l.url', '!=', '')
        ->when(! $refetchWalled && $hours > 0, function ($q) use ($hours) {
            $q->where(function ($w) use ($hours) {
                $w->whereNull('l.pdf_url_status')
                    ->orWhereIn('l.pdf_url_status', ['downloaded', 'imported'])
                    ->orWhere('l.updated_at', '<=', now()->subHours($hours));
            });
        })
        ->distinct();
}

function seedWebStub(string $book, string $url, ?string $status, string $updatedAt, ?string $conversionMethod = null): void
{
    $db = DB::connection('pgsql_admin');
    $db->table('library')->insert([
        'book' => $book, 'title' => 'Stub', 'url' => $url, 'type' => 'web_source',
        'pdf_url_status' => $status, 'conversion_method' => $conversionMethod,
        'has_nodes' => true, 'creator' => 'WebFetch', 'visibility' => 'public', 'listed' => false,
        'raw_json' => json_encode(['method' => 'test']),
        'timestamp' => round(microtime(true) * 1000),
        'created_at' => $updatedAt, 'updated_at' => $updatedAt,
    ]);
    $db->table('bibliography')->insert([
        'book' => 'parent-book', 'referenceId' => 'ref-'.$book, 'content' => 'A citation',
        'foundation_source' => $book, 'created_at' => now(), 'updated_at' => now(),
    ]);
}

beforeEach(function () {
    $db = DB::connection('pgsql_admin');
    $db->table('bibliography')->where('book', 'parent-book')->delete();
    $db->table('library')->where('book', 'like', 'test_webstub_%')->delete();
});

afterEach(function () {
    $db = DB::connection('pgsql_admin');
    $db->table('bibliography')->where('book', 'parent-book')->delete();
    $db->table('library')->where('book', 'like', 'test_webstub_%')->delete();
});

test('a recently WALLED source is not re-fetched', function () {
    seedWebStub('test_webstub_walled', 'https://walled.example/a', 'blocked by a Cloudflare challenge', now()->subHour()->toDateTimeString());

    expect(vacuumWebSourceQuery('parent-book')->count('l.book'))->toBe(0);
});

test('a source never attempted IS fetched', function () {
    seedWebStub('test_webstub_fresh', 'https://fresh.example/a', null, now()->toDateTimeString());

    expect(vacuumWebSourceQuery('parent-book')->count('l.book'))->toBe(1);
});

test('the window EXPIRES — a wall is believed for a while, not forever', function () {
    // Bot walls are frequently rate-based and do lift. Nothing is retired
    // permanently, same principle as FetchHostHealth's backoff ladder.
    seedWebStub('test_webstub_stale', 'https://walled.example/b', 'blocked by an Akamai bot check', now()->subDays(30)->toDateTimeString());

    expect(vacuumWebSourceQuery('parent-book')->count('l.book'))->toBe(1);
});

test('--refetch-walled overrides the window', function () {
    // The escape hatch: after landing a new technique, you need to be able to
    // retry everything that a previous technique failed on.
    seedWebStub('test_webstub_override', 'https://walled.example/c', 'blocked by a reCAPTCHA challenge', now()->subMinute()->toDateTimeString());

    expect(vacuumWebSourceQuery('parent-book', refetchWalled: false)->count('l.book'))->toBe(0)
        ->and(vacuumWebSourceQuery('parent-book', refetchWalled: true)->count('l.book'))->toBe(1);
});

test("'downloaded' and 'imported' are progress, not failures", function () {
    // pdf_url_status doubles as a progress marker and a failure reason. Treating
    // the two progress values as failures would freeze real work.
    seedWebStub('test_webstub_dl', 'https://ok.example/a', 'downloaded', now()->subMinute()->toDateTimeString());
    seedWebStub('test_webstub_imp', 'https://ok.example/b', 'imported', now()->subMinute()->toDateTimeString());

    expect(vacuumWebSourceQuery('parent-book')->count('l.book'))->toBe(2);
});

test('an already-verified source is never revisited', function () {
    // conversion_method set means the work is done — the original guard.
    seedWebStub('test_webstub_done', 'https://ok.example/c', 'imported', now()->toDateTimeString(), 'web_article_verified');

    expect(vacuumWebSourceQuery('parent-book')->count('l.book'))->toBe(0);
});
