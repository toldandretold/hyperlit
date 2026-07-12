<?php

/**
 * AutoVersionCreator — the per-canonical body of library:create-auto-versions,
 * extracted so the Source Network Harvester job can call it directly. Only
 * no-network paths run here: ContentFetchService is mocked (or asserted
 * untouched); the real fetch/OCR lanes are covered by ops usage.
 */

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\SystemVersionMinter;
use App\Services\ContentFetchService;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

function avcCreator(?ContentFetchService $fetcher = null): AutoVersionCreator
{
    $fetcher = $fetcher ?? Mockery::mock(ContentFetchService::class);
    // AutoVersionCreator reads the fetch trace (winning OA host / candidate
    // count) after every fetch — stub it permissively so tests only need to
    // express the fetch() behaviour they care about.
    if ($fetcher instanceof \Mockery\MockInterface) {
        $fetcher->shouldReceive('lastFetchTrace')
            ->andReturn(['candidates' => 0, 'won_host' => null, 'won_source' => null])
            ->byDefault();
    }
    return new AutoVersionCreator(
        new AutoVersionResolver(),
        new SystemVersionMinter(),
        $fetcher
    );
}

test('wires the pointer from an existing converted stub without fetching', function () {
    $id = canonvSeedCanonical([
        'title'   => 'CanonV AVC Existing',
        'pdf_url' => 'https://example.org/canonv-avc-existing.pdf',
    ]);
    $stub = canonvSeedLibrary([
        'title'               => 'CanonV AVC Prior OCR Stub',
        'canonical_source_id' => $id,
        'conversion_method'   => AutoVersionResolver::CONVERSION_METHOD,
        'foundation_source'   => AutoVersionResolver::FOUNDATION_SOURCE,
        'creator'             => AutoVersionResolver::CREATOR,
        'has_nodes'           => true,
        'listed'              => false,
    ]);

    $fetcher = Mockery::mock(ContentFetchService::class);
    $fetcher->shouldNotReceive('fetch');
    $fetcher->shouldNotReceive('processLocalPdf');

    $result = avcCreator($fetcher)->create(CanonicalSource::findOrFail($id));

    expect($result['status'])->toBe('assigned_existing');
    expect($result['book'])->toBe($stub);
    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($stub);
});

test('a canonical whose pointer is already set short-circuits untouched', function () {
    $existing = canonvSeedLibrary(['title' => 'CanonV AVC Already Pointed']);
    $id = canonvSeedCanonical([
        'title'             => 'CanonV AVC Already Done',
        'pdf_url'           => 'https://example.org/canonv-avc-done.pdf',
        'auto_version_book' => $existing,
    ]);

    $fetcher = Mockery::mock(ContentFetchService::class);
    $fetcher->shouldNotReceive('fetch');

    $result = avcCreator($fetcher)->create(CanonicalSource::findOrFail($id));

    expect($result['status'])->toBe('assigned_existing');
    expect($result['book'])->toBe($existing);
});

test('no fetchable url on the minted stub reports fetch_failed without touching the fetcher', function () {
    // The minted stub copies the canonical's pdf_url/oa_url/doi — all empty here.
    $id = canonvSeedCanonical(['title' => 'CanonV AVC NoUrl']);

    $fetcher = Mockery::mock(ContentFetchService::class);
    $fetcher->shouldNotReceive('fetch');

    $result = avcCreator($fetcher)->create(CanonicalSource::findOrFail($id));

    expect($result['status'])->toBe('fetch_failed');
    expect($result['reason'])->toContain('no fetchable URL');
    // Stub stays in place for a later pass (same semantics as the command).
    expect(canonvDb()->table('library')->where('canonical_source_id', $id)->count())->toBe(1);
    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBeNull();
});

