<?php

/**
 * IngestExternalCitationCandidatesJob — the ingest body moved out of
 * CitationSearchService when external lookup went async.
 *
 * Locks: candidates from both sources routed to CanonicalSourceMatcher with
 * the right foundation_source; one bad candidate doesn't sink the rest; the
 * per-query generation counter (combined-search cache invalidation signal)
 * bumps only when something was actually ingested.
 */

use App\Jobs\IngestExternalCitationCandidatesJob;
use App\Models\CanonicalSource;
use App\Services\CanonicalSourceMatcher;
use App\Services\OpenAlexService;
use App\Services\OpenLibraryService;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

uses(TestCase::class);

beforeEach(function () {
    Cache::flush();
});

test('candidates from both sources are ingested with provenance-specific foundation source', function () {
    $openAlexCandidate = ['openalex_id' => 'W_UT_OA', 'title' => 'UT OA Work', 'author' => 'UT', 'year' => 2024];
    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldReceive('fetchFromOpenAlex')
        ->once()
        ->with('unit query', 5, 1, false) // positional: Mockery can't match PHP named args
        ->andReturn([$openAlexCandidate]);

    $openLibraryCandidate = ['open_library_key' => '/works/OL_UT', 'title' => 'UT OL Work', 'author' => 'UT'];
    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldReceive('search')->once()->andReturn([$openLibraryCandidate]);

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);
    $matcher->shouldReceive('ingestExternal')
        ->once()
        ->with($openAlexCandidate, 'openalex_citation_search')
        ->andReturn(new CanonicalSource(['id' => '11111111-1111-1111-1111-111111111111']));
    $matcher->shouldReceive('ingestExternal')
        ->once()
        ->with($openLibraryCandidate, 'open_library_citation_search')
        ->andReturn(new CanonicalSource(['id' => '22222222-2222-2222-2222-222222222222']));

    (new IngestExternalCitationCandidatesJob('unit query', 5))
        ->handle($openAlex, $openLibrary, $matcher);
});

test('one failing candidate does not sink the others, and the generation still bumps', function () {
    $bad  = ['openalex_id' => 'W_BAD', 'title' => 'Bad'];
    $good = ['openalex_id' => 'W_GOOD', 'title' => 'Good'];

    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldReceive('fetchFromOpenAlex')->andReturn([$bad, $good]);

    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldReceive('search')->andReturn([]);

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);
    $matcher->shouldReceive('ingestExternal')
        ->with($bad, 'openalex_citation_search')
        ->andThrow(new RuntimeException('duplicate key'));
    $matcher->shouldReceive('ingestExternal')
        ->with($good, 'openalex_citation_search')
        ->andReturn(new CanonicalSource(['id' => '33333333-3333-3333-3333-333333333333']));

    $genKey = IngestExternalCitationCandidatesJob::generationKey('resilience query');
    expect(Cache::get($genKey))->toBeNull();

    (new IngestExternalCitationCandidatesJob('resilience query', 5))
        ->handle($openAlex, $openLibrary, $matcher);

    expect((int) Cache::get($genKey))->toBe(1);
});

test('generation counter does NOT bump when nothing was ingested', function () {
    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldReceive('fetchFromOpenAlex')->andReturn([]);

    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldReceive('search')->andReturn([]);

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);
    $matcher->shouldNotReceive('ingestExternal');

    $genKey = IngestExternalCitationCandidatesJob::generationKey('empty query');

    (new IngestExternalCitationCandidatesJob('empty query', 5))
        ->handle($openAlex, $openLibrary, $matcher);

    expect(Cache::get($genKey))->toBeNull();
});

test('both external sources failing still completes without a generation bump', function () {
    $openAlex = Mockery::mock(OpenAlexService::class);
    $openAlex->shouldReceive('fetchFromOpenAlex')->andThrow(new RuntimeException('429'));

    $openLibrary = Mockery::mock(OpenLibraryService::class);
    $openLibrary->shouldReceive('search')->andThrow(new RuntimeException('500'));

    $matcher = Mockery::mock(CanonicalSourceMatcher::class);
    $matcher->shouldNotReceive('ingestExternal');

    $genKey = IngestExternalCitationCandidatesJob::generationKey('doom query');

    (new IngestExternalCitationCandidatesJob('doom query', 5))
        ->handle($openAlex, $openLibrary, $matcher);

    expect(Cache::get($genKey))->toBeNull();
});

test('uniqueId normalizes casing and whitespace', function () {
    $a = new IngestExternalCitationCandidatesJob('Marx Capital', 5);
    $b = new IngestExternalCitationCandidatesJob('  marx capital  ', 5);
    expect($a->uniqueId())->toBe($b->uniqueId());
});
