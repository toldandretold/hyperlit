<?php

/**
 * library:create-auto-versions — only the no-network paths are exercised here
 * (dry-run; pointer wiring when an OCR'd stub already exists; eligibility
 * filters). The vacuum/OCR fetch paths hit external services and are covered
 * by ops usage, not unit tests.
 */

use App\Services\CanonicalVersions\AutoVersionResolver;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

test('dry-run writes nothing', function () {
    $id = canonvSeedCanonical([
        'title'   => 'CanonV DryRun',
        'pdf_url' => 'https://example.org/canonv-dryrun.pdf',
    ]);

    $this->artisan('library:create-auto-versions', [
        '--canonical' => $id,
        '--dry-run'   => true,
        '--sleep'     => 0,
    ])->assertExitCode(0);

    expect(canonvCanonicalValue($id, 'auto_version_book'))
        ->toBeNull();
    expect(canonvDb()->table('library')->where('canonical_source_id', $id)->count())->toBe(0);
});

test('wires the pointer from an existing OCR-completed stub without fetching', function () {
    $id = canonvSeedCanonical([
        'title'   => 'CanonV Existing Stub',
        'pdf_url' => 'https://example.org/canonv-existing.pdf',
    ]);
    $stub = canonvSeedLibrary([
        'title'               => 'CanonV Prior OCR Stub',
        'canonical_source_id' => $id,
        'conversion_method'   => AutoVersionResolver::CONVERSION_METHOD,
        'foundation_source'   => AutoVersionResolver::FOUNDATION_SOURCE,
        'creator'             => AutoVersionResolver::CREATOR,
        'has_nodes'           => true,
        'listed'              => false,
    ]);

    $this->artisan('library:create-auto-versions', [
        '--canonical' => $id,
        '--sleep'     => 0,
    ])->assertExitCode(0);

    expect(canonvCanonicalValue($id, 'auto_version_book'))
        ->toBe($stub);
});

test('a canonical whose pointer is already set is not eligible', function () {
    $existing = canonvSeedLibrary(['title' => 'CanonV Already Pointed']);
    $id = canonvSeedCanonical([
        'title'             => 'CanonV Already Done',
        'pdf_url'           => 'https://example.org/canonv-done.pdf',
        'auto_version_book' => $existing,
    ]);

    $this->artisan('library:create-auto-versions', [
        '--canonical' => $id,
        '--sleep'     => 0,
    ])->assertExitCode(0);

    expect(canonvCanonicalValue($id, 'auto_version_book'))
        ->toBe($existing);
});

test('a canonical without a pdf_url is not eligible', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV No Pdf']);

    $this->artisan('library:create-auto-versions', [
        '--canonical' => $id,
        '--sleep'     => 0,
    ])->assertExitCode(0);

    expect(canonvCanonicalValue($id, 'auto_version_book'))
        ->toBeNull();
});
