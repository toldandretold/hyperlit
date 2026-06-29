<?php

/**
 * CanonicalSourceMatcher::preview() + verifyAndLink() — the read-only candidate preview and the
 * user-confirmed apply that power the [check source] flow. preview must surface the candidate's
 * citation WITHOUT writing; verifyAndLink must link the canonical, OVERWRITE the library row's
 * identity fields, and stamp the verified state. External API services are mocked.
 */

use App\Models\PgLibrary;
use App\Services\CanonicalSourceMatcher;
use App\Services\OpenAlexService;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

function spvLibrary(array $update = []): PgLibrary
{
    $book = canonvSeedLibrary(['title' => 'CanonV Old Title', 'author' => 'Old, Author']);
    if ($update) {
        canonvDb()->table('library')->where('book', $book)->update($update);
    }
    return PgLibrary::on('pgsql_admin')->where('book', $book)->firstOrFail();
}

test('preview returns the DOI candidate and writes nothing', function () {
    $lib = spvLibrary(['doi' => '10.1/spv']);

    $this->mock(OpenAlexService::class, function ($m) {
        $m->shouldReceive('fetchByDoi')->once()->andReturn(
            canonvNormalisedWork(['title' => 'CanonV Real Work', 'doi' => '10.1/spv'])
        );
    });

    $res = app(CanonicalSourceMatcher::class)->preview($lib);

    expect($res['status'])->toBe('linked_new');
    expect($res['method'])->toBe('openalex_doi');
    expect($res['candidate']['title'])->toBe('CanonV Real Work');
    expect($res['alreadyLinked'])->toBeFalse();
    // No canonical row was created by a preview.
    expect(canonvDb()->table('canonical_source')->where('doi', '10.1/spv')->exists())->toBeFalse();
});

test('preview extracts a DOI from the url when the doi column is empty', function () {
    // doi column null, but the DOI lives in the url (a very common upload shape).
    $lib = spvLibrary(['url' => 'https://doi.org/10.1080/13563467.2020.1841143']);

    $this->mock(OpenAlexService::class, function ($m) {
        $m->shouldReceive('extractDoi')->andReturnUsing(
            fn ($text) => preg_match('#(10\.\d{4,9}/[^\s]+)#', (string) $text, $mm) ? $mm[1] : null,
        );
        $m->shouldReceive('fetchByDoi')->with('10.1080/13563467.2020.1841143')->once()
            ->andReturn(canonvNormalisedWork(['title' => 'CanonV Real Title', 'doi' => '10.1080/13563467.2020.1841143']));
    });

    $res = app(CanonicalSourceMatcher::class)->preview($lib);

    expect($res['status'])->toBe('linked_new');
    expect($res['method'])->toBe('openalex_doi');
    expect($res['candidate']['title'])->toBe('CanonV Real Title');
});

test('preview reports an already-linked book as such', function () {
    $canonicalId = canonvSeedCanonical(['title' => 'CanonV Linked', 'doi' => '10.1/linked']);
    $lib = spvLibrary([
        'canonical_source_id'    => $canonicalId,
        'canonical_match_method' => 'openalex_doi',
        'canonical_match_score'  => 1.0,
    ]);

    // No API mock needed — already-linked short-circuits before any external call.
    $this->mock(OpenAlexService::class);

    $res = app(CanonicalSourceMatcher::class)->preview($lib);

    expect($res['status'])->toBe('already_linked');
    expect($res['alreadyLinked'])->toBeTrue();
    expect($res['current']['title'])->toBe('CanonV Linked');
});

test('verifyAndLink links the canonical, overwrites identity fields, and stamps user_verified', function () {
    $lib = spvLibrary();

    $this->mock(OpenAlexService::class, function ($m) {
        $m->shouldReceive('metadataScore')->andReturn(['score' => 0.9]);
    });

    $normalised = canonvNormalisedWork([
        'title'       => 'CanonV Verified Title',
        'author'      => 'Verified, Author',
        'openalex_id' => 'W_canonv_test_1',
        'doi'         => '10.9999/canonv-test-doi',
    ]);

    $canonical = app(CanonicalSourceMatcher::class)->verifyAndLink($lib, $normalised, 'tester');

    // Canonical created (read via the DEFAULT connection — Eloquent writes inside the txn).
    expect(canonvCanonicalValue($canonical->id, 'title'))->toBe('CanonV Verified Title');

    // Library row updated via pgsql_admin: linked + verified + identity overwritten.
    $row = canonvDb()->table('library')->where('book', $lib->book)->first();
    expect($row->canonical_source_id)->toBe($canonical->id);
    expect($row->canonical_match_method)->toBe('user_verified');
    expect($row->canonical_match_score)->toEqual(1.0);
    expect($row->human_reviewed_at)->not->toBeNull();
    expect($row->title)->toBe('CanonV Verified Title');   // overwritten from canonical
    expect($row->openalex_id)->toBe('W_canonv_test_1');
});

test('stampUserRejected marks the row reviewed without linking', function () {
    $lib = spvLibrary();

    app(CanonicalSourceMatcher::class)->stampUserRejected($lib, 'tester');

    $row = canonvDb()->table('library')->where('book', $lib->book)->first();
    expect($row->canonical_match_method)->toBe('user_rejected');
    expect($row->canonical_source_id)->toBeNull();
    expect($row->human_reviewed_at)->not->toBeNull();
});
