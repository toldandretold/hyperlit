<?php

/**
 * JatsFullText::toArticle — the authoritative-content parser. The whole point
 * of preferring JATS over scraped HTML is that completeness is a FACT (schema
 * labels <body> + <ref-list>), so these tests pin that the parser actually
 * surfaces both: real article HTML and a counted reference list usable for a
 * completeness gate against OpenAlex referenced_works.
 *
 * Fixture is a real Europe PMC fullTextXML capture (PMC13131419, "Pillars of
 * Peer Review").
 */

use App\Services\SourceImport\Content\JatsFullText;

function jatsFixture(): string
{
    // dirname(__DIR__, 2) = tests/ — base_path() isn't bound in the Unit suite.
    return file_get_contents(dirname(__DIR__, 2) . '/Fixtures/jats/pmc13131419.xml');
}

test('extracts the article title from JATS front matter', function () {
    $article = (new JatsFullText())->toArticle(jatsFixture());
    expect($article['title'])->toBe('Pillars of Peer Review');
});

test('produces article body HTML with paragraphs and section headings', function () {
    $article = (new JatsFullText())->toArticle(jatsFixture());

    expect($article['html'])->toContain('<h1>Pillars of Peer Review</h1>');
    expect($article['html'])->toContain('<p>');
    // Body should carry real prose, not just metadata
    expect(strlen(strip_tags($article['html'])))->toBeGreaterThan(1000);
});

test('extracts the full reference list in app-native shape — the completeness signal', function () {
    $article = (new JatsFullText())->toArticle(jatsFixture());

    expect($article['refCount'])->toBe(10);
    expect($article['references'])->toHaveCount(10);
    // Persistence-ready keys (consumed by persistArticle → bibliography table)
    expect($article['references'][0]['referenceId'])->not->toBeEmpty();
    expect($article['references'][0]['content'])->not->toBeEmpty();
    // References render as bib-entries under the body
    expect($article['html'])->toContain('class="bib-entry"');
});

test('bibr xrefs become app-native in-text-citation links (exact, no fuzzy linking)', function () {
    $article = (new JatsFullText())->toArticle(jatsFixture());
    // <xref ref-type="bibr" rid="bibN"> → <a class="in-text-citation" href="#bibN">
    expect($article['html'])->toContain('class="in-text-citation" href="#bib');
});

test('exposes footnotes array (may be empty) for persistArticle', function () {
    $article = (new JatsFullText())->toArticle(jatsFixture());
    expect($article)->toHaveKey('footnotes');
    expect($article['footnotes'])->toBeArray();
});

test('malformed XML degrades to empty, never throws', function () {
    $article = (new JatsFullText())->toArticle('<not-jats><unclosed>');
    expect($article['refCount'])->toBe(0);
    expect($article['title'])->toBeNull();
});

// Richer fixture: a research article with <fn> footnotes + many spread-out
// citations, so the footnote-extraction path is exercised with real data
// (the editorial above has zero <fn>).
test('extracts <fn> footnotes and many in-text citations from a research article', function () {
    $xml = file_get_contents(dirname(__DIR__, 2) . '/Fixtures/jats/pmc12967033.xml');
    $article = (new JatsFullText())->toArticle($xml);

    expect(count($article['footnotes']))->toBeGreaterThan(0);
    expect($article['footnotes'][0]['footnoteId'])->not->toBeEmpty();
    expect($article['footnotes'][0]['content'])->not->toBeEmpty();
    // Citations spread through the body (53 bibr xrefs in source)
    expect(substr_count($article['html'], 'in-text-citation'))->toBeGreaterThan(20);
    expect($article['refCount'])->toBeGreaterThan(20);
});
