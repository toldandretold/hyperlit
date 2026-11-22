<?php

/**
 * The adjudication store's contract: verdicts persist per book under
 * study/corpora/{corpus}/adjudications/, apply folds labels into
 * ground_truth.json (raising cited_occurrences for positives — the joiner
 * silently DROPS an unmatched positive with no occurrences instead of
 * counting it as a miss), and a frozen corpus refuses to change.
 */

use App\Services\CitationStudy\AdjudicationStore;
use App\Services\CitationStudy\CorpusManifest;
use Illuminate\Support\Facades\File;

const ADJ_ROOT = 'storage/framework/testing/citation-study-adjudications';

function adjCorpus(bool $frozen = false, ?int $citedOccurrences = null): CorpusManifest
{
    config(['study.root' => ADJ_ROOT]);
    $dir = base_path(ADJ_ROOT . '/corpora/adjtest/sources/fixture');
    File::ensureDirectoryExists($dir);
    File::put($dir . '/original.md', "# stub\n");
    File::put(base_path(ADJ_ROOT . '/corpora/adjtest/manifest.json'), json_encode([
        'corpus' => 'adjtest',
        'frozen' => $frozen,
        'books' => [[
            'slug' => 'fixture',
            'arm' => 'retracted',
            'source_file' => 'sources/fixture/original.md',
            'ground_truth' => 'sources/fixture/ground_truth.json',
            'default_label' => 'intact',
        ]],
    ]));
    File::put($dir . '/ground_truth.json', json_encode([
        'book' => 'fixture',
        'generator' => 'test',
        'seed' => null,
        'entries' => [
            [
                'gt_id' => 'fixture/c01',
                'label' => 'intact',
                'bib_text_normalized' => 'some citation text',
                'bib_text_hash' => 'sha256:aaa',
                'claim_snippet' => null,
                'cited_occurrences' => $citedOccurrences,
                'expected_detection' => 'pass',
                'corruption_meta' => null,
                'bound_reference_id' => 'ref_abc',
                'footnote_marker' => '1',
            ],
            [
                'gt_id' => 'fixture/c02',
                'label' => 'intact',
                'bib_text_normalized' => 'another citation',
                'bib_text_hash' => 'sha256:bbb',
                'claim_snippet' => null,
                'cited_occurrences' => 2,
                'expected_detection' => 'pass',
                'corruption_meta' => null,
                'bound_reference_id' => 'ref_def',
                'footnote_marker' => '2',
            ],
        ],
        'binding' => ['bound_at' => '2026-09-10T00:00:00Z', 'book_id' => 'study_adjtest_fixture', 'unmatched' => []],
    ]));

    return CorpusManifest::load('adjtest');
}

afterEach(function () {
    File::deleteDirectory(base_path(ADJ_ROOT));
});

test('put, load, and remove roundtrip', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $record = $store->put($manifest, $book, 'fixture/c01', 'unverifiable', 'grey_literature', 'ANAO report, unindexed', 'ref_abc', 'run1', 'sam');
    expect($record['label'])->toBe('unverifiable')
        ->and($record['cause'])->toBe('grey_literature')
        ->and($record['gt_id'])->toBe('fixture/c01');

    $loaded = $store->load($manifest, $book);
    expect($loaded['adjudications'])->toHaveKey('fixture/c01')
        ->and($loaded['adjudications']['fixture/c01']['note'])->toBe('ANAO report, unindexed');

    // The file lives under the COMMITTED corpus dir, not gitignored results.
    expect(is_file(base_path(ADJ_ROOT . '/corpora/adjtest/adjudications/fixture.json')))->toBeTrue();

    expect($store->remove($manifest, $book, 'fixture/c01'))->toBeTrue();
    expect($store->load($manifest, $book)['adjudications'])->toBe([]);
    expect($store->remove($manifest, $book, 'fixture/c01'))->toBeFalse();
});

test('an unbound ref: adjudication is stored with a null gt_id', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $record = (new AdjudicationStore())->put($manifest, $book, 'ref:orphanref', 'suspect', null, null, 'orphanref', 'run1', 'sam');
    expect($record['gt_id'])->toBeNull()
        ->and($record['referenceId'])->toBe('orphanref');
});

