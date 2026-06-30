<?php

/**
 * Deletion hardening: CanonicalVersionSync::clearAndResyncForDeletedBook nulls a
 * canonical pointer that names a deleted book and re-resolves it. Without this the
 * fill-only assign() would leave the pointer dangling at a soft-deleted row.
 */

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\CanonicalVersionSync;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
    $this->sync = new CanonicalVersionSync();
});

function canonvSeedAr5ivRowForDeletion(string $canonicalId, array $opts = []): string
{
    return canonvSeedLibrary(array_merge([
        'title'               => 'CanonV ar5iv (deletion)',
        'canonical_source_id' => $canonicalId,
        'conversion_method'   => AutoVersionResolver::AR5IV_CONVERSION_METHOD,
        'foundation_source'   => AutoVersionResolver::AR5IV_FOUNDATION_SOURCE,
        'creator'             => AutoVersionResolver::CREATOR,
        'has_nodes'           => true,
        'listed'              => false,
    ], $opts));
}

test('clears the pointer when its book is deleted and nothing else is eligible', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Delete Only Version']);
    $book = canonvSeedAr5ivRowForDeletion($id);
    $this->sync->syncForBook($book);
    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($book);

    // Soft-delete the row (what BookDeletionService does), then run the cleanup.
    canonvDb()->table('library')->where('book', $book)->update(['visibility' => 'deleted']);
    $this->sync->clearAndResyncForDeletedBook($book);

    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBeNull();
});

test('re-resolves the pointer to another eligible version when one remains', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Delete Re-resolve']);
    $first  = canonvSeedAr5ivRowForDeletion($id, ['created_at' => now()->subDay()]);
    $second = canonvSeedAr5ivRowForDeletion($id, ['created_at' => now()]);
    $this->sync->syncForBook($first);
    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($first);

    // Delete the pointed-at row; a second eligible system row still exists.
    canonvDb()->table('library')->where('book', $first)->update(['visibility' => 'deleted']);
    $this->sync->clearAndResyncForDeletedBook($first);

    expect(canonvCanonicalValue($id, 'auto_version_book'))->toBe($second);
});
