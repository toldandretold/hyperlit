<?php

/**
 * Two ways a footnote with a perfectly good URL ended up unreviewed, both found on
 * deloitte-2025-pdf (2026-09-26).
 *
 * 1. THE TYPE VOCABULARY DID NOT MATCH THE PROMPT. `LlmService` asks the model for
 *    "…|report|news-article|archival-source|youtube-video|website|…" and
 *    `CitationScanBibliographyJob::CITABLE_TYPES` answered with `web_page` — a string the
 *    prompt never emits. Anything the model called a website, a news article, an archival
 *    source or a cited video was therefore classified `is_citation = false` and dropped from
 *    resolution entirely: never searched, never fetched, never reviewed. Measured across every
 *    book in the database: 37 `website` footnotes, 34 classified not-a-citation, and ALL 34
 *    carried a live URL.
 *
 * 2. A TITLE SEARCH COULD OVERRULE THE PRINTED URL. The citation prints
 *    "https://guides.dss.gov.au/social-security-guide"; that host returns 403 to us, so Brave
 *    was asked for the title and returned
 *    "hamiltonfinancialplanning.com/blog/2025-social-security-guide/" — a US financial-planning
 *    blog whose page title matches almost word for word, far above the 0.3 floor. It was
 *    fetched and 12,514 characters of it stored as the source for an Australian welfare-law
 *    citation. A source swap the resolver manufactured, which is the one failure citation
 *    review exists to catch.
 */

use App\Jobs\CitationScanBibliographyJob;
use App\Services\BraveSearchService;

function citableTypes(): array
{
    $ref = new ReflectionClass(CitationScanBibliographyJob::class);
    return $ref->getConstant('CITABLE_TYPES');
}

function hostAgrees(?string $citedUrl, string $candidate): bool
{
    $method = new ReflectionMethod(BraveSearchService::class, 'hostAgreesWithCitedUrl');
    $method->setAccessible(true);
    return $method->invoke(app(BraveSearchService::class), $citedUrl, $candidate);
}

// ── 1. The type vocabulary ───────────────────────────────────────────────────

test('every citable type the extraction prompt can emit is accepted as a citation', function () {
    // Read the vocabulary out of the PROMPT rather than restating it, so the two cannot
    // drift apart again — that drift is the entire bug.
    $source = (string) file_get_contents(
        (new ReflectionClass(\App\Services\LlmService::class))->getFileName()
    );
    $citable = citableTypes();

    // Types the prompt offers that are genuine WORKS, as opposed to apparatus the pipeline
    // routes elsewhere (short-form/ibid/pointer/legislation/case-law) or non-citations
    // (commentary/other). Each is asserted to be BOTH still offered by the prompt and
    // accepted here, so the two cannot drift apart again — that drift is the entire bug.
    $works = ['book', 'journal-article', 'book-chapter', 'conference-paper', 'thesis',
              'report', 'news-article', 'archival-source', 'youtube-video', 'website'];
    $offered = array_values(array_filter($works, fn ($t) => str_contains($source, '|' . $t . '|')
        || str_contains($source, '"' . $t . '|')));
    expect($offered)->not->toBeEmpty();

    $missing = array_values(array_diff($offered, $citable));
    expect($missing)->toBe([]);
});

test('a discursive footnote is still not a citation', function () {
    expect(citableTypes())->not->toContain('commentary')
        ->and(citableTypes())->not->toContain('other');
});

// ── 2. The printed URL outranks a title match ────────────────────────────────

test('a search hit on a different host is refused when the citation prints a URL', function () {
    expect(hostAgrees(
        'https://guides.dss.gov.au/social-security-guide',
        'https://hamiltonfinancialplanning.com/blog/2025-social-security-guide/'
    ))->toBeFalse();
});

test('the same host is accepted, ignoring www', function () {
    expect(hostAgrees('https://www.dewr.gov.au/a/b', 'https://dewr.gov.au/a/b'))->toBeTrue();
});

test('a subdomain of the cited host is accepted', function () {
    // Publishers move a work between the bare domain and a section subdomain.
    expect(hostAgrees('https://dss.gov.au/guide', 'https://guides.dss.gov.au/guide'))->toBeTrue()
        ->and(hostAgrees('https://guides.dss.gov.au/guide', 'https://dss.gov.au/guide'))->toBeTrue();
});

test('a citation with no printed URL is unaffected — the title match is all there is', function () {
    expect(hostAgrees(null, 'https://anything.example/whatever'))->toBeTrue()
        ->and(hostAgrees('', 'https://anything.example/whatever'))->toBeTrue();
});

test('an unparseable cited URL does not block a search hit', function () {
    expect(hostAgrees('not a url at all', 'https://example.org/x'))->toBeTrue();
});