test('invalid label and invalid cause are refused', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();
    expect(fn () => $store->put($manifest, $book, 'fixture/c01', 'nonsense', null, null, null, null, 'sam'))
        ->toThrow(RuntimeException::class, 'Invalid label');
    expect(fn () => $store->put($manifest, $book, 'fixture/c01', 'verified_intact', 'vibes', null, null, null, 'sam'))
        ->toThrow(RuntimeException::class, 'Invalid cause');
});

test('apply folds labels in and raises cited_occurrences for positives', function () {
    // c01 deliberately has NULL cited_occurrences — the footnote-skeleton
    // default, and exactly the shape the joiner drops for unmatched positives.
    $manifest = adjCorpus(citedOccurrences: null);
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $store->put($manifest, $book, 'fixture/c01', 'fabricated_reference', 'correct_flag', null, 'ref_abc', 'run1', 'sam');
    $store->put($manifest, $book, 'fixture/c02', 'verified_intact', 'resolver_gap', null, 'ref_def', 'run1', 'sam');
    $store->put($manifest, $book, 'ref:orphan', 'suspect', null, null, 'orphan', 'run1', 'sam');

    $result = $store->applyToGroundTruth($manifest, $book);
    expect($result['applied'])->toBe(2)
        ->and($result['skipped'])->toBe(['ref:orphan']);

    $gt = $manifest->loadGroundTruth($book);
    $byId = collect($gt['entries'])->keyBy('gt_id');
    expect($byId['fixture/c01']['label'])->toBe('fabricated_reference')
        ->and($byId['fixture/c01']['expected_detection'])->toBe('flag')
        ->and($byId['fixture/c01']['cited_occurrences'])->toBe(1)   // raised from null
        ->and($byId['fixture/c02']['label'])->toBe('verified_intact')
        ->and($byId['fixture/c02']['expected_detection'])->toBe('pass')
        ->and($byId['fixture/c02']['cited_occurrences'])->toBe(2);  // untouched

    // Binding survived the rewrite (saveGroundTruth carries it by hash).
    expect($byId['fixture/c01']['bound_reference_id'])->toBe('ref_abc');
});

test('apply refuses on a frozen corpus', function () {
    $manifest = adjCorpus(frozen: true);
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();
    $store->put($manifest, $book, 'fixture/c01', 'unverifiable', null, null, 'ref_abc', 'run1', 'sam');
    expect(fn () => $store->applyToGroundTruth($manifest, $book))
        ->toThrow(RuntimeException::class, 'frozen');
});

test('apply with nothing recorded is a no-op', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $before = file_get_contents($manifest->groundTruthPath($book));
    $result = (new AdjudicationStore())->applyToGroundTruth($manifest, $book);
    expect($result['applied'])->toBe(0);
    expect(file_get_contents($manifest->groundTruthPath($book)))->toBe($before);
});

test('found_url is stored when valid and refused when not http(s)', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $record = $store->put($manifest, $book, 'fixture/c01', 'verified_intact', 'resolver_gap',
        null, 'ref_abc', 'run1', 'sam', 'https://doi.org/10.1000/xyz123');
    expect($record['found_url'])->toBe('https://doi.org/10.1000/xyz123');

    expect(fn () => $store->put($manifest, $book, 'fixture/c02', 'verified_intact', null,
        null, 'ref_def', 'run1', 'sam', 'javascript:alert(1)'))
        ->toThrow(RuntimeException::class, 'found_url');
});

test('reference_exists rides the record as a tri-state', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $confirmed = $store->put($manifest, $book, 'fixture/c01', 'unverifiable', 'access_blocked',
        null, 'ref_abc', 'run1', 'sam', null, true);
    expect($confirmed['reference_exists'])->toBeTrue();

    $unassessed = $store->put($manifest, $book, 'fixture/c02', 'verified_intact', null,
        null, 'ref_def', 'run1', 'sam');
    expect($unassessed['reference_exists'])->toBeNull();
});

