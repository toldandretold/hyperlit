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

test('extracts the full reference list with keys — the completeness signal', function () {
    $article = (new JatsFullText())->toArticle(jatsFixture());

    expect($article['refCount'])->toBe(10);
    expect($article['references'])->toHaveCount(10);
    expect($article['references'][0]['text'])->not->toBeEmpty();
    expect($article['references'][0]['key'])->not->toBeEmpty();
});

test('xref citations become anchor links (so in-text citations survive)', function () {
    $article = (new JatsFullText())->toArticle(jatsFixture());
    // JATS xref → <a href="#rid"> — the hook the citation linker needs
    expect($article['html'])->toContain('<a href="#');
});

test('malformed XML degrades to empty, never throws', function () {
    $article = (new JatsFullText())->toArticle('<not-jats><unclosed>');
    expect($article['refCount'])->toBe(0);
    expect($article['title'])->toBeNull();
});
