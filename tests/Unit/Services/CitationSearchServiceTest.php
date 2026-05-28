<?php

/**
 * CitationSearchService — pure orchestration assertions with mocked deps.
 *
 * Locks: external lookup only on public scope + offset=0 + thin local results,
 * external candidates routed through CanonicalSourceMatcher::ingestExternal,
 * library stubs NOT created via OpenAlexService::upsertLibraryStubs.
 */

use App\Models\CanonicalSource;
use App\Services\CanonicalSourceMatcher;
use App\Services\CitationSearchService;
use App\Services\OpenAlexService;
use App\Services\OpenLibraryService;
use App\Services\SearchService;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

// Pure orchestration tests but the service uses the Cache facade,
// which needs the Laravel app booted — pull in TestCase.
uses(TestCase::class);

beforeEach(function () {
    Cache::flush();
});

function citationServiceWith($search, $openAlex, $openLibrary, $matcher): CitationSearchService
{
    return new CitationSearchService($search, $openAlex, $openLibrary, $matcher);
}

test('mine scope: no external API calls regardless of local result count', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([]);

    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldNotReceive('fetchFromOpenAlex');

    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldNotReceive('search');

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);

    $svc = citationServiceWith($search, $openAlex, $openLibrary, $matcher);
    $result = $svc->search('something', 15, 0, 'mine', null, 'alice');

    expect($result['external_ingested'])->toBe(0);
});

test('shelf scope: no external API calls', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([]);

    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldNotReceive('fetchFromOpenAlex');

    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldNotReceive('search');

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);

    $svc = citationServiceWith($search, $openAlex, $openLibrary, $matcher);
    $svc->search('something', 15, 0, 'shelf', 'some-uuid', 'alice');
});

test('offset > 0: no external API calls (load-more should not re-ingest)', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([]);

    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldNotReceive('fetchFromOpenAlex');

    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldNotReceive('search');

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);

    $svc = citationServiceWith($search, $openAlex, $openLibrary, $matcher);
    $svc->search('q', 15, 15, 'public');
});

test('public scope with thin results: external APIs fire once, candidates ingested into canonical_source', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->twice()->andReturn([]); // first call: thin, second call (after ingest): re-fetch

    $openAlexCandidate = ['openalex_id' => 'W_UT_OA', 'title' => 'UT OA Work', 'author' => 'UT', 'year' => 2024];
    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldReceive('fetchFromOpenAlex')->once()->andReturn([$openAlexCandidate]);

    $openLibraryCandidate = ['open_library_key' => '/works/OL_UT', 'title' => 'UT OL Work', 'author' => 'UT'];
    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldReceive('search')->once()->andReturn([$openLibraryCandidate]);

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);
    // Both candidates ingested; foundation_source distinguishes provenance.
    $matcher->shouldReceive('ingestExternal')
        ->once()
        ->with($openAlexCandidate, 'openalex_citation_search')
        ->andReturn(new CanonicalSource(['id' => '11111111-1111-1111-1111-111111111111']));
    $matcher->shouldReceive('ingestExternal')
        ->once()
        ->with($openLibraryCandidate, 'open_library_citation_search')
        ->andReturn(new CanonicalSource(['id' => '22222222-2222-2222-2222-222222222222']));

    $svc = citationServiceWith($search, $openAlex, $openLibrary, $matcher);
    $r = $svc->search('CiteUnit_unique', 15, 0, 'public');

    expect($r['external_ingested'])->toBe(2);
});

test('public scope with full results: external APIs do not fire', function () {
    $fullResults = array_fill(0, 15, (object) ['row_type' => 'canonical']);
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->once()->andReturn($fullResults);

    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldNotReceive('fetchFromOpenAlex');

    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldNotReceive('search');

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);
    $matcher->shouldNotReceive('ingestExternal');

    $svc = citationServiceWith($search, $openAlex, $openLibrary, $matcher);
    $r = $svc->search('q', 15, 0, 'public');

    expect($r['external_ingested'])->toBe(0)
        ->and(count($r['results']))->toBe(15);
});

test('OpenAlexService::upsertLibraryStubs is NEVER called from this service', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([]);

    // Strict mock — any unexpected call throws.
    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldReceive('fetchFromOpenAlex')->andReturn([]);
    $openAlex->shouldNotReceive('upsertLibraryStubs');
    $openAlex->shouldNotReceive('upsertOpenLibraryStubs');

    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldReceive('search')->andReturn([]);

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);

    $svc = citationServiceWith($search, $openAlex, $openLibrary, $matcher);
    $svc->search('q', 15, 0, 'public');
});

test('cached query skips external lookup on second call', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->twice()->andReturn([]);

    // First call: external fires
    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldReceive('fetchFromOpenAlex')->once()->andReturn([]);

    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldReceive('search')->once()->andReturn([]);

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);

    $svc = citationServiceWith($search, $openAlex, $openLibrary, $matcher);

    $svc->search('cache_unit_test', 15, 0, 'public');
    // Second call within TTL — external must NOT fire (Mockery enforces ->once())
    $svc->search('cache_unit_test', 15, 0, 'public');
});

test('case insensitivity in cache key: "Marx Capital" and "marx capital" share cache', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([]);

    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldReceive('fetchFromOpenAlex')->once()->andReturn([]);

    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldReceive('search')->once()->andReturn([]);

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);

    $svc = citationServiceWith($search, $openAlex, $openLibrary, $matcher);

    $svc->search('Cache Case Test', 15, 0, 'public');
    $svc->search('  cache case test  ', 15, 0, 'public'); // different casing + whitespace
});