test('stale citation_mislink verdicts are listed, not applied, after a new run', function () {
    // A mislink verdict describes phantom anchors in the copy it was recorded
    // against; after reimport + a new run those anchors usually link correctly,
    // so blind-applying (e.g. not_a_citation) would unscore genuine pairings.
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $store->put($manifest, $book, 'fixture/c01', 'not_a_citation', 'citation_mislink',
        'phantom year-range anchor', 'ref_abc', 'OLD_RUN', 'sam');
    $store->put($manifest, $book, 'fixture/c02', 'verified_intact', 'citation_typo',
        null, 'ref_def', 'OLD_RUN', 'sam');

    // Same run id → both apply (mislink verdicts are valid for their own run).
    $sameRun = $store->applyToGroundTruth($manifest, $book, 'OLD_RUN');
    expect($sameRun['applied'])->toBe(2)->and($sameRun['stale_mislinks'])->toBe([]);

    // Newer run → the mislink one is parked; the citation-truth one applies.
    $newRun = $store->applyToGroundTruth($manifest, $book, 'NEW_RUN');
    expect($newRun['stale_mislinks'])->toBe(['fixture/c01'])
        ->and($newRun['applied'])->toBe(1);

    // No run id supplied (legacy caller) → old behaviour, everything applies.
    $legacy = $store->applyToGroundTruth($manifest, $book, null);
    expect($legacy['applied'])->toBe(2)->and($legacy['stale_mislinks'])->toBe([]);
});

// ------------------------------------------------------------------ evidence

test('evidence saves with a verdict and is normalised, never truncated', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    // Pasted from a PDF: CRLF endings and a run of blank lines.
    $record = $store->put(
        $manifest, $book, 'fixture/c01', 'verified_intact', null,
        null, 'ref_abc', 'run1', 'sam',
        evidence: "\"first quote\"\r\n\r\n\r\n\"second quote\"\r\n",
        evidenceLocator: 'p. 412',
    );

    expect($record['evidence'])->toBe("\"first quote\"\n\n\"second quote\"")
        ->and($record['evidence_locator'])->toBe('p. 412');

    // The cap is the REQUEST's job. A store that silently shortened a
    // quotation would leave something that still reads as complete.
    $long = str_repeat('x', AdjudicationStore::EVIDENCE_MAX_CHARS + 500);
    $big = $store->put(
        $manifest, $book, 'fixture/c02', 'verified_intact', null,
        null, 'ref_def', 'run1', 'sam', evidence: $long,
    );
    expect(mb_strlen((string) $big['evidence']))->toBe(AdjudicationStore::EVIDENCE_MAX_CHARS + 500);
});

test('putEvidence MERGES — the verdict it backs is untouched', function () {
    // The backfill path. The workbench's only other mutation is Undo, which
    // deletes the record, so this must not disturb a single verdict field.
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $original = $store->put(
        $manifest, $book, 'fixture/c01', 'verified_intact', 'resolver_gap',
        'found it by hand', 'ref_abc', 'run1', 'sam',
        foundUrl: 'https://example.com/paper', referenceExists: true, supportedScope: 'whole_claim',
    );

    $updated = $store->putEvidence($manifest, $book, 'fixture/c01', '"the quoted sentence"', 'p. 7', 'marx');

    expect($updated['evidence'])->toBe('"the quoted sentence"')
        ->and($updated['evidence_locator'])->toBe('p. 7')
        ->and($updated['evidenced_by'])->toBe('marx')
        ->and($updated['evidenced_at'])->not->toBeNull()
        // Every verdict field survives, including WHO made it and WHEN — the
        // evidence stamp is separate precisely so this stays true.
        ->and($updated['label'])->toBe('verified_intact')
        ->and($updated['cause'])->toBe('resolver_gap')
        ->and($updated['note'])->toBe('found it by hand')
        ->and($updated['found_url'])->toBe('https://example.com/paper')
        ->and($updated['reference_exists'])->toBeTrue()
        ->and($updated['supported_scope'])->toBe('whole_claim')
        ->and($updated['adjudicated_by'])->toBe('sam')
        ->and($updated['adjudicated_at'])->toBe($original['adjudicated_at']);
});

test('putEvidence REFUSES to create a record', function () {
    // An evidence-only record would carry no label, and both
    // applyToGroundTruth() and citation:study:adjudications read ['label']
    // unguarded — this guard is what keeps those from fataling.
    $manifest = adjCorpus();
    $store = new AdjudicationStore();

    expect(fn () => $store->putEvidence($manifest, $manifest->book('fixture'), 'fixture/c99', 'quote', null, 'sam'))
        ->toThrow(RuntimeException::class);
});

