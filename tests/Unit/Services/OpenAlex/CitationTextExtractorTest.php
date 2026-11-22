<?php

/**
 * Characterization tests for OpenAlexService's citation-text extraction
 * (extractDoi / extractIsbn / extractTitle), written BEFORE the facade
 * modularization so the extracted CitationTextExtractor module can be
 * verified as pure code motion. They exercise the CURRENT public API on
 * the service and must pass identically before and after the split.
 */

use App\Services\OpenAlexService;
use Tests\TestCase;

uses(TestCase::class);

$svc = fn () => app(OpenAlexService::class);

// ---------------------------------------------------------------- extractDoi

test('extractDoi finds a doi.org href link first', function () use ($svc) {
    $html = '<p>See <a href="https://doi.org/10.1086/713101">this article</a>.</p>';
    expect($svc()->extractDoi($html))->toBe('10.1086/713101');
});

test('extractDoi handles dx.doi.org hrefs', function () use ($svc) {
    $html = '<a href="http://dx.doi.org/10.1257/aer.101.7.3253">x</a>';
    expect($svc()->extractDoi($html))->toBe('10.1257/aer.101.7.3253');
});

test('extractDoi finds a plain-text doi: prefix pattern', function () use ($svc) {
    expect($svc()->extractDoi('Smith 2019. doi:10.1017/S0022050700046209'))
        ->toBe('10.1017/S0022050700046209');
});

test('extractDoi finds a bare DOI at a word boundary', function () use ($svc) {
    expect($svc()->extractDoi('Available at 10.5555/12345678 in the archive'))
        ->toBe('10.5555/12345678');
});

test('extractDoi strips trailing punctuation', function () use ($svc) {
    expect($svc()->extractDoi('doi:10.1086/713101.'))->toBe('10.1086/713101');
    expect($svc()->extractDoi('(https://doi.org/10.1086/713101)'))->toBe('10.1086/713101');
});

test('extractDoi returns null when no DOI is present', function () use ($svc) {
    expect($svc()->extractDoi('Smith, J. (2019). A book about things. Verso.'))->toBeNull();
});

// --------------------------------------------------------------- extractIsbn

test('extractIsbn normalises a hyphenated ISBN-13', function () use ($svc) {
    expect($svc()->extractIsbn('ISBN 978-0-14-303943-3'))->toBe('9780143039433');
});

test('extractIsbn prefers ISBN-13 over ISBN-10 when both present', function () use ($svc) {
    $text = 'isbn: 978-0-14-303943-3 (also 0-14-303943-X)';
    expect($svc()->extractIsbn($text))->toBe('9780143039433');
});

test('extractIsbn accepts an ISBN-10 with X check digit and uppercases it', function () use ($svc) {
    expect($svc()->extractIsbn('ISBN 0-8044-2957-x'))->toBe('080442957X');
});

test('extractIsbn returns null when nothing ISBN-shaped exists', function () use ($svc) {
    expect($svc()->extractIsbn('Journal of Things 44(2), 100-120'))->toBeNull();
});

// -------------------------------------------------------------- extractTitle

test('extractTitle prefers a quoted title (article/chapter form)', function () use ($svc) {
    $raw = 'Smith, Jane. 2019. "The Great Transformation of Everything." Journal of Stuff 4(2).';
    expect($svc()->extractTitle($raw))->toBe('The Great Transformation of Everything');
});

test('extractTitle handles curly quotes', function () use ($svc) {
    $raw = "Smith, Jane. 2019. \u{201C}Empire and Its Discontents Today\u{201D}. Verso.";
    expect($svc()->extractTitle($raw))->toBe('Empire and Its Discontents Today');
});

test('extractTitle uses italic text as a book title when nothing sits between year and italics', function () use ($svc) {
    $raw = 'Harvey, David. 2005. <i>A Brief History of Neoliberalism</i>. Oxford University Press.';
    expect($svc()->extractTitle($raw))->toBe('A Brief History of Neoliberalism');
});

test('extractTitle treats text between year and italics as the article title', function () use ($svc) {
    $raw = 'Smith, Jane. 2019. Rethinking primitive accumulation at the margins. <i>Journal of Agrarian Change</i> 19(2).';
    expect($svc()->extractTitle($raw))->toBe('Rethinking primitive accumulation at the margins');
});

test('extractTitle handles EPUB text-style span italics', function () use ($svc) {
    $raw = 'Mbembe, Achille. 2001. <span class="t13">On the Postcolony</span>. University of California Press.';
    expect($svc()->extractTitle($raw))->toBe('On the Postcolony');
});

test('extractTitle falls back to year-anchor: text after the year up to a sentence boundary', function () use ($svc) {
    $raw = 'Nilsen, Alf Gunvald 2010 Dispossession and resistance in India. London: Routledge';
    expect($svc()->extractTitle($raw))->toBe('Dispossession and resistance in India');
});

test('extractTitle strips a leading author pattern as a last resort', function () use ($svc) {
    $raw = 'Federici, Silvia. Caliban and the Witch was reprinted often';
    $title = $svc()->extractTitle($raw);
    expect($title)->toContain('Caliban and the Witch');
    expect($title)->not->toContain('Federici');
});

// ------------------------------------------- extractTitle: multibyte offsets
// book_1795304853799 / chu2009 (2026-11-21): the year offset was BYTES and the italic offset
// CHARACTERS, so the two 3-byte curly quotes before <em> cut the substr 4 bytes short and split
// the closing ’ — "…Asian Women\xE2" — which Postgres refused as invalid UTF-8, killing the scan.

test('extractTitle returns valid UTF-8 for a curly-quoted article title before an italic venue', function () use ($svc) {
    $raw = '<p><a class="bib-entry" id="chu2009"></a>Chu, Y. (2009) ‘The New Trophy Wives: Asian Women’. '
         . '<em>Marie Claire</em>. Available at: http://www.marieclaire.com/sex-love/advice/asian-trophy-wife. '
         . 'Accessed 16 December 2015.</p>';
    $title = $svc()->extractTitle($raw);
    expect(mb_check_encoding($title, 'UTF-8'))->toBeTrue()
        ->and($title)->toBe('The New Trophy Wives: Asian Women');
});

test('extractTitle keeps an internal apostrophe when stripping the title quotes', function () use ($svc) {
    $raw = 'Zheng, R. (2016) ‘Why Yellow Fever Isn’t Flattering’. <em>Journal of the American Philosophical Association</em>, 2(3).';
    expect($svc()->extractTitle($raw))->toBe('Why Yellow Fever Isn’t Flattering');
});

test('extractTitle truncation never splits a multibyte character', function () use ($svc) {
    $raw = 'Author, A. (2001) ' . str_repeat('é', 200);
    $title = $svc()->extractTitle($raw);
    expect(mb_check_encoding($title, 'UTF-8'))->toBeTrue()
        ->and(mb_strlen($title))->toBe(150);
});
