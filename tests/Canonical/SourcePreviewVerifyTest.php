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
use App\Services\OpenLibraryService;
use App\Services\SemanticScholarService;

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

test('preview surfaces a ranked shortlist for a title-only row (no author needed)', function () {
    // No author on the row — the old gate would skip title search entirely.
    $lib = spvLibrary(['title' => 'CanonV Broad Match Title', 'author' => null]);

    // Score by candidate title so ranking is deterministic; 0.10 is below the 0.15 floor → dropped.
    $scores = [
        'CanonV Strong'  => 0.90,
        'CanonV Medium'  => 0.55,
        'CanonV Weak'    => 0.20,
        'CanonV TooWeak' => 0.10,
    ];
    $this->mock(OpenAlexService::class, function ($m) use ($scores) {
        $m->shouldReceive('extractIsbn')->andReturn(null);
        $m->shouldReceive('fetchFromOpenAlex')->once()->andReturn([
            canonvNormalisedWork(['title' => 'CanonV Strong', 'openalex_id' => 'W_strong', 'doi' => null]),
            canonvNormalisedWork(['title' => 'CanonV TooWeak', 'openalex_id' => 'W_tooweak', 'doi' => null]),
        ]);
        $m->shouldReceive('metadataScore')->andReturnUsing(
            fn ($lib, $cand) => ['score' => $scores[$cand['title']] ?? 0.0],
        );
    });
    $this->mock(OpenLibraryService::class, function ($m) {
        $m->shouldReceive('search')->once()->andReturn([
            canonvNormalisedWork(['title' => 'CanonV Medium', 'open_library_key' => '/works/OLmed', 'openalex_id' => null, 'doi' => null, 'source' => 'openlibrary']),
        ]);
    });
    $this->mock(SemanticScholarService::class, function ($m) {
        $m->shouldReceive('search')->once()->andReturn([
            canonvNormalisedWork(['title' => 'CanonV Weak', 'openalex_id' => null, 'doi' => null, 'source' => 'semanticscholar', 'semantic_scholar_id' => 'S_weak']),
        ]);
    });

    $res = app(CanonicalSourceMatcher::class)->preview($lib);

    expect($res['status'])->toBe('linked_new');
    expect($res['candidate']['title'])->toBe('CanonV Strong');      // top by score
    // Aggregated across all 3 providers, floor drops the 0.10 candidate → 3 remain (candidate + 2).
    expect($res['alternates'])->toHaveCount(2);
    expect($res['alternates'][0]['title'])->toBe('CanonV Medium');  // next by score
    expect($res['alternates'][1]['title'])->toBe('CanonV Weak');
    // Per-candidate confidence is annotated for the UI.
    expect($res['candidate']['match_score'])->toEqual(0.9);
    // A preview writes nothing.
    expect(canonvDb()->table('canonical_source')->whereRaw("title LIKE 'CanonV %'")->exists())->toBeFalse();
});

test('preview folds an ISBN hit (from bibtex) into the shortlist', function () {
    $lib = spvLibrary([
        'title'  => 'CanonV ISBN Book',
        'author' => null,
        'bibtex' => '@book{x, title={CanonV ISBN Book}, isbn={9780306406157}}',
    ]);

    $this->mock(OpenAlexService::class, function ($m) {
        $m->shouldReceive('extractDoi')->andReturn(null);   // wave-3 DOI scan of the bibtex
        $m->shouldReceive('extractIsbn')->andReturn('9780306406157');
        $m->shouldReceive('fetchFromOpenAlex')->andReturn([]);
        $m->shouldReceive('metadataScore')->andReturnUsing(
            fn ($lib, $cand) => ['score' => $cand['open_library_key'] === '/works/OLisbn' ? 0.95 : 0.2],
        );
    });
    $this->mock(OpenLibraryService::class, function ($m) {
        // The ISBN wave hits searchByIsbn; the title wave hits search (empty here).
        $m->shouldReceive('searchByIsbn')->with('9780306406157', 5)->once()->andReturn([
            canonvNormalisedWork(['title' => 'CanonV ISBN Edition', 'open_library_key' => '/works/OLisbn', 'openalex_id' => null, 'doi' => null, 'source' => 'openlibrary']),
        ]);
        $m->shouldReceive('search')->andReturn([]);
    });
    $this->mock(SemanticScholarService::class, function ($m) {
        $m->shouldReceive('search')->andReturn([]);
    });

    $res = app(CanonicalSourceMatcher::class)->preview($lib);

    expect($res['status'])->toBe('linked_new');
    expect($res['candidate']['open_library_key'])->toBe('/works/OLisbn');
});

test('preview gate: a junk/empty title returns no_match without any API call', function () {
    $lib = spvLibrary(['title' => 'a', 'author' => null]);  // below the 5-char floor

    // Fully mocked with NO provider expectations — a call would fail the strict mock.
    $this->mock(OpenAlexService::class, function ($m) {
        $m->shouldReceive('extractIsbn')->andReturn(null);  // resolveIsbn tolerated, nothing else
    });
    $this->mock(OpenLibraryService::class);
    $this->mock(SemanticScholarService::class);

    $res = app(CanonicalSourceMatcher::class)->preview($lib);

    expect($res['status'])->toBe('no_match');
    expect($res['candidate'])->toBeNull();
});

test('verifyAndLink labels an Open Library work open_library_ingest (source="openlibrary")', function () {
    $lib = spvLibrary();

    $this->mock(OpenAlexService::class, function ($m) {
        $m->shouldReceive('metadataScore')->andReturn(['score' => 0.9]);
    });

    // Open Library candidates carry source='openlibrary' (no underscore) — must not fall through
    // to the openalex_ingest default, which would mis-attribute the provider in the UI.
    $normalised = canonvNormalisedWork([
        'title'            => 'CanonV OL Verified',
        'source'           => 'openlibrary',
        'open_library_key' => '/works/OLcanonv',
        'openalex_id'      => null,
        'doi'              => null,
    ]);

    $canonical = app(CanonicalSourceMatcher::class)->verifyAndLink($lib, $normalised, 'tester');

    expect(canonvCanonicalValue($canonical->id, 'foundation_source'))->toBe('open_library_ingest');
    // And the row keeps the OL key so the client can build the "view on Open Library" link.
    $row = canonvDb()->table('library')->where('book', $lib->book)->first();
    expect($row->open_library_key)->toBe('/works/OLcanonv');
});

test('stampUserRejected marks the row reviewed without linking', function () {
    $lib = spvLibrary();

    app(CanonicalSourceMatcher::class)->stampUserRejected($lib, 'tester');

    $row = canonvDb()->table('library')->where('book', $lib->book)->first();
    expect($row->canonical_match_method)->toBe('user_rejected');
    expect($row->canonical_source_id)->toBeNull();
    expect($row->human_reviewed_at)->not->toBeNull();
});