test('clearing evidence clears its stamps too', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $store->put($manifest, $book, 'fixture/c01', 'verified_intact', null, null, 'ref_abc', 'run1', 'sam',
        evidence: 'a quote');
    $cleared = $store->putEvidence($manifest, $book, 'fixture/c01', '   ', null, 'sam');

    expect($cleared['evidence'])->toBeNull()
        ->and($cleared['evidenced_at'])->toBeNull()
        ->and($cleared['evidenced_by'])->toBeNull();
});

test('apply carries evidence into ground truth, and writes nothing when there is none', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $store->put($manifest, $book, 'fixture/c01', 'verified_intact', null, null, 'ref_abc', 'run1', 'sam',
        evidence: '"the sentence that settles it"', evidenceLocator: 'p. 7');
    $store->put($manifest, $book, 'fixture/c02', 'verified_intact', null, null, 'ref_def', 'run1', 'sam');
    $store->applyToGroundTruth($manifest, $book, 'run1');

    $entries = collect($manifest->loadGroundTruth($book)['entries'])->keyBy('gt_id');

    expect($entries['fixture/c01']['evidence'])->toBe('"the sentence that settles it"')
        ->and($entries['fixture/c01']['evidence_locator'])->toBe('p. 7')
        ->and($entries['fixture/c01']['evidenced_by'])->toBe('sam')
        // An un-evidenced entry gains no null keys: ground_truth.json is
        // hash-locked, and a null per entry would balloon the diff.
        ->and($entries['fixture/c02'])->not->toHaveKey('evidence');
});

test('human evidence SURVIVES a ground-truth regeneration', function () {
    // The corruptor rebuilds each entry from a fixed literal in seven places,
    // so without the carry-over in saveGroundTruth a reviewer's quotations
    // would be destroyed by the next `citation:study:corrupt`.
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $store->put($manifest, $book, 'fixture/c01', 'verified_intact', null, null, 'ref_abc', 'run1', 'sam',
        evidence: '"quoted by a human"', evidenceLocator: 'p. 7');
    $store->applyToGroundTruth($manifest, $book, 'run1');

    // Regenerate: entries rebuilt from scratch, carrying no human fields.
    $regenerated = $manifest->loadGroundTruth($book);
    foreach ($regenerated['entries'] as &$entry) {
        unset($entry['evidence'], $entry['evidence_locator'], $entry['evidenced_by'], $entry['evidenced_at']);
    }
    unset($entry);
    $manifest->saveGroundTruth($book, $regenerated);

    $after = collect($manifest->loadGroundTruth($book)['entries'])->keyBy('gt_id');
    expect($after['fixture/c01']['evidence'])->toBe('"quoted by a human"')
        ->and($after['fixture/c01']['evidence_locator'])->toBe('p. 7');
});

test('apply resolves an inherited verdict to its antecedent\'s evidence, with provenance', function () {
    // deloitte c29: an Ibid labelled fabricated via the workbench's inherit button carries
    // no quotes of its own — its note names the antecedent, and a fabrication proof is
    // about the WORK, so the antecedent's evidence holds for every citation of it. The
    // ground-truth entry must come out EVIDENCED, naming where the proof lives.
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $store->put($manifest, $book, 'fixture/c01', 'fabricated_reference', 'correct_flag',
        'checked JSSL 31(1) contents — no such article', 'ref_abc', 'run1', 'sam',
        evidence: 'JSSL vol 31 issue 1 table of contents, pp 1–214: no Carney article appears.',
        evidenceLocator: 'JSSL 31(1) TOC');
    $store->put($manifest, $book, 'fixture/c02', 'fabricated_reference', 'correct_flag',
        'source identity inherited from antecedent fixture/c01 (Ibid)', 'ref_def', 'run1', 'sam');

    $store->applyToGroundTruth($manifest, $book);
    $byId = collect($manifest->loadGroundTruth($book)['entries'])->keyBy('gt_id');

    expect($byId['fixture/c02']['evidence'])->toBe(
        'JSSL vol 31 issue 1 table of contents, pp 1–214: no Carney article appears.')
        ->and($byId['fixture/c02']['evidence_inherited_from'])->toBe('fixture/c01')
        ->and($byId['fixture/c02']['evidence_locator'])->toBe('JSSL 31(1) TOC')
        ->and($byId['fixture/c01'])->not->toHaveKey('evidence_inherited_from');
});