test('a failed fetch reports fetch_failed with the ladder reason', function () {
    $id = canonvSeedCanonical([
        'title'   => 'CanonV AVC FetchFail',
        'pdf_url' => 'https://example.org/canonv-avc-fail.pdf',
    ]);

    $fetcher = Mockery::mock(ContentFetchService::class);
    $fetcher->shouldReceive('fetch')->once()->andReturn(['status' => 'failed', 'reason' => 'HTTP 403 fetching PDF']);

    $result = avcCreator($fetcher)->create(CanonicalSource::findOrFail($id));

    expect($result['status'])->toBe('fetch_failed');
    expect($result['reason'])->toBe('HTTP 403 fetching PDF');
    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBeNull();
});

test('skip-ocr leaves the pointer deferred so the canonical stays eligible', function () {
    $id = canonvSeedCanonical([
        'title'   => 'CanonV AVC SkipOcr',
        'pdf_url' => 'https://example.org/canonv-avc-skipocr.pdf',
    ]);

    $fetcher = Mockery::mock(ContentFetchService::class);
    $fetcher->shouldReceive('fetch')->once()->andReturn(['status' => 'downloaded', 'reason' => 'PDF saved']);
    $fetcher->shouldNotReceive('processLocalPdf');

    $result = avcCreator($fetcher)->create(CanonicalSource::findOrFail($id), skipOcr: true);

    expect($result['status'])->toBe('deferred');
    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBeNull();

    // The minted stub carries the system provenance pair.
    $stub = canonvDb()->table('library')->where('canonical_source_id', $id)->first();
    expect($stub->conversion_method)->toBe(AutoVersionResolver::CONVERSION_METHOD);
    expect($stub->foundation_source)->toBe(AutoVersionResolver::FOUNDATION_SOURCE);
    expect($stub->creator)->toBe(AutoVersionResolver::CREATOR);
});

test('a prior pdf_url_status on a non-oa_url stub skips re-fetching (the vacuum guard)', function () {
    $id = canonvSeedCanonical([
        'title'   => 'CanonV AVC PriorStatus',
        'pdf_url' => 'https://example.org/canonv-avc-prior.pdf',
    ]);
    // Stub from an earlier failed run: pdf_url set, no oa_url, status stamped.
    $stub = canonvSeedLibrary([
        'title'               => 'CanonV AVC Prior Stub',
        'canonical_source_id' => $id,
        'conversion_method'   => AutoVersionResolver::CONVERSION_METHOD,
        'foundation_source'   => AutoVersionResolver::FOUNDATION_SOURCE,
        'creator'             => AutoVersionResolver::CREATOR,
        'has_nodes'           => false,
        'listed'              => false,
    ]);
    canonvDb()->table('library')->where('book', $stub)->update([
        'pdf_url'        => 'https://example.org/canonv-avc-prior.pdf',
        'pdf_url_status' => 'failed_403',
    ]);

    $fetcher = Mockery::mock(ContentFetchService::class);
    $fetcher->shouldNotReceive('fetch'); // the guard: already processed, don't re-hit the publisher

    $result = avcCreator($fetcher)->create(CanonicalSource::findOrFail($id));

    // No PDF ever landed on disk, so the OCR step reports the miss.
    expect($result['status'])->toBe('ocr_failed');
    expect($result['reason'])->toContain('no PDF on disk');
    expect($result['book'])->toBe($stub);
});

test('a fetch that imported directly (JATS/HTML lane) skips OCR and only defers on missing nodes', function () {
    $id = canonvSeedCanonical([
        'title'   => 'CanonV AVC ImportedLane',
        'pdf_url' => 'https://example.org/canonv-avc-imported.pdf',
    ]);

    $fetcher = Mockery::mock(ContentFetchService::class);
    $fetcher->shouldReceive('fetch')->once()->andReturnUsing(function () use ($id) {
        // Simulate the JATS lane: content imported, status stamped, but leave
        // has_nodes false here so the assign stays deferred (no fs fixtures).
        canonvDb()->table('library')->where('canonical_source_id', $id)
            ->update(['pdf_url_status' => 'imported']);
        return ['status' => 'imported', 'reason' => 'JATS full text imported'];
    });
    $fetcher->shouldNotReceive('processLocalPdf'); // imported ⇒ no OCR call

    $result = avcCreator($fetcher)->create(CanonicalSource::findOrFail($id));

    expect($result['status'])->toBe('deferred');
});
