<?php

/**
 * OaLocationResolver — the ranked open-access candidate aggregator that lets
 * the fetch ladder try a clean repository copy before a Cloudflare-walled
 * publisher one. Ranking + dedupe are the value; assembly from OpenAlex
 * locations[] is covered with Http faked. No network.
 */

use App\Services\SourceImport\Content\OaLocationResolver;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

uses(TestCase::class);

$resolver = fn () => app(OaLocationResolver::class);

test('ranks repository copies ahead of publisher copies, PDFs before landings', function () use ($resolver) {
    $raw = [
        ['pdf_url' => 'https://direct.mit.edu/article.pdf', 'landing_page_url' => null, 'host_type' => 'publisher', 'source' => 'openalex'],
        ['pdf_url' => null, 'landing_page_url' => 'https://repository.university.edu/handle/123', 'host_type' => 'repository', 'source' => 'unpaywall'],
        ['pdf_url' => 'https://arxiv.org/pdf/2101.00001', 'landing_page_url' => null, 'host_type' => null, 'source' => 'openalex'],
    ];

    $ranked = $resolver()->rankAndDedupe($raw);
    $hosts = array_column($ranked, 'host');

    // arxiv (repository, pdf) first; then the repository landing; publisher last.
    expect($hosts[0])->toBe('arxiv.org');
    expect($ranked[0]['host_class'])->toBe('repository');
    expect(end($hosts))->toBe('direct.mit.edu');
    expect($ranked[array_key_last($ranked)]['host_class'])->toBe('publisher');
});

test('dedupes the same URL reaching from multiple sources', function () use ($resolver) {
    $raw = [
        ['pdf_url' => 'https://arxiv.org/pdf/2101.00001', 'landing_page_url' => null, 'host_type' => null, 'source' => 'openalex'],
        ['pdf_url' => 'https://arxiv.org/pdf/2101.00001/', 'landing_page_url' => null, 'host_type' => null, 'source' => 'unpaywall'], // trailing slash
    ];
    expect($resolver()->rankAndDedupe($raw))->toHaveCount(1);
});

test('classifies known clean hosts as repository and .edu DSpace too', function () use ($resolver) {
    $raw = [
        ['pdf_url' => 'https://europepmc.org/articles/PMC123/pdf', 'landing_page_url' => null, 'host_type' => null, 'source' => 'openalex'],
        ['pdf_url' => 'https://scholarworks.university.edu/bitstream/1/x.pdf', 'landing_page_url' => null, 'host_type' => null, 'source' => 'unpaywall'],
        ['pdf_url' => 'https://onlinelibrary.wiley.com/doi/pdf/10.1/x', 'landing_page_url' => null, 'host_type' => null, 'source' => 'crossref'],
    ];
    $ranked = collect($resolver()->rankAndDedupe($raw))->keyBy('host');
    expect($ranked['europepmc.org']['host_class'])->toBe('repository');
    expect($ranked['scholarworks.university.edu']['host_class'])->toBe('repository');
    expect($ranked['onlinelibrary.wiley.com']['host_class'])->toBe('publisher');
});

test('breaks ties by version (published>submitted) then license (CC>none) within a host class', function () use ($resolver) {
    // Two repository PDFs on equal-class hosts: the published + CC-BY copy must
    // outrank the submitted-preprint + no-license copy.
    $raw = [
        ['pdf_url' => 'https://repo-a.edu/preprint.pdf', 'landing_page_url' => null, 'host_type' => 'repository', 'version' => 'submittedVersion', 'license' => null, 'source' => 'openalex'],
        ['pdf_url' => 'https://repo-b.edu/published.pdf', 'landing_page_url' => null, 'host_type' => 'repository', 'version' => 'publishedVersion', 'license' => 'cc-by', 'source' => 'unpaywall'],
    ];
    $ranked = $resolver()->rankAndDedupe($raw);
    expect($ranked[0]['host'])->toBe('repo-b.edu');           // published + CC first
    expect($ranked[0]['version'])->toBe('publishedVersion');  // version carried through
    expect($ranked[0]['license'])->toBe('cc-by');             // license carried through
});

test('version/license tie-breaks never override the repository-before-publisher order', function () use ($resolver) {
    // A published+CC PUBLISHER copy must still rank BELOW a submitted+no-license
    // REPOSITORY copy — host class dominates (anti-Cloudflare) over the tie-breaks.
    $raw = [
        ['pdf_url' => 'https://direct.mit.edu/published.pdf', 'landing_page_url' => null, 'host_type' => 'journal', 'version' => 'publishedVersion', 'license' => 'cc-by', 'source' => 'openalex'],
        ['pdf_url' => 'https://arxiv.org/pdf/2101.00001', 'landing_page_url' => null, 'host_type' => null, 'version' => 'submittedVersion', 'license' => null, 'source' => 'openalex'],
    ];
    $ranked = $resolver()->rankAndDedupe($raw);
    expect($ranked[0]['host'])->toBe('arxiv.org');          // repository still first
    expect($ranked[array_key_last($ranked)]['host'])->toBe('direct.mit.edu');
});

test('resolve() gathers OpenAlex locations[] and ranks green copies first', function () use ($resolver) {
    Http::fake([
        'api.openalex.org/works/W555*' => Http::response([
            'id'    => 'https://openalex.org/W555',
            'title' => 'Test Work',
            'locations' => [
                ['is_oa' => true, 'pdf_url' => 'https://direct.mit.edu/x.pdf', 'landing_page_url' => null, 'source' => ['type' => 'journal']],
                ['is_oa' => true, 'pdf_url' => 'https://zenodo.org/record/1/files/x.pdf', 'landing_page_url' => null, 'source' => ['type' => 'repository']],
                ['is_oa' => false, 'pdf_url' => 'https://paywalled.com/x.pdf', 'landing_page_url' => null], // not OA → dropped
            ],
        ]),
    ]);

    // openalex_id set, NO doi → only the OpenAlex path runs (no S2/Unpaywall/Crossref).
    $record = (object) ['book' => 'b1', 'doi' => null, 'openalex_id' => 'W555', 'pdf_url' => null, 'oa_url' => null];
    $ranked = $resolver()->resolve($record);
    $hosts = array_column($ranked, 'host');

    expect($hosts)->toContain('zenodo.org');
    expect($hosts)->toContain('direct.mit.edu');
    expect($hosts)->not->toContain('paywalled.com'); // is_oa=false dropped
    expect($hosts[0])->toBe('zenodo.org');            // repository ranked first
});
