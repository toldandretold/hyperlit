<?php

/**
 * Crossref multiple-resolution chooser pages must be FOLLOWED, not imported or
 * rejected. Prod case (2026-08 GSCJ harvest): ten fresh Bristol UP DOIs whose
 * doi.org resolution serves chooser.crossref.org instead of redirecting — the
 * chooser has zero prose, so every one failed the body gate as "no article
 * body" while sibling articles from the same journal imported fine. The
 * fixture is the real chooser page for 10.1332/27523349Y2026D000000094.
 */

use App\Services\SourceImport\Content\CrossrefChooserResolver;

function chooserFixture(): string
{
    return file_get_contents(base_path('tests/paste/fixtures/walled/crossref-chooser.html'));
}

test('extracts the first listed location from a chooser page landed on chooser.crossref.org', function () {
    $target = app(CrossrefChooserResolver::class)->target(
        'https://chooser.crossref.org/?doi=10.1332%2F27523349Y2026D000000094',
        chooserFixture(),
    );

    expect($target)->toBe(
        'https://bristoluniversitypressdigital.com/view/journals/gscj/aop/'
        . 'article-10.1332-27523349Y2026D000000094/article-10.1332-27523349Y2026D000000094.xml',
    );
});

test('still detects a chooser when the redirect history is lost (landed URL reads doi.org)', function () {
    $target = app(CrossrefChooserResolver::class)->target(
        'https://doi.org/10.1332/27523349Y2026D000000094',
        chooserFixture(),
    );

    expect($target)->not->toBeNull()
        ->and(parse_url($target, PHP_URL_HOST))->toBe('bristoluniversitypressdigital.com');
});

test('never fires on a real article page', function () {
    $article = file_get_contents(base_path('tests/paste/fixtures/clipboard/springer-footnotes.html'));

    expect(app(CrossrefChooserResolver::class)->target('https://link.springer.com/article/x', $article))->toBeNull();
});

test('never fires on other walled pages (the JSTOR interstitial)', function () {
    $wall = file_get_contents(base_path('tests/paste/fixtures/walled/jstor-perimeterx-access-check.html'));

    expect(app(CrossrefChooserResolver::class)->target('https://www.jstor.org/stable/797212', $wall))->toBeNull();
});

test('a chooser listing only Crossref/doi.org chrome yields null, leaving the body gate in charge', function () {
    $html = <<<'HTML'
    <html><body>
      <a href="https://www.crossref.org/get-started/multiple-resolution/">multiple resolution</a>
      <div class="resource-line"><a href="https://doi.org/10.1332/x">doi</a></div>
      <div class="resource-line"><a href="https://api.crossref.org/works/10.1332/x">api</a></div>
    </body></html>
    HTML;

    expect(app(CrossrefChooserResolver::class)->target('https://chooser.crossref.org/?doi=10.1332/x', $html))->toBeNull();
});
