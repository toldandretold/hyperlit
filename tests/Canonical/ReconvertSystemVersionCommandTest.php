<?php

/**
 * library:reconvert-system-version — refreshes a SYSTEM auto-version in place.
 * Guards that it only touches canonicalizer_v1 rows; dispatches the conversion
 * job for a valid system row (reusing on-disk original.html, no --refetch).
 */

use App\Jobs\ProcessDocumentImportJob;
use App\Services\CanonicalVersions\AutoVersionResolver;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\File;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

test('dispatches an in-place reconvert for a system ar5iv row', function () {
    Bus::fake();
    $id = canonvSeedCanonical(['title' => 'CanonV Reconvert Sys', 'doi' => '10.48550/arxiv.2502.00001']);
    $book = canonvSeedLibrary([
        'title'               => 'CanonV ar5iv System',
        'canonical_source_id' => $id,
        'conversion_method'   => AutoVersionResolver::AR5IV_CONVERSION_METHOD,
        'foundation_source'   => AutoVersionResolver::AR5IV_FOUNDATION_SOURCE,
        'creator'             => AutoVersionResolver::CREATOR,
        'has_nodes'           => true,
        'listed'              => false,
    ]);

    // Reuse-on-disk path needs original.html present.
    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/original.html", '<html><body><p>x</p></body></html>');

    try {
        $this->artisan('library:reconvert-system-version', ['--book' => $book])
            ->assertExitCode(0);
        Bus::assertDispatched(ProcessDocumentImportJob::class);
    } finally {
        File::deleteDirectory($dir);
    }
});

test('refuses to touch a user-owned row', function () {
    Bus::fake();
    $user = canonvSeedUser('owner');
    $book = canonvSeedLibrary([
        'title'             => 'CanonV User Book',
        'creator'           => $user->name,
        'conversion_method' => 'epub_import',
        'has_nodes'         => true,
    ]);

    $this->artisan('library:reconvert-system-version', ['--book' => $book])
        ->assertExitCode(1);

    Bus::assertNotDispatched(ProcessDocumentImportJob::class);
});
