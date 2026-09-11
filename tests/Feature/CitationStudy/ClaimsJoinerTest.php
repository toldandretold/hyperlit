<?php

/**
 * The joiner's bidirectional discipline: snippet-level labels beat bib-level
 * labels, unmatched claims fall back to the book default, ground-truth
 * entries with expected occurrences but no claims row become
 * 'not_detected_missing' misses, and rejected→unlikely upgrades are
 * recovered from the reasoning marker.
 */

use App\Services\CitationStudy\ClaimsJoiner;
use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\GroundTruthText;
use Illuminate\Support\Facades\File;

const JOINER_ROOT = 'storage/framework/testing/citation-study-joiner';

function joinerCorpus(array $gtEntries, array $claims): array
{
    config(['study.root' => JOINER_ROOT]);
    $dir = base_path(JOINER_ROOT . '/corpora/jointest/sources/fixture');
    File::ensureDirectoryExists($dir);
    File::put($dir . '/original.md', "# stub\n");
    File::put(base_path(JOINER_ROOT . '/corpora/jointest/manifest.json'), json_encode([
        'corpus' => 'jointest',
        'books' => [[
            'slug' => 'fixture',
            'arm' => 'synthetic',
            'source_file' => 'sources/fixture/original.md',
            'corruption_spec' => 'sources/fixture/corruption.json',
            'ground_truth' => 'sources/fixture/ground_truth.json',
            'default_label' => 'intact',
        ]],
    ]));
    File::put($dir . '/corruption.json', json_encode(['seed' => 1]));
    File::put($dir . '/ground_truth.json', json_encode([
        'book' => 'fixture',
        'entries' => $gtEntries,
        'binding' => ['bound_at' => '2026-09-10T00:00:00Z', 'book_id' => 'study_jointest_fixture', 'unmatched' => []],
    ]));

    $claimsPath = base_path(JOINER_ROOT . '/fixture.claims.json');
    File::put($claimsPath, json_encode($claims));

    $state = ['corpus' => 'jointest', 'books' => ['fixture' => [
        'book_id' => 'study_jointest_fixture',
        'run_id' => 'run1',
        'status' => 'completed',
        'claims_file' => $claimsPath,
        'pipeline_id' => null,
    ]]];

    return [CorpusManifest::load('jointest'), $state];
}

function joinerGt(string $gtId, string $label, string $ref, ?string $snippet = null, int $occ = 1): array
{
    return [
        'gt_id' => $gtId, 'label' => $label,
        'bib_text_normalized' => 'irrelevant after binding', 'bib_text_hash' => 'sha256:x',
        'claim_snippet' => $snippet, 'cited_occurrences' => $occ,
        'expected_detection' => null, 'corruption_meta' => ['type' => $label === 'source_swap' ? 'source_swap' : null],
        'bound_reference_id' => $ref,
    ];
}

function joinerClaim(string $ref, string $support, array $extra = []): array
{
    return array_merge([
        'referenceId' => $ref,
        'node_id' => 'node1',
        'truth_claim' => 'A perfectly ordinary claim about outcomes.',
        'contextualised_claim' => '',
        'source_book_id' => 'realbook123',
        'citation_row' => 'bibliography',
        'evidence_type' => 'abstract_and_passages',
        'llm_verdict' => ['support' => $support, 'summary' => 's', 'reasoning' => 'r'],
    ], $extra);
}

afterEach(function () {
    File::deleteDirectory(base_path(JOINER_ROOT));
});

test('snippet-level labels win over bib-level for the matching claim only', function () {
    $swappedSentence = 'Registered reports were proposed as a structural fix to publication bias.';
    [$manifest, $state] = joinerCorpus(
        [
            joinerGt('g/bib', 'intact', 'alder2010'),
            joinerGt('g/swap', 'source_swap', 'alder2010', snippet: GroundTruthText::normalise($swappedSentence)),
        ],
        [
            joinerClaim('alder2010', 'confirmed'),
            joinerClaim('alder2010', 'rejected', ['truth_claim' => $swappedSentence, 'node_id' => 'node2']),
        ]
    );

    $result = (new ClaimsJoiner())->join($manifest, $state);
    $byNode = collect($result['rows'])->keyBy('node_id');

    expect($byNode['node1']['gt_label'])->toBe('intact')
        ->and($byNode['node2']['gt_label'])->toBe('source_swap')
        ->and($byNode['node2']['corruption_type'])->toBe('source_swap');
});

test('a cited ground-truth entry with no claims row becomes a not_detected_missing miss', function () {
    [$manifest, $state] = joinerCorpus(
        [
            joinerGt('g/fab', 'fabricated_reference', 'ghost2020', occ: 1),
            joinerGt('g/uncited', 'intact', 'nobody1999', occ: 0),
        ],
        []
    );

    $result = (new ClaimsJoiner())->join($manifest, $state);

    expect($result['rows'])->toHaveCount(1)
        ->and($result['rows'][0]['gt_label'])->toBe('fabricated_reference')
        ->and($result['rows'][0]['verdict'])->toBe('not_detected_missing')
        ->and($result['diagnostics']['orphan_gt'])->toBe(['g/fab']);
});

test('claims without a matching label fall back to the book default and are flagged in diagnostics', function () {
    [$manifest, $state] = joinerCorpus(
        [joinerGt('g/bib', 'intact', 'alder2010')],
        [joinerClaim('mystery2021', 'likely')]
    );

    $result = (new ClaimsJoiner())->join($manifest, $state);
    expect($result['rows'][0]['gt_label'])->toBe('intact')
        ->and($result['rows'][0]['gt_id'])->toBeNull()
        ->and($result['diagnostics']['defaulted_claims'])->toBe(['fixture:mystery2021']);
});

test('source-not-found and upgrade recovery land in the dataset row', function () {
    [$manifest, $state] = joinerCorpus(
        [
            joinerGt('g/fab', 'fabricated_reference', 'ghost2020'),
            joinerGt('g/dist', 'claim_distortion', 'alder2010'),
        ],
        [
            joinerClaim('ghost2020', 'insufficient', ['source_book_id' => null]),
            joinerClaim('alder2010', 'unlikely', ['llm_verdict' => [
                'support' => 'unlikely', 'summary' => 's',
                'reasoning' => 'Weak topical link.' . ClaimsJoiner::UPGRADE_MARKER,
            ]]),
        ]
    );

    $rows = collect((new ClaimsJoiner())->join($manifest, $state)['rows'])->keyBy('gt_id');

    expect($rows['g/fab']['verdict'])->toBe('source_not_found')
        ->and($rows['g/fab']['source_found'])->toBeFalse()
        ->and($rows['g/dist']['verdict'])->toBe('unlikely')
        ->and($rows['g/dist']['verdict_pre_upgrade'])->toBe('rejected')
        ->and($rows['g/dist']['was_upgraded'])->toBeTrue();
});