test('inherited evidence does NOT transfer across a different label, and resolves by referenceId', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    // Donor adjudicated under a DIFFERENT label: its proof is a different judgement.
    $store->put($manifest, $book, 'fixture/c01', 'claim_distortion', null,
        null, 'ref_abc', 'run1', 'sam', evidence: 'The source says the opposite on p 12.');
    $store->put($manifest, $book, 'fixture/c02', 'fabricated_reference', null,
        'source identity inherited from antecedent fixture/c01 (Ibid)', 'ref_def', 'run1', 'sam');
    $store->applyToGroundTruth($manifest, $book);
    $byId = collect($manifest->loadGroundTruth($book)['entries'])->keyBy('gt_id');
    expect($byId['fixture/c02'])->not->toHaveKey('evidence')
        ->and($byId['fixture/c02'])->not->toHaveKey('evidence_inherited_from');

    // An antecedent whose gt was unbound at adjudication time is named by its
    // referenceId in the note (deloitte c29's actual shape) — resolution must
    // find it by referenceId too.
    $data = $store->load($manifest, $book);
    $record = ['label' => 'claim_distortion',
               'note' => 'source identity inherited from antecedent ref_abc (Ibid)'];
    $donor = $store->resolveInheritedEvidence($record, $data['adjudications']);
    expect($donor)->not->toBeNull()
        ->and($donor['from'])->toBe('ref_abc')
        ->and($donor['record']['evidence'])->toBe('The source says the opposite on p 12.');
});

test('inherited evidence resolves through a MULTI-HOP chain, and a cycle never loops', function () {
    // deloitte c24 → c23 (same work, no quotes) → c22 (Ibid, no quotes) → c131, where the
    // evidence actually lives. An unevidenced middle link must not block resolution.
    $store = new AdjudicationStore();
    $adjudications = [
        'deloitte/c23' => ['gt_id' => 'deloitte/c23', 'label' => 'fabricated_reference',
            'note' => 'source identity inherited from deloitte/c22 (same work, cited independently)'],
        'deloitte/c22' => ['gt_id' => 'deloitte/c22', 'label' => 'fabricated_reference',
            'note' => 'source identity inherited from antecedent deloitte/c131 (Ibid)'],
        'deloitte/c131' => ['gt_id' => 'deloitte/c131', 'label' => 'fabricated_reference',
            'evidence' => "Noted in Government's internal review as mistaken."],
    ];
    $record = ['label' => 'fabricated_reference',
        'note' => 'source identity inherited from antecedent deloitte/c23 (Ibid)'];

    $donor = $store->resolveInheritedEvidence($record, $adjudications);
    expect($donor)->not->toBeNull()
        ->and($donor['from'])->toBe('deloitte/c131')
        ->and($donor['record']['evidence'])->toBe("Noted in Government's internal review as mistaken.");

    // A label change mid-chain severs it: c22 adjudicated under a different label.
    $broken = $adjudications;
    $broken['deloitte/c22']['label'] = 'claim_distortion';
    expect($store->resolveInheritedEvidence($record, $broken))->toBeNull();

    // Two notes pointing at each other terminate instead of looping.
    $cycle = [
        'a' => ['gt_id' => 'a', 'label' => 'fabricated_reference',
            'note' => 'source identity inherited from antecedent b (Ibid)'],
        'b' => ['gt_id' => 'b', 'label' => 'fabricated_reference',
            'note' => 'source identity inherited from antecedent a (Ibid)'],
    ];
    expect($store->resolveInheritedEvidence($cycle['a'], $cycle))->toBeNull();
});

test('source_match is stored, and an unknown value is refused', function () {
    // Resolution correctness is its own axis: the AI can say "likely" after reading a
    // DIFFERENT work (web search found a topically adjacent page), so the label and
    // verdict cannot carry it.
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $record = $store->put(
        $manifest, $book, 'fixture/c01', 'verified_intact', 'other',
        'web search hit a related page', 'ref_abc', 'run1', 'sam',
        foundUrl: 'https://example.com/the-real-one', sourceMatch: 'different_work',
    );
    expect($record['source_match'])->toBe('different_work');

    $plain = $store->put($manifest, $book, 'fixture/c01', 'verified_intact', null, null, 'ref_abc', 'run1', 'sam');
    expect($plain['source_match'])->toBeNull();

    expect(fn () => $store->put(
        $manifest, $book, 'fixture/c01', 'verified_intact', null, null, 'ref_abc', 'run1', 'sam',
        sourceMatch: 'kinda',
    ))->toThrow(RuntimeException::class);
});


