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

// ext-link targets must come out ABSOLUTE or not at all: JATS carries bare
// identifiers (DOI/PMID/PMCID, no scheme) in xlink:href, and a verbatim copy
// mints a RELATIVE href that crawlers resolve against hyperlit.io — GSC
// crawled /10.1371/journal.pone.0144717 as a real page (2026-10).
test('ext-links never emit relative hrefs — identifiers absolutized, unknowns unlinked', function () {
    $xml = <<<'XML'
<article xmlns:xlink="http://www.w3.org/1999/xlink">
  <front><article-title>t</article-title></front>
  <body>
    <p>doi <ext-link ext-link-type="doi" xlink:href="10.1371/journal.pone.0144717">plos</ext-link></p>
    <p>abs <ext-link ext-link-type="uri" xlink:href="https://example.org/x">site</ext-link></p>
    <p>pmid <ext-link ext-link-type="pmid" xlink:href="25448298">pubmed</ext-link></p>
    <p>pmcid <ext-link ext-link-type="pmcid" xlink:href="PMC4702792">pmc</ext-link></p>
    <p>bare <ext-link xlink:href="4702792">mystery</ext-link></p>
    <p>www <ext-link ext-link-type="uri" xlink:href="www.example.org/y">w</ext-link></p>
    <p>selfclosed<ext-link ext-link-type="google-scholar" xlink:href="title=Peer%20Review&amp;author=F%20Godlee"/>end</p>
  </body>
</article>
XML;
    $html = (new JatsFullText())->toArticle($xml)['html'];

    expect($html)->toContain('<a href="https://doi.org/10.1371/journal.pone.0144717">plos</a>');
    expect($html)->toContain('<a href="https://example.org/x">site</a>');
    expect($html)->toContain('<a href="https://pubmed.ncbi.nlm.nih.gov/25448298/">pubmed</a>');
    expect($html)->toContain('<a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC4702792/">pmc</a>');
    // A bare number with no declared type is unresolvable → text survives, link doesn't.
    expect($html)->toContain('bare mystery');
    expect($html)->not->toContain('href="4702792"');
    expect($html)->toContain('<a href="https://www.example.org/y">w</a>');
    // Self-closed ext-links (PMC reference lists) emit nothing — no empty <a>.
    expect($html)->toContain('<p>selfclosed'
        . 'end</p>');
    // The invariant itself: no relative href anywhere in the output.
    expect(preg_match('#href="(?!https?://|\#)#', $html))->toBe(0);
});

test('absoluteExtLinkUrl classifies every identifier shape', function (string $raw, string $type, ?string $expected) {
    expect(JatsFullText::absoluteExtLinkUrl($raw, $type))->toBe($expected);
})->with([
    'bare DOI'            => ['10.1371/journal.pbio.0020309', '', 'https://doi.org/10.1371/journal.pbio.0020309'],
    'doi:-prefixed'       => ['doi:10.1234/abc', '', 'https://doi.org/10.1234/abc'],
    'absolute http kept'  => ['http://example.org/a', '', 'http://example.org/a'],
    'PMC prefix, no type' => ['PMC4702792', '', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4702792/'],
    'digits + pmid type'  => ['25448298', 'pmid', 'https://pubmed.ncbi.nlm.nih.gov/25448298/'],
    'digits + pmcid type' => ['4702792', 'pmcid', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4702792/'],
    'bare digits no type' => ['25448298', '', null],
    'www host'            => ['www.example.org', '', 'https://www.example.org'],
    'relative junk'       => ['some/page.html', '', null],
    'empty'               => ['', 'doi', null],
]);

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
