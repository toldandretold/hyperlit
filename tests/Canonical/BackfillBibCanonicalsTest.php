<?php

/**
 * Phase 2: library:backfill-bib-canonicals — bibliography entries resolved
 * before scan-time canonical linking inherit canonical_source_id from their
 * foundation_source library row. Idempotent, dry-run read-only.
 */

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

function canonvSeedBibForBackfill(string $book, string $refId, ?string $foundation): void
{
    canonvDb()->table('bibliography')->insert([
        'book'              => $book,
        'referenceId'       => $refId,
        'content'           => '<p>CanonV backfill entry</p>',
        'foundation_source' => $foundation,
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);
}

test('copies the canonical link from the foundation library row', function () {
    $canonicalId = canonvSeedCanonical(['title' => 'CanonV Backfill Work']);
    $foundation = canonvSeedLibrary([
        'title'               => 'CanonV Backfill Foundation',
        'canonical_source_id' => $canonicalId,
    ]);
    $book = canonvSeedLibrary(['title' => 'CanonV Backfill Citing Book']);
    canonvSeedBibForBackfill($book, 'ref1', $foundation);
    canonvSeedBibForBackfill($book, 'ref_unknown', 'unknown');       // never matches a book
    canonvSeedBibForBackfill($book, 'ref_unresolved', null);         // never scanned

    $this->artisan('library:backfill-bib-canonicals', ['--book' => $book])
        ->assertExitCode(0);

    $rows = canonvDb()->table('bibliography')->where('book', $book)->pluck('canonical_source_id', 'referenceId');
    expect($rows['ref1'])->toBe($canonicalId);
    expect($rows['ref_unknown'])->toBeNull();
    expect($rows['ref_unresolved'])->toBeNull();
});

test('dry-run writes nothing and a second run is a no-op', function () {
    $canonicalId = canonvSeedCanonical(['title' => 'CanonV Backfill Idem']);
    $foundation = canonvSeedLibrary([
        'title'               => 'CanonV Backfill Idem Foundation',
        'canonical_source_id' => $canonicalId,
    ]);
    $book = canonvSeedLibrary(['title' => 'CanonV Backfill Idem Citing']);
    canonvSeedBibForBackfill($book, 'ref1', $foundation);

    $this->artisan('library:backfill-bib-canonicals', ['--book' => $book, '--dry-run' => true])
        ->assertExitCode(0);
    expect(canonvDb()->table('bibliography')->where('book', $book)->value('canonical_source_id'))->toBeNull();

    $this->artisan('library:backfill-bib-canonicals', ['--book' => $book])->assertExitCode(0);
    $first = canonvDb()->table('bibliography')->where('book', $book)->value('canonical_source_id');
    expect($first)->toBe($canonicalId);

    // Re-run: still linked, nothing eligible, no error
    $this->artisan('library:backfill-bib-canonicals', ['--book' => $book])->assertExitCode(0);
    expect(canonvDb()->table('bibliography')->where('book', $book)->value('canonical_source_id'))->toBe($canonicalId);
});

test('does not overwrite an existing canonical link', function () {
    $rightId = canonvSeedCanonical(['title' => 'CanonV Backfill Right']);
    $wrongId = canonvSeedCanonical(['title' => 'CanonV Backfill Other']);
    $foundation = canonvSeedLibrary([
        'title'               => 'CanonV Backfill Overwrite Foundation',
        'canonical_source_id' => $wrongId,
    ]);
    $book = canonvSeedLibrary(['title' => 'CanonV Backfill Overwrite Citing']);
    canonvDb()->table('bibliography')->insert([
        'book'                => $book,
        'referenceId'         => 'ref1',
        'content'             => '<p>already linked</p>',
        'foundation_source'   => $foundation,
        'canonical_source_id' => $rightId,
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);

    $this->artisan('library:backfill-bib-canonicals', ['--book' => $book])->assertExitCode(0);

    expect(canonvDb()->table('bibliography')->where('book', $book)->value('canonical_source_id'))->toBe($rightId);
});
