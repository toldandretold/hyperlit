<?php

/**
 * LandingPagePdfLocator — pulls the real PDF off a repository / handle /
 * article landing page so it goes down the OCR lane instead of the unverified
 * HTML lane. Extraction from canned HTML; no network.
 */

use App\Services\SourceImport\Content\LandingPagePdfLocator;
use Tests\TestCase;

uses(TestCase::class);

$loc = fn () => app(LandingPagePdfLocator::class);

test('extracts the citation_pdf_url meta tag (absolute)', function () use ($loc) {
    $html = '<head><meta name="citation_pdf_url" content="https://repo.edu/bitstream/1/paper.pdf"></head>';
    expect($loc()->extractFromHtml($html, 'https://repo.edu/handle/1'))
        ->toBe('https://repo.edu/bitstream/1/paper.pdf');
});

test('handles content-before-name meta attribute order', function () use ($loc) {
    $html = '<meta content="https://repo.edu/x.pdf" name="citation_pdf_url" />';
    expect($loc()->extractFromHtml($html, 'https://repo.edu/handle/1'))
        ->toBe('https://repo.edu/x.pdf');
});

test('resolves a relative citation_pdf_url against the landing URL', function () use ($loc) {
    $html = '<meta name="citation_pdf_url" content="/bitstream/1/paper.pdf">';
    expect($loc()->extractFromHtml($html, 'https://repo.edu/handle/1?show=full'))
        ->toBe('https://repo.edu/bitstream/1/paper.pdf');
});

test('falls back to a DSpace bitstream .pdf anchor when no meta tag', function () use ($loc) {
    $html = '<a href="/handle/1/full">Full record</a> <a href="/bitstream/1/2/thesis.pdf">PDF</a>';
    expect($loc()->extractFromHtml($html, 'https://dspace.university.edu/handle/1'))
        ->toBe('https://dspace.university.edu/bitstream/1/2/thesis.pdf');
});

test('prefers a bitstream PDF over an unrelated .pdf link', function () use ($loc) {
    $html = '<a href="/assets/logo.pdf">logo</a> <a href="/bitstream/9/article.pdf">Download</a>';
    expect($loc()->extractFromHtml($html, 'https://repo.edu/handle/9'))
        ->toContain('/bitstream/9/article.pdf');
});

test('returns null when no PDF is discoverable', function () use ($loc) {
    $html = '<html><body><p>Abstract only, no full text.</p></body></html>';
    expect($loc()->extractFromHtml($html, 'https://repo.edu/handle/1'))->toBeNull();
});
