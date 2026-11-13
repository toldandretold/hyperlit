<?php

use App\Services\SourceImport\Identifier\ArxivId;
use App\Services\SourceImport\Identifier\Doi;
use App\Services\SourceImport\Identifier\GutenbergId;
use App\Services\SourceImport\Identifier\IdentifierNormalizer;
use App\Services\SourceImport\Identifier\OpenAlexId;

beforeEach(function () {
    $this->normaliser = new IdentifierNormalizer();
});

// ─── arXiv ────────────────────────────────────────────────────────────

test('parses arxiv abs URL', function () {
    $id = $this->normaliser->parse('https://arxiv.org/abs/2302.08927');
    expect($id)->toBeInstanceOf(ArxivId::class);
    expect($id->value())->toBe('2302.08927');
});

test('parses arxiv PDF URL', function () {
    $id = $this->normaliser->parse('https://arxiv.org/pdf/2302.08927.pdf');
    expect($id)->toBeInstanceOf(ArxivId::class);
    expect($id->value())->toBe('2302.08927');
});

test('parses ar5iv URL', function () {
    $id = $this->normaliser->parse('https://ar5iv.labs.arxiv.org/html/2302.08927');
    expect($id)->toBeInstanceOf(ArxivId::class);
    expect($id->value())->toBe('2302.08927');
});

test('parses bare new-style arxiv ID', function () {
    $id = $this->normaliser->parse('2302.08927');
    expect($id)->toBeInstanceOf(ArxivId::class);
    expect($id->value())->toBe('2302.08927');
});

test('parses old-style arxiv ID with subject prefix', function () {
    $id = $this->normaliser->parse('cs/0301001');
    expect($id)->toBeInstanceOf(ArxivId::class);
    expect($id->value())->toBe('cs/0301001');
});

test('parses arxiv: prefix form', function () {
    $id = $this->normaliser->parse('arxiv:2302.08927');
    expect($id)->toBeInstanceOf(ArxivId::class);
    expect($id->value())->toBe('2302.08927');
});

test('strips version suffix from arxiv ID', function () {
    $id = $this->normaliser->parse('https://arxiv.org/abs/2302.08927v3');
    expect($id->value())->toBe('2302.08927');
});

test('extracts arxiv ID from arxiv-minted DOI', function () {
    $id = $this->normaliser->parse('10.48550/arXiv.2302.08927');
    expect($id)->toBeInstanceOf(ArxivId::class);
    expect($id->value())->toBe('2302.08927');
});

test('arxiv ID renders canonical URL', function () {
    $id = new ArxivId('2302.08927');
    expect($id->url())->toBe('https://arxiv.org/abs/2302.08927');
});

test('arxiv ID derives equivalent DOI', function () {
    $id = new ArxivId('2302.08927');
    expect($id->asDoi()->value())->toBe('10.48550/arXiv.2302.08927');
});

// ─── DOI ──────────────────────────────────────────────────────────────

test('parses doi.org URL', function () {
    $id = $this->normaliser->parse('https://doi.org/10.1109/WI-IAT.2015.90');
    expect($id)->toBeInstanceOf(Doi::class);
    expect($id->value())->toBe('10.1109/WI-IAT.2015.90');
});

test('parses dx.doi.org URL', function () {
    $id = $this->normaliser->parse('https://dx.doi.org/10.1109/WI-IAT.2015.90');
    expect($id)->toBeInstanceOf(Doi::class);
    expect($id->value())->toBe('10.1109/WI-IAT.2015.90');
});

test('parses doi: prefix form', function () {
    $id = $this->normaliser->parse('doi:10.1109/WI-IAT.2015.90');
    expect($id)->toBeInstanceOf(Doi::class);
    expect($id->value())->toBe('10.1109/WI-IAT.2015.90');
});

test('parses bare DOI', function () {
    $id = $this->normaliser->parse('10.1109/WI-IAT.2015.90');
    expect($id)->toBeInstanceOf(Doi::class);
    expect($id->value())->toBe('10.1109/WI-IAT.2015.90');
});

test('trims trailing sentence punctuation from DOI', function () {
    $id = $this->normaliser->parse('10.1109/WI-IAT.2015.90.');
    expect($id->value())->toBe('10.1109/WI-IAT.2015.90');
});

test('DOI renders canonical URL', function () {
    $id = new Doi('10.1109/WI-IAT.2015.90');
    expect($id->url())->toBe('https://doi.org/10.1109/WI-IAT.2015.90');
});

// ─── Project Gutenberg ────────────────────────────────────────────────

test('parses gutenberg ebooks URL', function () {
    $id = $this->normaliser->parse('https://www.gutenberg.org/ebooks/79922');
    expect($id)->toBeInstanceOf(GutenbergId::class);
    expect($id->value())->toBe('79922');
});