/**
 * Two questions, one derived label.
 *
 * The reviewer answers (1) is the cited work real / cited correctly and (2) does it support
 * the claim. The label used to be picked from one row of chips that mixed both, with the
 * second question asked again underneath — so "verified intact · supports none of it" was
 * recordable and scored as a citation the AI should pass. Now the label is derived.
 */
test('the label is derived from the two answers, per the shared table', function () {
    $table = json_decode(file_get_contents(base_path('tests/fixtures/study/verdictDerivation.json')), true);
    expect($table)->not->toBeEmpty();
    foreach ($table as $row) {
        expect(AdjudicationStore::deriveLabel($row['reference'], $row['scope'], $row['from_other_work']))
            ->toBe($row['label'], json_encode($row));
    }
    // Every derivable label is one ground truth knows how to score.
    expect(array_diff(array_column($table, 'label'), CorpusManifest::LABELS))->toBe([]);
});

test('put with the two answers stores both and derives the label', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $none = $store->put(manifest: $manifest, book: $book, key: 'fixture/c01', label: null, cause: null,
        note: null, referenceId: 'ref_abc', runId: 'run1', adjudicatedBy: 'sam',
        supportedScope: 'none', reference: 'verified');
    expect($none['reference'])->toBe('verified')
        ->and($none['supported_scope'])->toBe('none')
        ->and($none['label'])->toBe('claim_distortion')
        ->and($none['reference_exists'])->toBeTrue();

    // A label sent alongside the answers is ignored — there is one definition.
    $ignored = $store->put(manifest: $manifest, book: $book, key: 'fixture/c01', label: 'verified_intact',
        cause: null, note: null, referenceId: 'ref_abc', runId: 'run1', adjudicatedBy: 'sam',
        supportedScope: 'undetermined', reference: 'verified');
    expect($ignored['label'])->toBe('unverifiable');

    $swap = $store->put(manifest: $manifest, book: $book, key: 'fixture/c02', label: null, cause: null,
        note: null, referenceId: 'ref_def', runId: 'run1', adjudicatedBy: 'sam',
        supportedScope: 'none', reference: 'verified', fromOtherWork: true);
    expect($swap['label'])->toBe('source_swap')->and($swap['from_other_work'])->toBeTrue();
});

test('a real work cited with the wrong author is recordable, and scores by claim support', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    $record = $store->put(manifest: $manifest, book: $book, key: 'fixture/c01', label: null, cause: null,
        note: 'Cited as the References Committee; the report is by the Standing Committee.',
        referenceId: 'ref_abc', runId: 'run1', adjudicatedBy: 'sam',
        supportedScope: 'whole_claim', reference: 'details_wrong', referenceErrors: ['author']);
    expect($record['reference'])->toBe('details_wrong')
        ->and($record['reference_errors'])->toBe(['author'])
        ->and($record['label'])->toBe('verified_intact')
        ->and($record['reference_exists'])->toBeTrue();

    // "Cited wrongly" with nothing named wrong is just "cited correctly" — refused.
    expect(fn () => $store->put(manifest: $manifest, book: $book, key: 'fixture/c01', label: null, cause: null,
        note: null, referenceId: null, runId: null, adjudicatedBy: 'sam', reference: 'details_wrong'))
        ->toThrow(RuntimeException::class, 'details_wrong needs');
    expect(fn () => $store->put(manifest: $manifest, book: $book, key: 'fixture/c01', label: null, cause: null,
        note: null, referenceId: null, runId: null, adjudicatedBy: 'sam',
        reference: 'details_wrong', referenceErrors: ['vibes']))
        ->toThrow(RuntimeException::class, 'Invalid reference_errors');
    expect(fn () => $store->put(manifest: $manifest, book: $book, key: 'fixture/c01', label: null, cause: null,
        note: null, referenceId: null, runId: null, adjudicatedBy: 'sam', reference: 'sort_of'))
        ->toThrow(RuntimeException::class, 'Invalid reference');
});

