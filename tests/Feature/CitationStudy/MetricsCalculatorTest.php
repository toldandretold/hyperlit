<?php

/**
 * Locks the metric math the paper's numbers depend on: confusion matrices at
 * every ordinal cutoff, the source-not-found channel flagging at all cutoffs,
 * insufficient rows excluded from the binary, missing rows counted as misses,
 * pre/post rejection-upgrade recovery, and the Wilson interval.
 */

use App\Services\CitationStudy\ClaimsJoiner;
use App\Services\CitationStudy\MetricsCalculator;

function metricsRow(string $label, string $verdict, array $extra = []): array
{
    return array_merge([
        'corpus' => 'unit', 'run_id' => 'r1', 'book_id' => 'study_unit_b1', 'slug' => 'b1',
        'arm' => 'synthetic', 'gt_id' => uniqid('gt'), 'gt_label' => $label,
        'corruption_type' => null, 'expected_detection' => null,
        'referenceId' => 'ref', 'node_id' => 'n', 'citation_row' => 'bibliography',
        'verdict' => $verdict, 'verdict_pre_upgrade' => $verdict, 'was_upgraded' => false,
        'source_found' => $verdict !== 'source_not_found', 'evidence_type' => 'abstract_and_passages',
        'verification_tier' => 'canonical', 'web_status' => null, 'match_method' => 'doi',
        'match_score' => 0.9, 'source_completeness' => null, 'truth_claim_chars' => 100,
        'source_material_chars' => 1000, 'has_highlight' => true, 'verdict_summary' => null,
        'pipeline_id' => null, 'claims_in_book' => 10,
        'book_review_seconds' => 100, 'book_total_seconds' => 200, 'book_wall_seconds' => 210,
        'book_cost_usd' => 0.5, 'book_prompt_tokens' => 1000, 'book_completion_tokens' => 100,
        'book_ocr_pages' => null, 'cost_per_citation' => 0.05, 'contaminated' => false,
    ], $extra);
}

test('confusion matrices at every cutoff match hand-computed values', function () {
    // Positives: 3 fabricated (2 source_not_found, 1 confirmed=missed),
    //            2 swaps (1 rejected, 1 plausible), 1 distortion (unlikely).
    // Negatives: 4 intact (confirmed, likely, plausible, rejected).
    $rows = [
        metricsRow('fabricated_reference', 'source_not_found'),
        metricsRow('fabricated_reference', 'source_not_found'),
        metricsRow('fabricated_reference', 'confirmed'),
        metricsRow('source_swap', 'rejected'),
        metricsRow('source_swap', 'plausible'),
        metricsRow('claim_distortion', 'unlikely'),
        metricsRow('intact', 'confirmed'),
        metricsRow('intact', 'likely'),
        metricsRow('intact', 'plausible'),
        metricsRow('intact', 'rejected'),
    ];

    $metrics = (new MetricsCalculator())->cutoffMetrics($rows, 'verdict');

    // Cutoff 'rejected': flagged = {rejected} + source_not_found.
    expect($metrics['rejected'])->toMatchArray(['tp' => 3, 'fn' => 3, 'fp' => 1, 'tn' => 3]);
    // Cutoff 'unlikely': + unlikely.
    expect($metrics['unlikely'])->toMatchArray(['tp' => 4, 'fn' => 2, 'fp' => 1, 'tn' => 3]);
    // Cutoff 'plausible': + plausible.
    expect($metrics['plausible'])->toMatchArray(['tp' => 5, 'fn' => 1, 'fp' => 2, 'tn' => 2]);
    // Cutoff 'likely': + likely.
    expect($metrics['likely'])->toMatchArray(['tp' => 5, 'fn' => 1, 'fp' => 3, 'tn' => 1]);

    expect($metrics['unlikely']['sensitivity'])->toBe(round(4 / 6, 4))
        ->and($metrics['unlikely']['specificity'])->toBe(0.75)
        ->and($metrics['unlikely']['precision'])->toBe(0.8);
});

