<?php

/**
 * The corpus flow figure's one load-bearing property: COUNTS ARE CONSERVED. Every adjacent-column
 * link set must sum to the row count, and every node's inbound ribbons must sum to its own count
 * — that conservation is what makes the figure checkable against summary.md instead of an
 * illustration of it. A Sankey that leaks rows lies with confidence.
 */

use App\Services\CitationStudy\CorpusFlowFigure;

function flowRow(array $overrides = []): array
{
    return array_merge([
        'match_method' => 'openalex',
        'source_found' => 1,
        'verdict'      => 'likely',
        'human_label'  => 'verified_intact',
        'gt_label'     => 'intact',
    ], $overrides);
}

test('counts conserve: every link column sums to the row total, every node to its ribbons', function () {
    $rows = [
        flowRow(),
        flowRow(['match_method' => 'web_fetch', 'verdict' => 'confirmed']),
        flowRow(['match_method' => null, 'source_found' => 0, 'verdict' => 'source_not_found', 'human_label' => '']),
        flowRow(['match_method' => 'brave_search', 'verdict' => 'insufficient', 'human_label' => '', 'gt_label' => '']),
    ];

    $flow = (new CorpusFlowFigure())->build($rows);

    expect($flow['total'])->toBe(4);
    foreach ($flow['links'] as $key => $pairs) {
        expect(array_sum($pairs))->toBe(4, "link column {$key} leaked rows");
    }
    foreach ($flow['columns'] as $column => $counts) {
        expect(array_sum($counts))->toBe(4, "column {$column} leaked rows");
    }

    // Node count = sum of its inbound ribbons (spot-check the verdict column).
    $inbound = [];
    foreach ($flow['links']['source→verdict'] as $pair => $count) {
        $inbound[explode('→', $pair)[1]] = ($inbound[explode('→', $pair)[1]] ?? 0) + $count;
    }
    expect($inbound)->toBe($flow['columns']['verdict']);
});

test('resolution routes group to figure granularity and the human column falls back honestly', function () {
    $flow = (new CorpusFlowFigure())->build([
        flowRow(['match_method' => 'semantic_scholar']),
        flowRow(['match_method' => 'openalex_referenced']),
        flowRow(['match_method' => 'local_doi']),
        flowRow(['match_method' => null, 'human_label' => '', 'gt_label' => 'intact']),
        flowRow(['match_method' => null, 'human_label' => '', 'gt_label' => '']),
    ]);

    expect($flow['columns']['resolution']['index search'])->toBe(2)
        ->and($flow['columns']['resolution']['identifier (DOI)'])->toBe(1)
        ->and($flow['columns']['resolution']['not resolved'])->toBe(2)
        // human_label wins; gt_label is the fallback; absence is named, never blank.
        ->and($flow['columns']['human']['intact'])->toBe(1)
        ->and($flow['columns']['human']['unadjudicated'])->toBe(1);
});

test('the SVG carries every node label and its count, and each ribbon a title', function () {
    $figure = new CorpusFlowFigure();
    $svg = $figure->toSvg($figure->build([flowRow(), flowRow(['verdict' => 'confirmed'])]));

    expect($svg)->toContain('index search')
        ->and($svg)->toContain('source found')
        ->and($svg)->toContain('<title>')                 // ribbons are hoverable, from→to: n
        ->and(substr_count($svg, '<rect'))->toBeGreaterThan(4)
        ->and($svg)->toContain('HOW IT RESOLVED');
});

test('the HTML page is self-contained and states the conservation guarantee', function () {
    $figure = new CorpusFlowFigure();
    $html = $figure->toHtml($figure->build([flowRow()]), 'phase2-pathways', 'run_x');

    expect($html)->toContain('<svg')
        ->and($html)->toContain('checkable against summary.md')
        // No external FETCH vectors (the SVG xmlns is a namespace identifier, not a request).
        ->and($html)->not->toContain('src=')
        ->and($html)->not->toContain('<link')
        ->and($html)->not->toContain('@import')
        ->and($html)->toContain('run run_x');
});
