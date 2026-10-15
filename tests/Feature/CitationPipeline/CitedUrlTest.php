<?php

/**
 * The printed-URL derivation is multi-work aware: a footnote's content holds
 * EVERY work's URL, so extractUrl(content) returns the FIRST one whatever work
 * the pool item represents — which is how deloitte c09's IIA sub fetched work
 * 1's finance.gov.au page, minted the wrong-work stub and reported "matched"
 * while its own live PDF URL was never requested.
 */

use App\Services\CitationPipeline\Resolution\CitedUrl;

const CU_CONTENT = '<p>Department of Finance (Cth), Risk Management Toolkit (Web Page, 2023) '
    . 'https://www.finance.gov.au/government/comcover/risk-management-toolkit ; Institute of Internal Auditors, '
    . 'The IIA’s Three Lines Model (Position Paper, July 2020). '
    . 'https://www.theiia.org/globalassets/documents/three-lines-model-updated-english.pdf.</p>';

it('gives a sub ONLY its own work’s url — never the footnote’s first', function () {
    $sub = [
        'parentRefId' => 'fn9',
        'content' => CU_CONTENT,
        'llmMetadata' => ['url' => 'https://www.theiia.org/globalassets/documents/three-lines-model-updated-english.pdf'],
    ];
    expect(CitedUrl::printed($sub))->toBe([
        'url' => 'https://www.theiia.org/globalassets/documents/three-lines-model-updated-english.pdf',
        'from' => 'llm',
    ]);

    // Extraction captured no url for the sub: NO fetch, rather than the wrong one.
    $sub['llmMetadata'] = [];
    expect(CitedUrl::printed($sub))->toBeNull();
});

it('a multi-work parent prefers its own work’s url, falling back to the content’s first', function () {
    $parent = [
        'content' => CU_CONTENT,
        'llmMetadata' => [
            'url' => 'https://www.finance.gov.au/government/comcover/risk-management-toolkit',
            'sub_citations' => [['title' => 'Three Lines Model']],
        ],
    ];
    expect(CitedUrl::printed($parent)['from'])->toBe('llm');

    unset($parent['llmMetadata']['url']);
    $fallback = CitedUrl::printed($parent);
    expect($fallback['from'])->toBe('content')
        ->and($fallback['url'])->toContain('finance.gov.au');
});

it('a single-work entry keeps the historical order: content outranks the extraction', function () {
    $single = [
        'content' => '<p>Some Report (2020) https://example.org/report.pdf</p>',
        'llmMetadata' => ['url' => 'https://example.org/WRONG'],
    ];
    expect(CitedUrl::printed($single)['from'])->toBe('content');
});

it('repairs OCR protocol typos and refuses non-http schemes', function () {
    $sub = ['parentRefId' => 'p', 'content' => '', 'llmMetadata' => ['url' => 'htts://example.org/x']];
    expect(CitedUrl::printed($sub)['url'])->toBe('https://example.org/x');

    $sub['llmMetadata']['url'] = 'ftp://example.org/x';
    expect(CitedUrl::printed($sub))->toBeNull();
});