test('insufficient rows are excluded from the binary and missing rows count as misses', function () {
    $rows = [
        metricsRow('fabricated_reference', 'insufficient'),
        metricsRow('fabricated_reference', 'not_detected_missing'),
        metricsRow('fabricated_reference', 'rejected'),
        metricsRow('intact', 'insufficient'),
        metricsRow('intact', 'confirmed'),
    ];

    $m = (new MetricsCalculator())->cutoffMetrics($rows, 'verdict')['unlikely'];
    expect($m)->toMatchArray(['tp' => 1, 'fn' => 1, 'fp' => 0, 'tn' => 1, 'excluded_insufficient' => 2]);
});

test('suspect and unverifiable labels stay out of the binary', function () {
    $rows = [
        metricsRow('suspect', 'rejected'),
        metricsRow('unverifiable', 'confirmed'),
        metricsRow('intact', 'confirmed'),
    ];
    $m = (new MetricsCalculator())->cutoffMetrics($rows, 'verdict')['rejected'];
    expect($m)->toMatchArray(['tp' => 0, 'fn' => 0, 'fp' => 0, 'tn' => 1]);
});

test('pre-upgrade metrics recover the rejected verdict the upgrade pass overwrote', function () {
    $rows = [
        metricsRow('claim_distortion', 'unlikely', ['verdict_pre_upgrade' => 'rejected', 'was_upgraded' => true]),
        metricsRow('intact', 'likely'),
    ];
    $calc = new MetricsCalculator();

    $post = $calc->cutoffMetrics($rows, 'verdict')['rejected'];
    $pre = $calc->cutoffMetrics($rows, 'verdict_pre_upgrade')['rejected'];

    expect($post['tp'])->toBe(0)->and($pre['tp'])->toBe(1);

    $summary = $calc->summarise($rows);
    expect($summary['upgrades']['total'])->toBe(1)
        ->and($summary['upgrades']['by_label'])->toBe(['claim_distortion' => 1]);
});

test('detection channels split source-not-found from verdict catches', function () {
    $rows = [
        metricsRow('fabricated_reference', 'source_not_found'),
        metricsRow('source_swap', 'rejected'),
        metricsRow('claim_distortion', 'confirmed'),
        metricsRow('fabricated_reference', 'insufficient'),
        metricsRow('intact', 'rejected'), // negative — not counted in channels
    ];
    $summary = (new MetricsCalculator())->summarise($rows);
    expect($summary['detection_channels'])->toBe([
        'source_not_found' => 1, 'verdict' => 1, 'missed' => 1, 'excluded_insufficient' => 1,
    ]);
});

test('cohen kappa matches hand-computed values', function () {
    $calc = new MetricsCalculator();
    // Perfect agreement.
    expect($calc->cohenKappa(['a', 'b', 'a'], ['a', 'b', 'a']))->toBe(1.0);
    // 6/10 observed agreement with 5/5 marginals both sides:
    // po=0.6, pe=0.5 → kappa = (0.6-0.5)/0.5 = 0.2.
    $a = array_merge(array_fill(0, 5, 'yes'), array_fill(0, 5, 'no'));
    $b = ['yes', 'yes', 'yes', 'no', 'no', 'no', 'no', 'no', 'yes', 'yes'];
    expect($calc->cohenKappa($a, $b))->toBe(0.2);
    // Undefined on empty input.
    expect($calc->cohenKappa([], []))->toBeNull();
});

test('wilson interval matches a known value', function () {
    // 8/10 successes: Wilson 95% CI ≈ [0.4902, 0.9433].
    [$lo, $hi] = (new MetricsCalculator())->wilson(8, 10);
    expect($lo)->toEqualWithDelta(0.4902, 0.001)
        ->and($hi)->toEqualWithDelta(0.9433, 0.001);
});

test('the upgrade marker constant matches the literal in ClaimVerifier', function () {
    $source = file_get_contents(app_path('Services/CitationReview/Phases/ClaimVerifier.php'));
    $needle = trim(ClaimsJoiner::UPGRADE_MARKER);
    expect(str_contains($source, $needle))->toBeTrue(
        'ClaimVerifier no longer contains the upgrade-marker literal ClaimsJoiner greps for — '
        . 'pre-upgrade verdict recovery in the study dataset would silently break.'
    );
});