test('a work that is not real carries no claim-support answer', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $record = (new AdjudicationStore())->put(manifest: $manifest, book: $book, key: 'fixture/c01', label: null,
        cause: null, note: null, referenceId: 'ref_abc', runId: 'run1', adjudicatedBy: 'sam',
        supportedScope: 'whole_claim', reference: 'fabricated', referenceErrors: ['author'], fromOtherWork: true);
    expect($record['label'])->toBe('fabricated_reference')
        ->and($record['supported_scope'])->toBeNull()
        ->and($record['reference_errors'])->toBe([])
        ->and($record['from_other_work'])->toBeFalse()
        ->and($record['reference_exists'])->toBeFalse();
});

test('a record from before the split gains its two answers on load, and a contradictory one is re-scored', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();
    $legacy = fn (string $label, ?string $scope, ?bool $exists = null) => [
        'gt_id' => null, 'referenceId' => null, 'run_id' => null, 'label' => $label, 'cause' => null,
        'supported_scope' => $scope, 'note' => null, 'reference_exists' => $exists,
    ];
    @mkdir(dirname($store->path($manifest, $book)), 0775, true);
    file_put_contents($store->path($manifest, $book), json_encode(['book' => 'fixture', 'adjudications' => [
        'a' => $legacy('verified_intact', 'none'),          // the deloitte shape: real, supports nothing
        'b' => $legacy('verified_intact', 'undetermined'),
        'c' => $legacy('verified_intact', 'fragment_only'),
        'd' => $legacy('verified_intact', null),            // question 2 never asked
        'e' => $legacy('claim_distortion', null),
        'f' => $legacy('fabricated_reference', null),
        'g' => $legacy('unverifiable', null, true),         // work confirmed, body unreadable
        'h' => $legacy('unverifiable', null),
        'i' => $legacy('intact', null),
    ]]));

    $loaded = $store->load($manifest, $book)['adjudications'];
    $got = fn (string $k) => [$loaded[$k]['reference'], $loaded[$k]['supported_scope'], $loaded[$k]['label']];
    expect($got('a'))->toBe(['verified', 'none', 'claim_distortion'])
        ->and($got('b'))->toBe(['verified', 'undetermined', 'unverifiable'])
        ->and($got('c'))->toBe(['verified', 'fragment_only', 'verified_intact'])
        ->and($got('d'))->toBe(['verified', null, 'verified_intact'])
        ->and($got('e'))->toBe(['verified', 'none', 'claim_distortion'])
        ->and($got('f'))->toBe(['fabricated', null, 'fabricated_reference'])
        ->and($got('g'))->toBe(['verified', 'undetermined', 'unverifiable'])
        ->and($got('h'))->toBe(['unverifiable', null, 'unverifiable'])
        ->and($got('i'))->toBe(['verified', null, 'intact']);

    // The reviewer's ANSWERS are never rewritten — only the label derived from them.
    expect($loaded['a']['supported_scope'])->toBe('none')
        ->and($loaded['g']['reference_exists'])->toBeTrue();

    // A dry run reports and writes nothing; the real one rewrites the file once.
    $dry = $store->normaliseStored($manifest, $book, write: false);
    expect($dry['rewritten'])->toBe(9)
        ->and(array_keys($dry['relabelled']))->toBe(['a', 'b'])
        ->and($dry['relabelled']['a'])->toBe(['from' => 'verified_intact', 'to' => 'claim_distortion']);
    expect(json_decode(file_get_contents($store->path($manifest, $book)), true)['adjudications']['a'])
        ->not->toHaveKey('reference');

    expect($store->normaliseStored($manifest, $book)['rewritten'])->toBe(9);
    expect($store->normaliseStored($manifest, $book)['rewritten'])->toBe(0);
});

test('apply scores a real-but-unsupporting citation as one the AI should flag', function () {
    $manifest = adjCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();
    $store->put(manifest: $manifest, book: $book, key: 'fixture/c01', label: null, cause: null, note: null,
        referenceId: 'ref_abc', runId: 'run1', adjudicatedBy: 'sam', supportedScope: 'none', reference: 'verified');
    $store->applyToGroundTruth($manifest, $book);

    $entry = collect($manifest->loadGroundTruth($book)['entries'])->firstWhere('gt_id', 'fixture/c01');
    expect($entry['label'])->toBe('claim_distortion')
        ->and($entry['expected_detection'])->toBe('flag');
});
