<?php

/**
 * OaLocationResolver location cache — the work-level OA candidate list is
 * persisted on canonical_source.oa_locations on first resolve, so re-harvests /
 * retries reuse it with ZERO external API calls. forceRefresh is the only
 * re-pull path (a fetch FAILURE must never trigger one — see the migration).
 *
 * Seeds + asserts via pgsql_admin (canonical_source has no RLS); those writes
 * commit outside RefreshDatabase's transaction, so rows are cleaned by prefix.
 */

use App\Services\SourceImport\Content\OaLocationResolver;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

function seedOaCacheCanonical(array $opts = []): string
{
    $id = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('canonical_source')->insert([
        'id'           => $id,
        'openalex_id'  => $opts['openalex_id'] ?? ('W_OACACHE_' . Str::random(8)),
        'oa_locations' => $opts['oa_locations'] ?? null,
    ]);
    return $id;
}

function oaCacheRecord(string $canonicalId, string $openalexId): object
{
    // openalex_id set, NO doi → only the OpenAlex lane runs (one request on a
    // miss), so the request count is unambiguous.
    return (object) [
        'canonical_source_id' => $canonicalId,
        'openalex_id'         => $openalexId,
        'doi'                 => null,
        'pdf_url'             => null,
        'oa_url'              => null,
    ];
}

/** A cache payload at the CURRENT version — mirrors what persistLocations writes. */
function currentVersionOaCache(array $locations): string
{
    $ref = new ReflectionClassConstant(OaLocationResolver::class, 'CACHE_VERSION');
    return json_encode(['v' => $ref->getValue(), 'locations' => $locations]);
}

function fakeOpenAlexLocations(array $locations): void
{
    Http::fake([
        'api.openalex.org/works/*' => Http::response([
            'id'        => 'https://openalex.org/W_OACACHE',
            'locations' => $locations,
        ]),
    ]);
}

beforeEach(function () {
    DB::connection('pgsql_admin')->table('canonical_source')
        ->where('openalex_id', 'LIKE', 'W_OACACHE_%')->delete();
});

afterEach(function () {
    DB::connection('pgsql_admin')->table('canonical_source')
        ->where('openalex_id', 'LIKE', 'W_OACACHE_%')->delete();
});

test('first resolve gathers + persists; second resolve is a cache hit with no API call', function () {
    $openalexId  = 'W_OACACHE_' . Str::random(8);
    $canonicalId = seedOaCacheCanonical(['openalex_id' => $openalexId]);

    fakeOpenAlexLocations([
        ['is_oa' => true, 'pdf_url' => 'https://direct.mit.edu/x.pdf', 'landing_page_url' => null, 'source' => ['type' => 'journal']],
        ['is_oa' => true, 'pdf_url' => 'https://zenodo.org/record/1/files/x.pdf', 'landing_page_url' => null, 'source' => ['type' => 'repository']],
    ]);

    $record   = oaCacheRecord($canonicalId, $openalexId);
    $resolver = app(OaLocationResolver::class);

    // Miss → gather + persist, repository ranked first.
    $first = $resolver->resolve($record);
    expect($first[0]['host'])->toBe('zenodo.org');
    expect(array_column($first, 'host'))->toContain('direct.mit.edu');

    // Persisted on the canonical as the versioned wrapper (the two work-level copies).
    $stored = DB::connection('pgsql_admin')->table('canonical_source')
        ->where('id', $canonicalId)->value('oa_locations');
    expect($stored)->not->toBeNull();
    $decoded = json_decode($stored, true);
    expect($decoded['v'])->toBeInt();
    expect($decoded['locations'])->toHaveCount(2);

    // Hit → identical result, no further OpenAlex request.
    $second = $resolver->resolve($record);
    expect(array_column($second, 'host'))->toEqual(array_column($first, 'host'));

    Http::assertSentCount(1); // the single miss-time request, never repeated
});

test('an empty cached list is a HIT (no re-call), not a miss', function () {
    $openalexId  = 'W_OACACHE_' . Str::random(8);
    // Already resolved AT THE CURRENT cache version, no extra copies found last time.
    $canonicalId = seedOaCacheCanonical(['openalex_id' => $openalexId, 'oa_locations' => currentVersionOaCache([])]);

    fakeOpenAlexLocations([
        ['is_oa' => true, 'pdf_url' => 'https://zenodo.org/record/2/files/y.pdf', 'landing_page_url' => null, 'source' => ['type' => 'repository']],
    ]);

    $resolver = app(OaLocationResolver::class);
    $resolver->resolve(oaCacheRecord($canonicalId, $openalexId));

    Http::assertSentCount(0); // '[]' is a hit — the API is never touched
});

test('a pre-versioning (plain array) cache is a MISS and upgrades in place', function () {
    $openalexId = 'W_OACACHE_' . Str::random(8);
    // Legacy v1 format: a bare JSON list, persisted before CORE existed as a
    // source. It must NOT be trusted — re-gather so the new source is consulted.
    $canonicalId = seedOaCacheCanonical([
        'openalex_id'  => $openalexId,
        'oa_locations' => json_encode([
            ['pdf_url' => 'https://direct.mit.edu/x.pdf', 'landing_page_url' => null, 'host_type' => 'publisher', 'source' => 'openalex'],
        ]),
    ]);

    fakeOpenAlexLocations([
        ['is_oa' => true, 'pdf_url' => 'https://zenodo.org/record/3/files/z.pdf', 'landing_page_url' => null, 'source' => ['type' => 'repository']],
    ]);

    $resolver = app(OaLocationResolver::class);
    $resolved = $resolver->resolve(oaCacheRecord($canonicalId, $openalexId));

    Http::assertSentCount(1); // stale-version cache → one re-gather
    expect(array_column($resolved, 'host'))->toContain('zenodo.org');

    // Re-persisted in the versioned wrapper → next resolve is a hit again.
    $stored = json_decode(DB::connection('pgsql_admin')->table('canonical_source')
        ->where('id', $canonicalId)->value('oa_locations'), true);
    expect($stored['v'])->toBeInt();

    $resolver->resolve(oaCacheRecord($canonicalId, $openalexId));
    Http::assertSentCount(1); // still just the one upgrade-time request
});

test('forceRefresh bypasses the cache and re-pulls', function () {
    $openalexId  = 'W_OACACHE_' . Str::random(8);
    $canonicalId = seedOaCacheCanonical(['openalex_id' => $openalexId, 'oa_locations' => currentVersionOaCache([])]);

    fakeOpenAlexLocations([
        ['is_oa' => true, 'pdf_url' => 'https://zenodo.org/record/2/files/y.pdf', 'landing_page_url' => null, 'source' => ['type' => 'repository']],
    ]);

    $resolver  = app(OaLocationResolver::class);
    $refreshed = $resolver->resolve(oaCacheRecord($canonicalId, $openalexId), forceRefresh: true);

    expect(array_column($refreshed, 'host'))->toContain('zenodo.org');
    Http::assertSentCount(1);

    // The newly-found copy replaced the empty cache.
    $stored = json_decode(DB::connection('pgsql_admin')->table('canonical_source')
        ->where('id', $canonicalId)->value('oa_locations'), true);
    expect($stored['locations'])->toHaveCount(1);
});
