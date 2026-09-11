<?php

/**
 * library:backfill-authors — re-derives full "; "-joined author strings from
 * canonical_source.authorships onto the canonical AND its linked library rows,
 * repairing the old harvest normalisers' silent first-3-authors truncation.
 * Hand-edited library authors are never clobbered without --force; bibtex
 * author fields are patched only through the brace-safe path; dry-run is
 * read-only.
 */

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

function canonvAuthorships(array $names): string
{
    return json_encode(array_map(fn ($name) => [
        'name'               => $name,
        'openalex_author_id' => null,
        'orcid'              => null,
        'position'           => 'middle',
        'is_corresponding'   => false,
    ], $names));
}

const CANONV_FIVE = ['One Author', 'Two Author', 'Three Author', 'Four Author', 'Five Author'];
const CANONV_TRUNCATED = 'One Author; Two Author; Three Author';
const CANONV_FULL = 'One Author; Two Author; Three Author; Four Author; Five Author';

test('re-derives the canonical author and repairs machine-truncated library rows', function () {
    $canonicalId = canonvSeedCanonical([
        'title'       => 'CanonV Backfill Authors Work',
        'author'      => CANONV_TRUNCATED,
        'authorships' => canonvAuthorships(CANONV_FIVE),
    ]);

    $truncatedBook = canonvSeedLibrary([
        'title'               => 'CanonV Truncated Version',
        'author'              => CANONV_TRUNCATED,
        'canonical_source_id' => $canonicalId,
    ]);
    canonvDb()->table('library')->where('book', $truncatedBook)->update([
        'bibtex' => '@article{x, author = {One Author and Two Author and Three Author}, title = {T}, year = {2020}}',
    ]);

    $handEditedBook = canonvSeedLibrary([
        'title'               => 'CanonV Hand-Edited Version',
        'author'              => 'My Preferred Byline',
        'canonical_source_id' => $canonicalId,
    ]);

    $bracedBook = canonvSeedLibrary([
        'title'               => 'CanonV Braced Bibtex Version',
        'author'              => CANONV_TRUNCATED,
        'canonical_source_id' => $canonicalId,
    ]);
    $bracedBibtex = '@article{y, author = {{Corporate Name} and One Author}, title = {T}, year = {2020}}';
    canonvDb()->table('library')->where('book', $bracedBook)->update(['bibtex' => $bracedBibtex]);

    $this->artisan('library:backfill-authors')->assertExitCode(0);

    // Canonical repaired to the full list.
    expect(canonvDb()->table('canonical_source')->where('id', $canonicalId)->value('author'))
        ->toBe(CANONV_FULL);

    // Machine-truncated row repaired, bibtex author " and "-joined with all 5.
    $truncated = canonvDb()->table('library')->where('book', $truncatedBook)->first();
    expect($truncated->author)->toBe(CANONV_FULL);
    expect($truncated->bibtex)->toContain('One Author and Two Author and Three Author and Four Author and Five Author');

    // Hand-edited author untouched.
    expect(canonvDb()->table('library')->where('book', $handEditedBook)->value('author'))
        ->toBe('My Preferred Byline');

    // Brace-protected bibtex left alone (author column still repaired).
    $braced = canonvDb()->table('library')->where('book', $bracedBook)->first();
    expect($braced->author)->toBe(CANONV_FULL);
    expect($braced->bibtex)->toBe($bracedBibtex);
});

test('--force overwrites hand-edited authors, default run does not', function () {
    $canonicalId = canonvSeedCanonical([
        'title'       => 'CanonV Backfill Force Work',
        'author'      => CANONV_FULL,
        'authorships' => canonvAuthorships(CANONV_FIVE),
    ]);
    $handEditedBook = canonvSeedLibrary([
        'title'               => 'CanonV Force Version',
        'author'              => 'My Preferred Byline',
        'canonical_source_id' => $canonicalId,
    ]);

    $this->artisan('library:backfill-authors')->assertExitCode(0);
    expect(canonvDb()->table('library')->where('book', $handEditedBook)->value('author'))
        ->toBe('My Preferred Byline');

    $this->artisan('library:backfill-authors', ['--force' => true])->assertExitCode(0);
    expect(canonvDb()->table('library')->where('book', $handEditedBook)->value('author'))
        ->toBe(CANONV_FULL);
});

test('dry-run changes nothing and a second live run is a no-op', function () {
    $canonicalId = canonvSeedCanonical([
        'title'       => 'CanonV Backfill Dry Work',
        'author'      => CANONV_TRUNCATED,
        'authorships' => canonvAuthorships(CANONV_FIVE),
    ]);
    $book = canonvSeedLibrary([
        'title'               => 'CanonV Dry Version',
        'author'              => CANONV_TRUNCATED,
        'canonical_source_id' => $canonicalId,
    ]);

    $this->artisan('library:backfill-authors', ['--dry-run' => true])->assertExitCode(0);
    expect(canonvDb()->table('canonical_source')->where('id', $canonicalId)->value('author'))
        ->toBe(CANONV_TRUNCATED);
    expect(canonvDb()->table('library')->where('book', $book)->value('author'))
        ->toBe(CANONV_TRUNCATED);

    $this->artisan('library:backfill-authors')->assertExitCode(0);
    $this->artisan('library:backfill-authors')->assertExitCode(0);
    expect(canonvDb()->table('library')->where('book', $book)->value('author'))->toBe(CANONV_FULL);
});

test('a canonical already carrying the full list still repairs its truncated library rows', function () {
    $canonicalId = canonvSeedCanonical([
        'title'       => 'CanonV Backfill Propagate Work',
        'author'      => CANONV_FULL,
        'authorships' => canonvAuthorships(CANONV_FIVE),
    ]);
    $book = canonvSeedLibrary([
        'title'               => 'CanonV Propagate Version',
        'author'              => CANONV_TRUNCATED,
        'canonical_source_id' => $canonicalId,
    ]);

    $this->artisan('library:backfill-authors')->assertExitCode(0);
    expect(canonvDb()->table('library')->where('book', $book)->value('author'))->toBe(CANONV_FULL);
});
