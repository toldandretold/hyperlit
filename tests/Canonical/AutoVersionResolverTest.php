<?php

/**
 * AutoVersionResolver — the one ACTIVE authority. Eligibility contract:
 * canonical-linked + conversion_method=pdf_ocr_auto_raw + has_nodes=true
 * (+ not deleted). assign() persistence semantics: set-once, force to retarget.
 * syncAll() runs every authority but only auto can currently assign.
 */

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\VersionPointerRegistry;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
    $this->resolver = new AutoVersionResolver();
});

function canonvSeedAutoStub(string $canonicalId, array $opts = []): string
{
    return canonvSeedLibrary(array_merge([
        'title'               => 'CanonV Auto Stub',
        'canonical_source_id' => $canonicalId,
        'conversion_method'   => AutoVersionResolver::CONVERSION_METHOD,
        'foundation_source'   => AutoVersionResolver::FOUNDATION_SOURCE,
        'creator'             => AutoVersionResolver::CREATOR,
        'has_nodes'           => true,
        'listed'              => false,
    ], $opts));
}

test('resolves an OCR-completed auto stub linked to the canonical', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Resolve Target']);
    $stub = canonvSeedAutoStub($id);

    $canonical = CanonicalSource::find($id);
    expect($this->resolver->resolve($canonical))->toBe($stub);
});

test('ignores stubs that have no OCR content yet (has_nodes=false)', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV No Nodes']);
    canonvSeedAutoStub($id, ['has_nodes' => false]);

    expect($this->resolver->resolve(CanonicalSource::find($id)))->toBeNull();
});

test('ignores linked versions that are not auto-raw conversions', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV User Upload Only']);
    canonvSeedLibrary([
        'title'               => 'CanonV Human EPUB Upload',
        'canonical_source_id' => $id,
        'conversion_method'   => 'epub_import',
        'has_nodes'           => true,
    ]);

    expect($this->resolver->resolve(CanonicalSource::find($id)))->toBeNull();
});

test('a JATS full-text version also qualifies as a system auto-version', function () {
    // jats_fulltext is system-fetched authoritative content — a genuine
    // auto-version alongside pdf_ocr_auto_raw (AutoVersionResolver::SYSTEM_CONVERSION_METHODS).
    $id = canonvSeedCanonical(['title' => 'CanonV JATS Version']);
    $jats = canonvSeedLibrary([
        'title'               => 'CanonV JATS Full Text',
        'canonical_source_id' => $id,
        'conversion_method'   => 'jats_fulltext',
        'has_nodes'           => true,
        'listed'              => false,
    ]);

    expect($this->resolver->resolve(CanonicalSource::find($id)))->toBe($jats);
});

test('ignores deleted auto stubs', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Deleted Stub']);
    canonvSeedAutoStub($id, ['visibility' => 'deleted']);

    expect($this->resolver->resolve(CanonicalSource::find($id)))->toBeNull();
});

test('prefers the earliest auto stub when several exist', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Two Stubs']);
    $younger = canonvSeedAutoStub($id, ['created_at' => now()]);
    $older   = canonvSeedAutoStub($id, ['created_at' => now()->subDay()]);

    expect($this->resolver->resolve(CanonicalSource::find($id)))->toBe($older);
});

test('assign persists the pointer', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Assign']);
    $stub = canonvSeedAutoStub($id);

    $assigned = $this->resolver->assign(CanonicalSource::find($id));

    expect($assigned)->toBe($stub);
    expect(canonvCanonicalValue($id, 'auto_version_book'))
        ->toBe($stub);
});

test('assign never overwrites an existing pointer without force', function () {
    $manual = canonvSeedLibrary(['title' => 'CanonV Manually Chosen']);
    $id = canonvSeedCanonical([
        'title'             => 'CanonV Manual Pointer',
        'auto_version_book' => $manual,
    ]);
    $newerStub = canonvSeedAutoStub($id);

    expect($this->resolver->assign(CanonicalSource::find($id)))->toBe($manual);
    expect(canonvCanonicalValue($id, 'auto_version_book'))
        ->toBe($manual);

    // force=true re-runs eligibility and retargets.
    expect($this->resolver->assign(CanonicalSource::find($id), force: true))->toBe($newerStub);
});

test('assign returns null and writes nothing when no eligible version exists', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Nothing Eligible']);

    expect($this->resolver->assign(CanonicalSource::find($id)))->toBeNull();
    expect(canonvCanonicalValue($id, 'auto_version_book'))
        ->toBeNull();
});

test('syncAll assigns the auto pointer and leaves dormant-authority pointers null', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV SyncAll']);
    $stub = canonvSeedAutoStub($id);

    $assigned = VersionPointerRegistry::syncAll(CanonicalSource::find($id));

    expect($assigned)->toBe(['auto_version_book' => $stub]);

    $row = DB::table('canonical_source')->where('id', $id)->first();
    expect($row->auto_version_book)->toBe($stub);
    expect($row->author_version_book)->toBeNull();
    expect($row->publisher_version_book)->toBeNull();
    expect($row->commons_version_book)->toBeNull();
});
