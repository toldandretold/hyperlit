<?php

/**
 * WorksApi referenced-works methods — the OpenAlex citation-graph seam behind
 * the scan job's Wave 3.5 closed-pool matching (and the harvester's network
 * telemetry). All HTTP is faked; locks the id-normalisation (URL → bare id),
 * the 50-id batch chunking, and the fail-soft empty results.
 */

use App\Services\OpenAlexService;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

uses(TestCase::class);

$svc = fn () => app(OpenAlexService::class);

test('fetchReferencedWorkIds strips the openalex.org url prefix to bare ids', function () use ($svc) {
    Http::fake([
        'api.openalex.org/works/W1000*' => Http::response([
            'referenced_works' => [
                'https://openalex.org/W2126853606',
                'https://openalex.org/W1234567890',
            ],
        ]),
    ]);

    expect($svc()->fetchReferencedWorkIds('W1000'))
        ->toBe(['W2126853606', 'W1234567890']);
});

test('fetchReferencedWorkIds is fail-soft: empty on API failure and on missing data', function () use ($svc) {
    Http::fake(['api.openalex.org/works/W404*' => Http::response(null, 500)]);
    expect($svc()->fetchReferencedWorkIds('W404'))->toBe([]);

    Http::fake(['api.openalex.org/works/W2000*' => Http::response(['referenced_works' => []])]);
    expect($svc()->fetchReferencedWorkIds('W2000'))->toBe([]);
});

test('fetchByIdsBatch chunks ids into 50-per-request ids.openalex filters and normalises results', function () use ($svc) {
    $ids = array_map(fn ($i) => "W{$i}", range(1, 60)); // 2 chunks: 50 + 10

    Http::fake([
        'api.openalex.org/works?*' => Http::response([
            'results' => [
                [
                    'id'    => 'https://openalex.org/W1',
                    'title' => 'Pooled Work',
                    'type'  => 'journal-article',
                ],
            ],
        ]),
    ]);

    $works = $svc()->fetchByIdsBatch($ids);

    // One normalised work per chunk response (the fake returns the same body twice)
    expect($works)->toHaveCount(2);
    expect($works[0]['openalex_id'])->toBe('W1');
    expect($works[0]['title'])->toBe('Pooled Work');
    expect($works[0]['source'])->toBe('openalex');

    // Both requests used the batch filter, split 50/10
    $filters = [];
    Http::assertSent(function ($request) use (&$filters) {
        $filters[] = $request->data()['filter'] ?? null;
        return true;
    });
    $filters = array_values(array_filter($filters));
    expect($filters)->toHaveCount(2);
    expect(substr_count($filters[0], '|'))->toBe(49);
    expect(substr_count($filters[1], '|'))->toBe(9);
    expect($filters[0])->toStartWith('ids.openalex:W1|');
});

test('fetchByIdsBatch dedupes input ids and returns empty for empty input', function () use ($svc) {
    expect($svc()->fetchByIdsBatch([]))->toBe([]);

    Http::fake(['api.openalex.org/works?*' => Http::response(['results' => []])]);
    $svc()->fetchByIdsBatch(['W1', 'W1', 'W1']);
    Http::assertSentCount(1);
});
