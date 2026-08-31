<?php

/**
 * The citation contract of App\Services\LibraryCardGenerator — the ONE card
 * renderer for every feed (homepage most-* books, shelf renders, user-home
 * books and sorted variants).
 *
 * Locks the two things the unification changed:
 *  1. BibTeX parsing lives HERE now (ported from HomePageServerController) and
 *     every interpolated field is HTML-escaped — the old homepage copy
 *     interpolated raw values ("<strong>{$author}</strong>"), a stored-XSS
 *     shape reachable by anyone who could set library metadata.
 *  2. Precedence: E2EE lock label → parsed bibtex → structured fields, with
 *     bare-UUID authors anonymised to "Anon." on BOTH citation paths.
 */

use App\Services\LibraryCardGenerator;

function cardRecord(array $attrs): object
{
    return (object) array_merge([
        'book' => 'book_123', 'title' => null, 'author' => null, 'year' => null,
        'publisher' => null, 'journal' => null, 'bibtex' => null, 'encrypted' => null,
    ], $attrs);
}

test('bibtex field values are HTML-escaped', function () {
    $html = (new LibraryCardGenerator())->parseBibtexToHtml(
        '@article{x, author = {<script>alert(1)</script>}, title = {A <img src=x onerror=alert(2)> Title}, journal = {Bad & Co}, year = {2020}}'
    );

    expect($html)->not->toContain('<script>');
    expect($html)->not->toContain('<img');
    expect($html)->toContain('&lt;script&gt;');
    expect($html)->toContain('&lt;img');
    expect($html)->toContain('Bad &amp; Co');
});

test('the DOI link is escaped and hardened', function () {
    $html = (new LibraryCardGenerator())->parseBibtexToHtml(
        '@article{x, author = {A}, title = {T}, doi = {10.1/x"><script>alert(1)</script>}}'
    );

    expect($html)->not->toContain('"><script>');
    expect($html)->toContain('rel="noopener"');
});

test('article bibtex formats journal, volume(number), year and pages', function () {
    $html = (new LibraryCardGenerator())->parseBibtexToHtml(
        '@article{x, author = {Jane Doe}, title = {On Things}, journal = {Journal of Stuff}, volume = {12}, number = {3}, year = {2021}, pages = {1-20}}'
    );

    expect($html)->toContain('<strong>Jane Doe</strong>');
    expect($html)->toContain('"On Things."');
    expect($html)->toContain('<em>Journal of Stuff</em>');
    expect($html)->toContain('12(3)');
    expect($html)->toContain('(2021)');
    expect($html)->toContain('1-20');
});

test('a bare-UUID author is anonymised on the bibtex path', function () {
    $html = (new LibraryCardGenerator())->parseBibtexToHtml(
        '@book{x, author = {123e4567-e89b-12d3-a456-426614174000}, title = {T}, year = {2020}}'
    );

    expect($html)->toContain('<strong>Anon.</strong>');
    expect($html)->not->toContain('123e4567');
});

test('a bare-UUID author is anonymised on the structured-field path', function () {
    $html = (new LibraryCardGenerator())->generateCitationHtml(
        cardRecord(['author' => '123e4567-e89b-12d3-a456-426614174000', 'title' => 'T'])
    );

    expect($html)->toContain('<strong>Anon.</strong>');
    expect($html)->not->toContain('123e4567');
});

test('bibtex wins over structured fields when parseable', function () {
    $html = (new LibraryCardGenerator())->generateCitationHtml(cardRecord([
        'author' => 'Field Author', 'title' => 'Field Title',
        'bibtex' => '@book{x, author = {Bibtex Author}, title = {Bibtex Title}, year = {1999}}',
    ]));

    expect($html)->toContain('Bibtex Author');
    expect($html)->not->toContain('Field Author');
});

test('unparseable bibtex falls back to structured fields', function () {
    $html = (new LibraryCardGenerator())->generateCitationHtml(cardRecord([
        'author' => 'Field Author', 'title' => 'Field Title',
        'bibtex' => 'this is not bibtex at all',
    ]));

    expect($html)->toContain('Field Author');
});

test('structured fields are escaped', function () {
    $html = (new LibraryCardGenerator())->generateCitationHtml(cardRecord([
        'author' => '<b>evil</b>', 'title' => '<script>x</script>',
    ]));

    expect($html)->not->toContain('<b>evil');
    expect($html)->not->toContain('<script>');
});

test('an encrypted record never renders its bibtex (ciphertext)', function () {
    $html = (new LibraryCardGenerator())->generateCitationHtml(cardRecord([
        'encrypted' => true,
        'bibtex' => '@book{x, author = {Leaked Ciphertext}, title = {Leak}}',
    ]));

    expect($html)->toContain('Encrypted book');
    expect($html)->not->toContain('Leaked Ciphertext');
});

test('patchBibtexFields replaces an existing field value in place', function () {
    $bib = "@book{b1,\n  author = {Old Author},\n  title  = {Old Title},\n  year   = {2020},\n}";
    $patched = (new LibraryCardGenerator())->patchBibtexFields($bib, ['title' => 'New Title']);

    expect($patched)->toContain('title  = {New Title}');
    expect($patched)->toContain('author = {Old Author}');
    expect($patched)->toContain('year   = {2020}');
});

test('patchBibtexFields inserts a field the entry does not have', function () {
    $bib = "@book{b1,\n  title  = {Only Title},\n}";
    $patched = (new LibraryCardGenerator())->patchBibtexFields($bib, ['author' => 'Someone']);

    expect($patched)->toContain('author = {Someone}');
    expect((new LibraryCardGenerator())->parseBibtexToHtml($patched))->toContain('Someone');
});

test('patchBibtexFields leaves unparseable bibtex untouched', function () {
    expect((new LibraryCardGenerator())->patchBibtexFields('not bibtex', ['title' => 'X']))->toBe('not bibtex');
});

test('a literal "null" bibtex author is rendered author-less, not as "null."', function () {
    // buildBibtexEntry used to interpolate a null author as the string "null";
    // rows minted before that fix still carry it (the library-home-sync card bug).
    $html = (new LibraryCardGenerator())->generateCitationHtml(cardRecord([
        'bibtex' => '@book{x, author = {null}, title = {Untitled}, year = {2026}}',
    ]));

    expect($html)->not->toContain('null');
    expect($html)->toContain('Untitled');
    expect($html)->not->toContain(', 2026'); // no ". , 2026" separator artifact
    expect($html)->toContain('2026');
});
