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

test('workbench adjudications ride along as human_* passthrough columns', function () {
    [$manifest, $state] = joinerCorpus(
        [joinerGt('g/one', 'intact', 'alder2010')],
        [joinerClaim('alder2010', 'insufficient', ['source_book_id' => null])]
    );

    // No adjudications file → nulls, not errors.
    $rows = (new ClaimsJoiner())->join($manifest, $state)['rows'];
    expect($rows[0]['human_label'])->toBeNull()
        ->and($rows[0]['human_cause'])->toBeNull();

    // Record one via the store (keyed by gt_id, as the workbench does).
    (new \App\Services\CitationStudy\AdjudicationStore())->put(
        $manifest, $manifest->book('fixture'),
        'g/one', 'unverifiable', 'grey_literature', 'Hansard, unindexed', 'alder2010', 'run1', 'sam'
    );

    $rows = (new ClaimsJoiner())->join($manifest, $state)['rows'];
    expect($rows[0]['human_label'])->toBe('unverifiable')
        ->and($rows[0]['human_cause'])->toBe('grey_literature')
        ->and($rows[0]['human_note'])->toBe('Hansard, unindexed')
        // The AI's own columns are untouched — human_* is passthrough, not override.
        ->and($rows[0]['gt_label'])->toBe('intact')
        ->and($rows[0]['verdict'])->toBe('source_not_found');
});

test('the reviewer EVIDENCE reaches the dataset, and so does supported_scope', function () {
    // supported_scope had been stored, validated, typed and rendered since
    // 2026-09-19 while never being emitted, so the denominator-independence
    // axis could not be analysed from dataset.csv at all. Pinned here with the
    // evidence columns because both are the same one-line class of omission.
    [$manifest, $state] = joinerCorpus(
        [joinerGt('g/one', 'intact', 'alder2010')],
        [joinerClaim('alder2010', 'rejected', ['source_book_id' => null])]
    );

    (new \App\Services\CitationStudy\AdjudicationStore())->put(
        $manifest, $manifest->book('fixture'),
        'g/one', 'verified_intact', 'resolver_gap', 'found by hand', 'alder2010', 'run1', 'sam',
        supportedScope: 'whole_claim',
        evidence: "\"first quote\"\n\n\"second quote\"",
        evidenceLocator: 'p. 412',
    );

    $rows = (new ClaimsJoiner())->join($manifest, $state)['rows'];

    expect($rows[0]['human_supported_scope'])->toBe('whole_claim')
        ->and($rows[0]['human_evidence'])->toBe("\"first quote\"\n\n\"second quote\"")
        ->and($rows[0]['human_evidence_locator'])->toBe('p. 412')
        // A numeric column so the paper's "N of M evidenced" claim is a pivot,
        // not a parse of prose out of a 1500-char field.
        ->and($rows[0]['human_evidence_chars'])->toBe(29);
});

test('multi-line evidence survives the CSV round trip with its paragraphs intact', function () {
    // fputcsv RFC4180-quotes embedded newlines; this pins that nothing
    // downstream decides to flatten them, since the paragraph breaks ARE the
    // one-quote-per-paragraph structure.
    $evidence = "\"a quote, with a comma\"\n\n\"a second \"\"quoted\"\" one\"";
    $path = tempnam(sys_get_temp_dir(), 'evcsv');
    $handle = fopen($path, 'w');
    fputcsv($handle, ['gt_id', 'human_evidence']);
    fputcsv($handle, ['g/one', $evidence]);
    fclose($handle);

    $read = fopen($path, 'r');
    fgetcsv($read); // header
    $row = fgetcsv($read);
    fclose($read);
    @unlink($path);

    expect($row[1])->toBe($evidence)
        ->and(substr_count($row[1], "\n"))->toBe(2);
});

test('every dataset row carries the import pathway it came through', function () {
    // The citation review is downstream of conversion, so a result is only
    // interpretable alongside the pathway that produced its text.
    [$manifest, $state] = joinerCorpus(
        [joinerGt('g/one', 'intact', 'alder2010')],
        [joinerClaim('alder2010', 'likely')]
    );
    $rows = (new ClaimsJoiner())->join($manifest, $state)['rows'];
    expect($rows[0]['pathway'])->toBe('markdown'); // derived from original.md
});
