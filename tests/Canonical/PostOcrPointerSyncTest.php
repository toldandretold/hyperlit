<?php

/**
 * Phase 2: ContentFetchService::syncCanonicalVersionPointers — the post-OCR
 * hook that turns "the pipeline OCR'd a canonical-linked stub" into "the
 * canonical has a genuine auto version" via VersionPointerRegistry::syncAll.
 */

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\ContentFetchService;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

function canonvSyncPointers(string $bookId): void
{
    $svc = app(ContentFetchService::class);
    $ref = new ReflectionMethod($svc, 'syncCanonicalVersionPointers');
    $ref->setAccessible(true);
    $ref->invoke($svc, $bookId);
}

test('OCR completion on a canonical-linked stub wires auto_version_book', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV PostOcr']);
    $stub = canonvSeedLibrary([
        'title'               => 'CanonV PostOcr Stub',
        'canonical_source_id' => $id,
        'conversion_method'   => AutoVersionResolver::CONVERSION_METHOD,
        'has_nodes'           => true,
        'listed'              => false,
    ]);

    canonvSyncPointers($stub);

    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($stub);
});

test('a book without a canonical link is a no-op', function () {
    $orphan = canonvSeedLibrary([
        'title'             => 'CanonV PostOcr Orphan',
        'conversion_method' => AutoVersionResolver::CONVERSION_METHOD,
        'has_nodes'         => true,
    ]);

    canonvSyncPointers($orphan); // must not throw
    expect(true)->toBeTrue();
});

test('an existing auto pointer is never overwritten by the sync', function () {
    $original = canonvSeedLibrary(['title' => 'CanonV PostOcr Original']);
    $id = canonvSeedCanonical([
        'title'             => 'CanonV PostOcr Manual',
        'auto_version_book' => $original,
    ]);
    $newer = canonvSeedLibrary([
        'title'               => 'CanonV PostOcr Newer Stub',
        'canonical_source_id' => $id,
        'conversion_method'   => AutoVersionResolver::CONVERSION_METHOD,
        'has_nodes'           => true,
    ]);

    canonvSyncPointers($newer);

    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($original);
});
