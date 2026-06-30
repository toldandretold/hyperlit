<?php

/**
 * library:create-ar5iv-versions — no-network paths. The ar5iv fetch is mocked;
 * the conversion job is faked. Covers eligibility (arXiv DOI only), idempotent
 * wiring from an existing ar5iv row, dry-run, and the fresh-mint dispatch.
 */

use App\Jobs\ProcessDocumentImportJob;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\SourceImport\Content\Ar5ivFetcher;
use App\Services\SourceImport\Content\FetchResult;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\File;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

test('dry-run writes nothing', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV ar5iv DryRun', 'doi' => '10.48550/arxiv.2501.00001']);

    $this->artisan('library:create-ar5iv-versions', [
        '--canonical' => $id,
        '--dry-run'   => true,
        '--sleep'     => 0,
    ])->assertExitCode(0);

    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBeNull();
    expect(canonvDb()->table('library')->where('canonical_source_id', $id)->count())->toBe(0);
});

test('a non-arXiv canonical is not eligible', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Not arXiv', 'doi' => '10.1234/not-arxiv']);

    $this->artisan('library:create-ar5iv-versions', ['--canonical' => $id, '--sleep' => 0])
        ->assertExitCode(0);

    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBeNull();
});

test('wires the pointer from an existing ar5iv row without fetching', function () {
    Bus::fake();
    $id = canonvSeedCanonical(['title' => 'CanonV ar5iv Existing', 'doi' => '10.48550/arxiv.2501.00002']);
    $row = canonvSeedLibrary([
        'title'               => 'CanonV ar5iv Prior',
        'canonical_source_id' => $id,
        'conversion_method'   => AutoVersionResolver::AR5IV_CONVERSION_METHOD,
        'foundation_source'   => AutoVersionResolver::AR5IV_FOUNDATION_SOURCE,
        'creator'             => AutoVersionResolver::CREATOR,
        'has_nodes'           => true,
        'listed'              => false,
    ]);

    $this->artisan('library:create-ar5iv-versions', ['--canonical' => $id, '--sleep' => 0])
        ->assertExitCode(0);

    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($row);
    Bus::assertNotDispatched(ProcessDocumentImportJob::class);
});

test('a canonical whose pointer is already set is skipped', function () {
    $existing = canonvSeedLibrary(['title' => 'CanonV ar5iv Pointed']);
    $id = canonvSeedCanonical([
        'title'             => 'CanonV ar5iv Done',
        'doi'               => '10.48550/arxiv.2501.00003',
        'auto_version_book' => $existing,
    ]);

    $this->artisan('library:create-ar5iv-versions', ['--canonical' => $id, '--sleep' => 0])
        ->assertExitCode(0);

    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($existing);
});

test('fresh arXiv canonical mints a system ar5iv row and dispatches conversion', function () {
    Bus::fake();
    // Mock the network fetch — assert it's asked for the right arXiv id.
    $this->mock(Ar5ivFetcher::class, function ($m) {
        $m->shouldReceive('fetch')
            ->once()
            ->andReturnUsing(function ($id) {
                expect($id->value())->toBe('2501.00004');
                return FetchResult::success('/tmp/ignored.html', 'html');
            });
    });

    $id = canonvSeedCanonical(['title' => 'CanonV ar5iv Fresh', 'doi' => '10.48550/arXiv.2501.00004']);

    $this->artisan('library:create-ar5iv-versions', ['--canonical' => $id, '--sleep' => 0])
        ->assertExitCode(0);

    $minted = canonvDb()->table('library')
        ->where('canonical_source_id', $id)
        ->where('conversion_method', AutoVersionResolver::AR5IV_CONVERSION_METHOD)
        ->first();
    expect($minted)->not->toBeNull();
    expect($minted->creator)->toBe(AutoVersionResolver::CREATOR);
    expect($minted->foundation_source)->toBe(AutoVersionResolver::AR5IV_FOUNDATION_SOURCE);

    Bus::assertDispatched(ProcessDocumentImportJob::class);

    // The command creates the system book's dir before fetching — clean it up.
    File::deleteDirectory(resource_path("markdown/{$minted->book}"));
});