test('parses gutenberg ebooks URL without www', function () {
    $id = $this->normaliser->parse('https://gutenberg.org/ebooks/1342');
    expect($id)->toBeInstanceOf(GutenbergId::class);
    expect($id->value())->toBe('1342');
});

test('parses gutenberg download URL with format suffix', function () {
    $id = $this->normaliser->parse('https://www.gutenberg.org/ebooks/79922.epub3.images');
    expect($id)->toBeInstanceOf(GutenbergId::class);
    expect($id->value())->toBe('79922');
});

test('parses gutenberg cache file URL', function () {
    $id = $this->normaliser->parse('https://www.gutenberg.org/cache/epub/79922/pg79922-images-3.epub');
    expect($id)->toBeInstanceOf(GutenbergId::class);
    expect($id->value())->toBe('79922');
});

test('parses gutenberg files URL', function () {
    $id = $this->normaliser->parse('https://www.gutenberg.org/files/79922/79922-0.txt');
    expect($id)->toBeInstanceOf(GutenbergId::class);
    expect($id->value())->toBe('79922');
});

test('gutenberg ID renders canonical URL', function () {
    $id = new GutenbergId('79922');
    expect($id->url())->toBe('https://www.gutenberg.org/ebooks/79922');
});

test('non-book gutenberg URL is not recognised', function () {
    expect($this->normaliser->parse('https://www.gutenberg.org/policy/license.html'))->toBeNull();
});

test('bare number is not a gutenberg ID', function () {
    // Without the gutenberg.org host a number is ambiguous — stays unrecognised.
    expect($this->normaliser->parse('79922'))->toBeNull();
});

// ─── Negative cases ───────────────────────────────────────────────────

test('returns null for empty input', function () {
    expect($this->normaliser->parse(''))->toBeNull();
    expect($this->normaliser->parse('   '))->toBeNull();
});

test('returns null for plain text', function () {
    expect($this->normaliser->parse('hello world'))->toBeNull();
});

test('returns null for non-DOI URL', function () {
    expect($this->normaliser->parse('https://example.com/foo'))->toBeNull();
});

test('arxiv DOI is parsed as arxiv ID, not generic DOI', function () {
    // Otherwise a paper imported via DOI vs URL would dedupe incorrectly.
    $id = $this->normaliser->parse('10.48550/arXiv.2302.08927');
    expect($id)->toBeInstanceOf(ArxivId::class);
});

// ─── OpenAlex work ids ────────────────────────────────────────────────

test('parses a bare OpenAlex work id', function () {
    $id = $this->normaliser->parse('W2126853606');
    expect($id)->toBeInstanceOf(OpenAlexId::class);
    expect($id->value())->toBe('W2126853606');
    expect($id->kind())->toBe('openalex');
});

test('parses OpenAlex URLs, api URLs and the openalex: prefix, upper-casing the id', function (string $input) {
    $id = $this->normaliser->parse($input);
    expect($id)->toBeInstanceOf(OpenAlexId::class);
    expect($id->value())->toBe('W2126853606');
})->with([
    'https://openalex.org/W2126853606',
    'https://openalex.org/works/w2126853606',
    'https://api.openalex.org/works/W2126853606',
    'openalex:W2126853606',
    '  w2126853606  ',
]);

test('a W-number inside prose is not an OpenAlex id', function () {
    expect($this->normaliser->parse('see W2126853606 for details'))->toBeNull();
});

// ─── DOIs lifted out of publisher URLs ────────────────────────────────

test('a publisher article URL does not drag its own tail into the DOI', function (string $url, string $doi) {
    $id = $this->normaliser->parse($url);
    expect($id)->toBeInstanceOf(Doi::class);
    expect($id->value())->toBe($doi);
})->with([
    ['https://www.tandfonline.com/doi/full/10.1080/00220388.2019.1234567?src=recsys', '10.1080/00220388.2019.1234567'],
    ['https://onlinelibrary.wiley.com/doi/10.1111/anti.12345/abstract', '10.1111/anti.12345'],
    ['https://journals.sagepub.com/doi/pdf/10.1177/0309132518777623', '10.1177/0309132518777623'],
    ['https://onlinelibrary.wiley.com/doi/epdf/10.1111/anti.12345#section-2', '10.1111/anti.12345'],
]);

test('a bare DOI keeps characters a publisher URL would lose', function () {
    // Old SICI-style Wiley DOIs legitimately contain "#"-free but odd punctuation; a bare
    // DOI is never treated as a URL, so nothing after "?" or "/full" is stripped from it.
    $id = $this->normaliser->parse('10.1000/example/full');
    expect($id->value())->toBe('10.1000/example/full');
});

