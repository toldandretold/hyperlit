<?php

/**
 * Phase 3: CitationReviewService::enrichCitationMetadata resolves each
 * citation through the canonical layer — provenance tiers (canonical / local /
 * unverified), identity signals, and content upgraded to the canonical's best
 * genuine version (the auto version) for passage search.
 */

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CitationReviewService;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

function canonvEnrich(string $book, array $refIds): array
{
    $svc = app(CitationReviewService::class);
    $ref = new ReflectionMethod($svc, 'enrichCitationMetadata');
    $ref->setAccessible(true);

    $citationNodes = [['reference_ids' => $refIds]];
    return $ref->invoke($svc, $citationNodes, $book);
}

function canonvSeedReviewBib(string $book, string $refId, array $opts = []): void
{
    canonvDb()->table('bibliography')->insert(array_merge([
        'book'        => $book,
        'referenceId' => $refId,
        'content'     => '<p>CanonV review bib entry</p>',
        'created_at'  => now(),
        'updated_at'  => now(),
    ], $opts));
}

test('canonical-linked citation gets canonical tier, signals, and auto-version content', function () {
    $canonicalId = canonvSeedCanonical([
        'title'       => 'CanonV Review Work',
        'openalex_id' => 'W_canonv_review_1',
        'doi'         => '10.9999/canonv-review',
    ]);
    $autoVersion = canonvSeedLibrary([
        'title'               => 'CanonV Review Auto Version',
        'canonical_source_id' => $canonicalId,
        'conversion_method'   => AutoVersionResolver::CONVERSION_METHOD,
        'has_nodes'           => true,
        'listed'              => false,
    ]);
    canonvDb()->table('canonical_source')->where('id', $canonicalId)
        ->update(['auto_version_book' => $autoVersion]);

    // Foundation stub: the scan's original match, metadata-only (no content)
    $foundation = canonvSeedLibrary([
        'title'               => 'CanonV Review Foundation Stub',
        'canonical_source_id' => $canonicalId,
        'has_nodes'           => false,
    ]);

    $book = canonvSeedLibrary(['title' => 'CanonV Review Citing Book']);
    canonvSeedReviewBib($book, 'ref1', [
        'foundation_source'   => $foundation,
        'canonical_source_id' => $canonicalId,
    ]);

    $meta = canonvEnrich($book, ['ref1'])['ref1'];

    expect($meta['verification_tier'])->toBe('canonical');
    expect($meta['verified'])->toBeTrue();
    expect($meta['canonical_source_id'])->toBe($canonicalId);
    expect($meta['canonical_signals'])->toContain('openalex');
    expect($meta['canonical_signals'])->toContain('doi');
    // Content upgraded from the contentless foundation stub to the auto version
    expect($meta['source_book_id'])->toBe($autoVersion);
    expect($meta['has_source_content'])->toBeTrue();
    expect($meta['content_provenance'])->toBe('auto_version');
});

test('canonical is reachable via the foundation row when bibliography has no link (footnote path)', function () {
    $canonicalId = canonvSeedCanonical([
        'title'       => 'CanonV Review Via Foundation',
        'openalex_id' => 'W_canonv_review_2',
    ]);
    $foundation = canonvSeedLibrary([
        'title'               => 'CanonV Review Foundation With Link',
        'canonical_source_id' => $canonicalId,
        'has_nodes'           => true,
    ]);
    $book = canonvSeedLibrary(['title' => 'CanonV Review Citing Book 2']);
    canonvSeedReviewBib($book, 'ref1', ['foundation_source' => $foundation]); // no canonical on bib

    $meta = canonvEnrich($book, ['ref1'])['ref1'];

    expect($meta['verification_tier'])->toBe('canonical');
    expect($meta['canonical_source_id'])->toBe($canonicalId);
    // No privileged pointer set — content comes from the linked version itself
    expect($meta['source_book_id'])->toBe($foundation);
    expect($meta['content_provenance'])->toBe('linked_version');
});

test('foundation match without canonical is local tier with foundation content', function () {
    $foundation = canonvSeedLibrary([
        'title'     => 'CanonV Review Local Only',
        'has_nodes' => true,
    ]);
    $book = canonvSeedLibrary(['title' => 'CanonV Review Citing Book 3']);
    canonvSeedReviewBib($book, 'ref1', ['foundation_source' => $foundation]);

    $meta = canonvEnrich($book, ['ref1'])['ref1'];

    expect($meta['verification_tier'])->toBe('local');
    expect($meta['verified'])->toBeTrue();
    expect($meta['canonical_source_id'])->toBeNull();
    expect($meta['source_book_id'])->toBe($foundation);
    expect($meta['content_provenance'])->toBe('foundation');
});

test('unresolved citation stays unverified', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Review Citing Book 4']);
    canonvSeedReviewBib($book, 'ref1', ['foundation_source' => 'unknown']);

    $meta = canonvEnrich($book, ['ref1'])['ref1'];

    expect($meta['verification_tier'])->toBe('unverified');
    expect($meta['verified'])->toBeFalse();
    expect($meta['source_book_id'])->toBeNull();
});

test('canonical without any foundation row is still verified, with canonical metadata', function () {
    $canonicalId = canonvSeedCanonical([
        'title'    => 'CanonV Review Headless Canonical',
        'author'   => 'Headless, Author',
        'year'     => 1999,
        'doi'      => '10.9999/canonv-headless',
        'abstract' => 'A canonical with no library copy.',
    ]);
    $book = canonvSeedLibrary(['title' => 'CanonV Review Citing Book 5']);
    canonvSeedReviewBib($book, 'ref1', [
        'foundation_source'   => null,
        'canonical_source_id' => $canonicalId,
    ]);

    $meta = canonvEnrich($book, ['ref1'])['ref1'];

    expect($meta['verification_tier'])->toBe('canonical');
    expect($meta['verified'])->toBeTrue();
    expect($meta['title'])->toBe('CanonV Review Headless Canonical');
    expect($meta['author'])->toBe('Headless, Author');
    expect($meta['doi'])->toBe('10.9999/canonv-headless');
    expect($meta['has_source_content'])->toBeFalse();
});
