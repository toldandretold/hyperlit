<?php

/**
 * arXiv ar5iv auto-versions — the two-row model + stable-pointer policy.
 *
 * Per work: a user's editable import (conversion_method NULL → ineligible) and a
 * system-owned ar5iv row (creator=canonicalizer_v1, conversion_method=ar5iv_html)
 * that becomes auto_version_book. The pointer is stable: a later import never flips
 * it; it's refreshed only by reconverting the same row in place.
 */

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\CanonicalVersionSync;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
    $this->sync = new CanonicalVersionSync();
});

function canonvSeedAr5ivSystemRow(string $canonicalId, array $opts = []): string
{
    return canonvSeedLibrary(array_merge([
        'title'               => 'CanonV ar5iv System Version',
        'canonical_source_id' => $canonicalId,
        'conversion_method'   => AutoVersionResolver::AR5IV_CONVERSION_METHOD,
        'foundation_source'   => AutoVersionResolver::AR5IV_FOUNDATION_SOURCE,
        'creator'             => AutoVersionResolver::CREATOR,
        'has_nodes'           => true,
        'listed'              => false,
    ], $opts));
}

test('syncForBook wires auto_version_book to the system ar5iv row, not the user import', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV ar5iv Two Row']);
    // The user's editable import — older, but ineligible (NULL conversion_method).
    canonvSeedLibrary([
        'title'               => 'CanonV User Import',
        'canonical_source_id' => $id,
        'conversion_method'   => null,
        'has_nodes'           => true,
        'created_at'          => now()->subDay(),
    ]);
    $system = canonvSeedAr5ivSystemRow($id);

    $assigned = $this->sync->syncForBook($system);

    expect($assigned)->toBe(['auto_version_book' => $system]);
    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($system);
});

test('a second import of the same work does NOT flip the pointer', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV ar5iv Stable']);
    $first = canonvSeedAr5ivSystemRow($id, ['created_at' => now()->subDay()]);
    $this->sync->syncForBook($first);
    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($first);

    // A later system ar5iv row appears (e.g. another path minted one). Fill-only
    // assign must leave the established pointer untouched.
    $second = canonvSeedAr5ivSystemRow($id, ['created_at' => now()]);
    $this->sync->syncForBook($second);

    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($first);
});

test('reconvert-in-place keeps the pointer on the same book id', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV ar5iv Reconvert']);
    $system = canonvSeedAr5ivSystemRow($id);
    $this->sync->syncForBook($system);
    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($system);

    // Reconvert rewrites nodes in place — same book id, still has_nodes, still
    // ar5iv_html. Re-running the finalize sync re-affirms the same pointer.
    $this->sync->syncForBook($system);

    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($system);
});
