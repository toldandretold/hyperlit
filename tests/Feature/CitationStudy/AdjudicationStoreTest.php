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
