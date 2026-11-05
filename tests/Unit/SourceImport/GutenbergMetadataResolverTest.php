<?php

/**
 * GutenbergMetadataResolver — parses Gutenberg's first-party RDF into the
 * normalised work shape. The load-bearing assertions: year comes from marc906
 * (the ORIGINAL publication year), never dcterms:issued (the Gutenberg release
 * date), and is_oa is true so AccessPolicy routes the import down the open
 * branch. Http faked — no network.
 */

use App\Services\SourceImport\Identifier\ArxivId;
use App\Services\SourceImport\Identifier\GutenbergId;
use App\Services\SourceImport\Metadata\GutenbergMetadataResolver;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

uses(TestCase::class);

// Trimmed from the real RDF for ebook 79922 (fetched 2026-11-05).
const GUTENBERG_RDF = <<<'XML'
<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xml:base="http://www.gutenberg.org/"
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns:pgterms="http://www.gutenberg.org/2009/pgterms/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcam="http://purl.org/dc/dcam/">
  <pgterms:ebook rdf:about="ebooks/79922">
    <dcterms:publisher>Project Gutenberg</dcterms:publisher>
    <dcterms:issued rdf:datatype="http://www.w3.org/2001/XMLSchema#date">2026-11-04</dcterms:issued>
    <dcterms:rights>Public domain in the USA.</dcterms:rights>
    <dcterms:creator>
      <pgterms:agent rdf:about="2009/agents/33594">
        <pgterms:name>Ferlaine, J. Anthony (John Anthony)</pgterms:name>
      </pgterms:agent>
    </dcterms:creator>
    <dcterms:title>Enough is enough</dcterms:title>
    <pgterms:marc906>1956</pgterms:marc906>
    <dcterms:language>
      <rdf:Description rdf:nodeID="N7079">
        <rdf:value rdf:datatype="http://purl.org/dc/terms/RFC4646">en</rdf:value>
      </rdf:Description>
    </dcterms:language>
  </pgterms:ebook>
</rdf:RDF>
XML;

test('parses title, author, original year, language and OA flags from RDF', function () {
    Http::fake([
        'www.gutenberg.org/ebooks/79922.rdf' => Http::response(GUTENBERG_RDF, 200),
    ]);

    $metadata = app(GutenbergMetadataResolver::class)->resolve(new GutenbergId('79922'));

    expect($metadata)->not->toBeNull();
    expect($metadata->source)->toBe('gutenberg');
    expect($metadata->title())->toBe('Enough is enough');
    expect($metadata->author())->toBe('Ferlaine, J. Anthony (John Anthony)');
    // marc906 (original publication year), NOT the 2026 Gutenberg release date.
    expect($metadata->year())->toBe(1956);
    expect($metadata->data['language'])->toBe('en');
    expect($metadata->data['type'])->toBe('book');
    expect($metadata->isOpenAccess())->toBeTrue();
    expect($metadata->license())->toBe('Public domain in the USA.');
    expect($metadata->doi())->toBeNull();
    expect($metadata->data['url'])->toBe('https://www.gutenberg.org/ebooks/79922');
});

test('falls back to issued year when marc906 is absent', function () {
    $rdf = str_replace('<pgterms:marc906>1956</pgterms:marc906>', '', GUTENBERG_RDF);
    Http::fake([
        'www.gutenberg.org/ebooks/79922.rdf' => Http::response($rdf, 200),
    ]);

    $metadata = app(GutenbergMetadataResolver::class)->resolve(new GutenbergId('79922'));

    expect($metadata->year())->toBe(2026);
});

test('returns null on HTTP failure', function () {
    Http::fake([
        'www.gutenberg.org/ebooks/79922.rdf' => Http::response('Not Found', 404),
    ]);

    expect(app(GutenbergMetadataResolver::class)->resolve(new GutenbergId('79922')))->toBeNull();
});

test('returns null on unparseable body', function () {
    Http::fake([
        'www.gutenberg.org/ebooks/79922.rdf' => Http::response('<html>not rdf', 200),
    ]);

    expect(app(GutenbergMetadataResolver::class)->resolve(new GutenbergId('79922')))->toBeNull();
});

test('does not support non-Gutenberg identifiers', function () {
    expect(app(GutenbergMetadataResolver::class)->supports(new ArxivId('2302.08927')))->toBeFalse();
    expect(app(GutenbergMetadataResolver::class)->supports(new GutenbergId('79922')))->toBeTrue();
});
