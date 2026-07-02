<?php

/**
 * CitationSearchService — pure orchestration assertions with mocked deps.
 *
 * Locks: external ingest is DISPATCHED (never run inline) and only on public
 * scope + offset=0 + thin local results; the 900s dedup key suppresses repeat
 * dispatches; external_pending signals the frontend's one-shot re-query.
 *
 * The ingest body itself (source routing, failure isolation, generation bump)
 * is covered in tests/Unit/Jobs/IngestExternalCitationCandidatesJobTest.php.
 */

use App\Jobs\IngestExternalCitationCandidatesJob;
use App\Services\CitationSearchService;
use App\Services\SearchService;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

// Pure orchestration tests but the service uses the Cache facade,
// which needs the Laravel app booted — pull in TestCase.
uses(TestCase::class);

beforeEach(function () {
    Cache::flush();
    Bus::fake();
});

function citationServiceWith($search): CitationSearchService
{
    return new CitationSearchService($search);
}

test('mine scope: no external dispatch regardless of local result count', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([]);

    $svc = citationServiceWith($search);
    $result = $svc->search('something', 15, 0, 'mine', null, 'alice');

    Bus::assertNotDispatched(IngestExternalCitationCandidatesJob::class);
    expect($result['external_pending'])->toBeFalse()
        ->and($result['external_ingested'])->toBe(0);
});

test('shelf scope: no external dispatch', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([]);

    $svc = citationServiceWith($search);
    $svc->search('something', 15, 0, 'shelf', 'some-uuid', 'alice');

    Bus::assertNotDispatched(IngestExternalCitationCandidatesJob::class);
});

test('offset > 0: no external dispatch (load-more should not re-ingest)', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([]);

    $svc = citationServiceWith($search);
    $svc->search('q', 15, 15, 'public');

    Bus::assertNotDispatched(IngestExternalCitationCandidatesJob::class);
});

test('public scope with thin results: ingest job dispatched once, local search runs once', function () {
    $search = Mockery::mock(SearchService::class);
    // Exactly once — the old sync flow re-ran the hybrid query after ingest;
    // the async flow must not.
    $search->shouldReceive('searchForCitations')->once()->andReturn([]);

    $svc = citationServiceWith($search);
    $r = $svc->search('CiteUnit_unique', 15, 0, 'public');

    Bus::assertDispatched(IngestExternalCitationCandidatesJob::class, function ($job) {
        return $job->query === 'CiteUnit_unique'
            && $job->perSource === CitationSearchService::EXTERNAL_PER_SOURCE
            // Dedicated queue — a user is actively polling for this job; it must
            // never wait behind imports on `default`. Ships with
            // deploy/supervisor/hyperlit-search.conf (README invariant #1).
            && $job->queue === 'search-supplement';
    });
    expect($r['external_pending'])->toBeTrue()
        // Short spam-guard hold set BEFORE dispatch — keystroke spam can't
        // double-dispatch even before the job has started running.
        ->and(Cache::has(IngestExternalCitationCandidatesJob::dedupKey('CiteUnit_unique')))->toBeTrue();
});

test('public scope with full results: no external dispatch', function () {
    $fullResults = array_fill(0, 15, (object) ['row_type' => 'canonical']);
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->once()->andReturn($fullResults);

    $svc = citationServiceWith($search);
    $r = $svc->search('q', 15, 0, 'public');

    Bus::assertNotDispatched(IngestExternalCitationCandidatesJob::class);
    expect($r['external_pending'])->toBeFalse()
        ->and(count($r['results']))->toBe(15);
});

test('cached query skips external dispatch AND the local SQL on second call', function () {
    $search = Mockery::mock(SearchService::class);
    // Once: the second call is served by the 60s results cache.
    $search->shouldReceive('searchForCitations')->once()->andReturn([]);

    $svc = citationServiceWith($search);

    $first = $svc->search('cache_unit_test', 15, 0, 'public');
    // Second call within TTL — results cache hit + dedup key suppresses re-dispatch.
    $second = $svc->search('cache_unit_test', 15, 0, 'public');

    Bus::assertDispatchedTimes(IngestExternalCitationCandidatesJob::class, 1);
    expect($first['external_pending'])->toBeTrue()
        ->and($second['external_pending'])->toBeFalse();
});

test('results cache does NOT leak across scope, creator, shelf, limit, or offset', function () {
    $search = Mockery::mock(SearchService::class);
    // Five distinct input combinations → five real SQL executions, no sharing.
    $search->shouldReceive('searchForCitations')->times(5)->andReturn([]);

    $svc = citationServiceWith($search);

    $svc->search('leak test', 15, 0, 'public');
    $svc->search('leak test', 15, 0, 'mine', null, 'alice');
    $svc->search('leak test', 15, 0, 'mine', null, 'bob');
    $svc->search('leak test', 15, 15, 'public');
    $svc->search('leak test', 10, 0, 'public');
});

test('generation bump (completed background ingest) invalidates the results cache', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->twice()->andReturn([]);

    $svc = citationServiceWith($search);

    $svc->search('gen bump test', 15, 0, 'public');
    // Simulate the ingest job completing with new canonicals (put, not
    // increment — database-store increment no-ops on missing keys, which is
    // why the job itself uses put; see IngestExternalCitationCandidatesJob).
    Cache::put(IngestExternalCitationCandidatesJob::generationKey('gen bump test'), 1, 3600);
    // Same query within TTL — but the generation segment rolled the key.
    $svc->search('gen bump test', 15, 0, 'public');
});

test('external_status reflects the supplement lifecycle: dispatched → pending → outcome', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([]);

    $svc = citationServiceWith($search);

    // 1. First thin public search dispatches.
    $r = $svc->search('status lifecycle', 15, 0, 'public');
    expect($r['external_status'])->toBe('dispatched');

    // 2. Dedup key set, job outcome unknown yet (Bus::fake — job never ran).
    Cache::forget('nothing'); // (results cache key differs per gen; same call again)
    $r = $svc->search('status lifecycle', 15, 0, 'public');
    expect($r['external_status'])->toBe('pending');

    // 3. Job wrote its outcome.
    Cache::put(IngestExternalCitationCandidatesJob::statusKey('status lifecycle'), 'sources_failed', 900);
    $r = $svc->search('status lifecycle', 15, 0, 'public');
    expect($r['external_status'])->toBe('sources_failed');
});

test('external_status is null for non-public scope and full result pages', function () {
    $fullResults = array_fill(0, 15, (object) ['row_type' => 'canonical']);
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([], $fullResults);

    $svc = citationServiceWith($search);

    expect($svc->search('q', 15, 0, 'mine', null, 'alice')['external_status'])->toBeNull()
        ->and($svc->search('full page', 15, 0, 'public')['external_status'])->toBeNull();
});

test('search returns a timings breakdown for observability', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn(array_fill(0, 15, (object) ['row_type' => 'canonical']));

    $svc = citationServiceWith($search);
    $r = $svc->search('q', 15, 0, 'public');

    expect($r['timings'])->toBeArray()
        ->and($r['timings']['local_ms'])->toBeFloat();
});

test('case insensitivity in cache key: "Marx Capital" and "marx capital" share cache', function () {
    $search = Mockery::mock(SearchService::class);
    $search->shouldReceive('searchForCitations')->andReturn([]);

    $svc = citationServiceWith($search);

    $svc->search('Cache Case Test', 15, 0, 'public');
    $svc->search('  cache case test  ', 15, 0, 'public'); // different casing + whitespace

    Bus::assertDispatchedTimes(IngestExternalCitationCandidatesJob::class, 1);
});
