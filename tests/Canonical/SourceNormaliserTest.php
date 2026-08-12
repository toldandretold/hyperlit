<?php

/**
 * SourceNormaliser — raw OpenAlex /sources JSON → journal_sources column
 * shape. Pure, no HTTP/DB. Locks the GSCJ-shaped null handling (small diamond
 * journals routinely carry null host_organization_name / homepage_url /
 * apc_usd) and the id-prefix stripping.
 */

use App\Services\OpenAlex\SourceNormaliser;

function rawOpenAlexSource(array $overrides = []): array
{
    return array_merge([
        'id'                     => 'https://openalex.org/S4387280908',
        'display_name'           => 'Global Social Challenges Journal',
        'issn_l'                 => '2752-3349',
        'issn'                   => ['2752-3349'],
        'is_oa'                  => true,
        'is_in_doaj'             => true,
        'apc_usd'                => null,
        'works_count'            => 107,
        'cited_by_count'         => 613,
        'summary_stats'          => ['2yr_mean_citedness' => 1.2345, 'h_index' => 9],
        'country_code'           => 'GB',
        'homepage_url'           => null,
        'host_organization_name' => null,
        'topics'                 => [],
    ], $overrides);
}

test('normalises a GSCJ-shaped source (nulls preserved, prefix stripped)', function () {
    $n = (new SourceNormaliser())->normaliseSource(rawOpenAlexSource());

    expect($n['openalex_source_id'])->toBe('S4387280908');
    expect($n['issn_l'])->toBe('2752-3349');
    expect($n['issns'])->toBe(['2752-3349']);
    expect($n['display_name'])->toBe('Global Social Challenges Journal');
    expect($n['publisher'])->toBeNull();
    expect($n['homepage_url'])->toBeNull();
    expect($n['apc_usd'])->toBeNull();
    expect($n['is_oa'])->toBeTrue();
    expect($n['is_in_doaj'])->toBeTrue();
    expect($n['works_count'])->toBe(107);
    expect($n['cited_by_count'])->toBe(613);
    expect($n['two_year_mean_citedness'])->toBe(1.2345);
    expect($n['country_code'])->toBe('GB');
    expect($n['topics'])->toBe([]);
});

test('trims topics to the top 5 with bare ids', function () {
    $topics = [];
    for ($i = 1; $i <= 8; $i++) {
        $topics[] = ['id' => "https://openalex.org/T1000{$i}", 'display_name' => "Topic {$i}", 'score' => 1];
    }

    $n = (new SourceNormaliser())->normaliseSource(rawOpenAlexSource(['topics' => $topics]));

    expect($n['topics'])->toHaveCount(5);
    expect($n['topics'][0])->toBe(['id' => 'T10001', 'display_name' => 'Topic 1']);
});

test('missing optional fields become nulls, not errors', function () {
    $n = (new SourceNormaliser())->normaliseSource([
        'id'           => 'https://openalex.org/S123',
        'display_name' => 'Sparse Journal',
    ]);

    expect($n['openalex_source_id'])->toBe('S123');
    expect($n['issn_l'])->toBeNull();
    expect($n['issns'])->toBe([]);
    expect($n['two_year_mean_citedness'])->toBeNull();
    expect($n['works_count'])->toBeNull();
});
