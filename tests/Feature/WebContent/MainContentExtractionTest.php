<?php

/**
 * Main-content extraction for citation resolution.
 *
 * The bug these lock: the resolver used to reduce a fetched page with a regex
 * strip of seven tags plus strip_tags(), which keeps every nav list, ad slot and
 * "related articles" rail that is not inside a literal <nav>. On the real
 * scroll.in page below that produced 17,820 characters whose FIRST 1,500 were
 * the site's trending-headlines rail — and the first 1,500 characters are
 * exactly what the relevance screen is shown. A genuine article was thrown away
 * as a cookie wall, and when a page did pass, the rail was in the body the
 * passage search then searched.
 *
 * Fixtures are REAL captures (see tests/webcontent/fixtures/), because the whole
 * failure mode was about the shape of real publisher furniture — a synthetic
 * page with one <nav> would have "passed" under the old code too.
 */

use App\Services\SourceImport\Content\BodyPresenceAssessor;
use App\Services\WebContent\MainContentExtractor;

function fixture(string $name): string
{
    return file_get_contents(base_path("tests/webcontent/fixtures/{$name}"));
}

test('a news article is extracted from under its own trending rail', function () {
    $result = app(MainContentExtractor::class)->extract(fixture('news-with-trending-rail.html'));

    // The article's first sentence must be FIRST. This is the assertion that
    // matters: the relevance screen and the passage search both read from the
    // top, so an article buried under a headline rail is an article we lose.
    expect($result['text'])->toStartWith('On the night of June 5, a 16-year-old from Kolhapur');

    // And the rail itself must be gone — those headlines are other stories, and
    // as "source text" they let the reviewer cite an unrelated article.
    expect($result['text'])->not->toContain('Preity Zinta, Pankaj Tripathi among new members');

    expect($result['chars'])->toBeGreaterThan(5000)
        ->and($result['floor'])->toBe(MainContentExtractor::PROSE_CHAR_FLOOR);
});

test('a long-form review is extracted whole', function () {
    $result = app(MainContentExtractor::class)->extract(fixture('news-review-article.html'));

    expect($result['chars'])->toBeGreaterThan(4000)
        ->and($result['blocks'])->not->toBeEmpty();
});

test('a JS shell yields NOTHING rather than its boilerplate', function () {
    // thewire.in serves 11KB of app shell. The honest answer is "we did not get
    // the article" — which is what makes the caller escalate to the browser.
    // Returning the shell's 126 characters of nav instead is how a live source
    // became a confident verdict about a page we never read.
    $result = app(MainContentExtractor::class)->extract(fixture('js-shell.html'));

    expect($result['chars'])->toBe(0)
        ->and($result['text'])->toBe('')
        ->and($result['blocks'])->toBe([]);
});

test('a Cloudflare interstitial yields nothing', function () {
    $result = app(MainContentExtractor::class)->extract(fixture('cloudflare-interstitial.html'));

    expect($result['chars'])->toBe(0);
});

test('paragraphs are separated by blank lines, not collapsed to spaces', function () {
    // Not cosmetic. WebFetchService::chunkText splits on /\n\n+/ first and falls
    // back to blind 500-char cuts; the old extraction collapsed ALL whitespace
    // to single spaces, so that paragraph split could never fire and every web
    // stub was chunked mid-sentence.
    $result = app(MainContentExtractor::class)->extract(fixture('news-with-trending-rail.html'));

    expect($result['text'])->toContain("\n\n")
        ->and(count($result['blocks']))->toBeGreaterThan(1);
});

test('the extractor and the body assessor agree about what a paragraph is', function () {
    // Both must use the same floor, or a page can extract text the gate then
    // calls absent (or worse, the reverse).
    $result = app(MainContentExtractor::class)->extract(fixture('news-with-trending-rail.html'));
    $verdict = app(BodyPresenceAssessor::class)->assessBlocks($result['blocks'], BodyPresenceAssessor::PROFILE_WEB);

    expect($verdict['verdict'])->toBe(BodyPresenceAssessor::PRESENT);
});
