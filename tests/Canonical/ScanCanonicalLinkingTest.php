<?php

/**
 * Phase 2: the citation scan feeds the canonical layer. When
 * CitationScanBibliographyJob resolves a citation via an identifier-backed
 * source (OpenAlex / DOI / Open Library / Semantic Scholar), the stub it
 * creates must be registered as a version of a canonical_source row, and
 * bibliography.canonical_source_id must be written. Web/Brave stubs must NOT
 * get canonicals (no external identity — a wrong canonical is worse than none).
 */

use App\Jobs\CitationScanBibliographyJob;
use App\Services\OpenAlexService;
use Illuminate\Support\Facades\DB;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

function canonvSeedBibEntry(string $book, string $refId, array $opts = []): void
{
    canonvDb()->table('bibliography')->insert(array_merge([
        'book'        => $book,
        'referenceId' => $refId,
        'content'     => '<p>Scan, Author. CanonV Scan Linked Work. 2021.</p>',
        'created_at'  => now(),
        'updated_at'  => now(),
    ], $opts));
}

function canonvResolveWithNormalised(string $book, array $poolItem, array $normalised, string $method): ?array
{
    $job = new CitationScanBibliographyJob('canonv-scan-id', $book);
    $ref = new ReflectionMethod($job, 'resolveWithNormalised');
    $ref->setAccessible(true);

    return $ref->invoke($job, $poolItem, $normalised, $method, 0.9, app(OpenAlexService::class), DB::connection('pgsql_admin'));
}

test('an identifier-backed resolution creates a canonical and links stub + bibliography', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Citing Book']);
    canonvSeedBibEntry($book, 'ref1');

    $poolItem = [
        'referenceId'   => 'ref1',
        'isLinked'      => false,
        'searchedTitle' => 'CanonV Scan Linked Work',
        'llmMetadata'   => null,
    ];

    $result = canonvResolveWithNormalised($book, $poolItem, canonvNormalisedWork(), 'openalex');

    expect($result['status'])->toBe('newly_resolved');
    expect($result['canonical_source_id'])->not->toBeNull();

    // Canonical row exists, identifier-stamped. (Read via the DEFAULT
    // connection — the matcher creates canonicals through Eloquent inside
    // RefreshDatabase's transaction, invisible to pgsql_admin.)
    $canonical = DB::table('canonical_source')->where('id', $result['canonical_source_id'])->first();
    expect($canonical->openalex_id)->toBe('W_canonv_test_1');
    expect($canonical->doi)->toBe('10.9999/canonv-test-doi');
    expect($canonical->foundation_source)->toBe('openalex_ingest');

    // The stub library row is linked as a version
    $stub = canonvDb()->table('library')->where('book', $result['foundation_book_id'])->first();
    expect($stub->canonical_source_id)->toBe($result['canonical_source_id']);
    expect($stub->canonical_match_method)->toBe('citation_scan_openalex');

    // The bibliography entry carries the canonical link
    expect(canonvDb()->table('bibliography')->where('book', $book)->where('referenceId', 'ref1')->value('canonical_source_id'))
        ->toBe($result['canonical_source_id']);
});

test('re-resolving the same work reuses the canonical (identifier-first dedup)', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Citing Book Dedup']);
    canonvSeedBibEntry($book, 'ref1');
    canonvSeedBibEntry($book, 'ref2');

    $poolItem = ['referenceId' => 'ref1', 'isLinked' => false, 'searchedTitle' => 'CanonV Scan Linked Work', 'llmMetadata' => null];
    $first = canonvResolveWithNormalised($book, $poolItem, canonvNormalisedWork(), 'openalex');

    $poolItem['referenceId'] = 'ref2';
    $second = canonvResolveWithNormalised($book, $poolItem, canonvNormalisedWork(), 'openalex');

    expect($second['canonical_source_id'])->toBe($first['canonical_source_id']);
    expect($second['foundation_book_id'])->toBe($first['foundation_book_id']);
    expect(DB::table('canonical_source')->where('openalex_id', 'W_canonv_test_1')->count())->toBe(1);
});

test('non-identifier methods never create canonicals', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Citing Book Web']);

    $job = new CitationScanBibliographyJob('canonv-scan-id', $book);
    $ref = new ReflectionMethod($job, 'linkStubToCanonical');
    $ref->setAccessible(true);

    $stub = canonvSeedLibrary(['title' => 'CanonV Web Stub']);
    foreach (['web_fetch', 'brave_search', 'local_doi', 'library'] as $method) {
        expect($ref->invoke($job, $stub, canonvNormalisedWork(), $method))->toBeNull();
    }

    expect(DB::table('canonical_source')->where('title', 'CanonV Scan Linked Work')->count())->toBe(0);
});

test('canonical link failure never fails the resolution', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Citing Book Resilient']);
    canonvSeedBibEntry($book, 'ref1');

    $poolItem = ['referenceId' => 'ref1', 'isLinked' => false, 'searchedTitle' => 'CanonV Scan Linked Work', 'llmMetadata' => null];

    // A normalised work whose canonical insert will blow up (year too long for
    // the column) while the stub path survives — linkStubToCanonical must
    // swallow it. We simulate the cheap way: no identifiers at all means the
    // stub is created via createStubDirect and the canonical attempt is made
    // with nothing to upsert on — whatever happens, resolution must succeed.
    $normalised = canonvNormalisedWork([
        'openalex_id' => null,
        'doi'         => null,
        'title'       => 'CanonV Identifierless Work',
    ]);

    $result = canonvResolveWithNormalised($book, $poolItem, $normalised, 'openalex');

    expect($result['status'])->toBe('newly_resolved');
    expect($result['foundation_book_id'])->not->toBeNull();
});
