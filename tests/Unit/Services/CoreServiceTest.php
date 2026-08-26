<?php

/**
 * CoreService — the CORE (core.ac.uk) OA-candidate lookup that feeds
 * OaLocationResolver. Contract under test: POST search-by-DOI (their GET
 * breaks on quoted phrases), keyless → silent skip, CORE's own cached
 * downloadUrl surfaces as a repository-class PDF, and source URLs pass
 * through for the resolver to classify. Http faked — no network.
 */

use App\Services\CoreService;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

uses(TestCase::class);

test('returns nothing without an API key configured', function () {
    config(['services.core.api_key' => null]);
    Http::fake(); // any request at all would be a violation
    expect(app(CoreService::class)->oaLocations('10.1000/xyz'))->toBe([]);
    Http::assertNothingSent();
});

test('surfaces the CORE cache PDF as repository-class and source URLs for classification', function () {
    config(['services.core.api_key' => 'test-key']);
    Http::fake([
        'api.core.ac.uk/v3/search/outputs' => Http::response([
            'totalHits' => 1,
            'results'   => [[
                'id'                 => 478114759,
                'downloadUrl'        => 'https://core.ac.uk/download/478114759.pdf',
                'license'            => 'cc-by',
                'sourceFulltextUrls' => [
                    'https://library.oapen.org/bitstream/20.500.12657/30318/1/646692.pdf',
                    'https://directory.doabooks.org/handle/20.500.12854/31536',
                    'not-a-url',
                ],
            ]],
        ]),
    ]);

    $locations = app(CoreService::class)->oaLocations('10.11647/OBP.0001');

    expect($locations)->toHaveCount(3); // cache PDF + 2 sane source URLs; junk dropped
    expect($locations[0]['pdf_url'])->toBe('https://core.ac.uk/download/478114759.pdf');
    expect($locations[0]['host_type'])->toBe('repository'); // CORE's own cache is never walled
    expect($locations[0]['license'])->toBe('cc-by');
    expect($locations[1]['pdf_url'])->toContain('oapen.org');       // .pdf source → pdf candidate
    expect($locations[2]['landing_page_url'])->toContain('doabooks.org'); // non-pdf source → landing

    Http::assertSent(function ($request) {
        return $request->method() === 'POST' // GET quoted-phrase search 500s on their backend
            && $request['q'] === 'doi:"10.11647/OBP.0001"'
            && $request->hasHeader('Authorization', 'Bearer test-key');
    });
});

test('a record with no downloadUrl still contributes its source URLs', function () {
    config(['services.core.api_key' => 'test-key']);
    Http::fake([
        'api.core.ac.uk/v3/search/outputs' => Http::response([
            'totalHits' => 1,
            'results'   => [[
                'downloadUrl'        => '', // metadata-only CORE record
                'sourceFulltextUrls' => ['https://repository.example.edu/bitstream/1/paper.pdf'],
            ]],
        ]),
    ]);

    $locations = app(CoreService::class)->oaLocations('10.1000/meta-only');
    expect($locations)->toHaveCount(1);
    expect($locations[0]['pdf_url'])->toBe('https://repository.example.edu/bitstream/1/paper.pdf');
    expect($locations[0]['host_type'])->toBeNull(); // resolver classifies source hosts itself
});

test('API errors and transient failures degrade to an empty list', function () {
    config(['services.core.api_key' => 'test-key']);
    Http::fake([
        'api.core.ac.uk/v3/search/outputs' => Http::response(['message' => 'Azure search failed'], 500),
    ]);
    expect(app(CoreService::class)->oaLocations('10.1000/err'))->toBe([]);
});
