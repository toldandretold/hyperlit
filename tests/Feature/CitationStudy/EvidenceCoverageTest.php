<?php

/**
 * "How many human labels are backed by quotes?" — the number the methodology
 * defence rests on, so what it counts matters more than that it counts.
 *
 * Two rules it must not break. The UNIT is the human adjudication, never the
 * ground-truth entry (entries carry the corpus's blanket default label — 2054
 * of 2066 across the real corpora — so an entry-based denominator would report
 * the corpus's size instead of the reviewer's work). And the DENOMINATOR is the
 * scored labels only: there is nothing to quote when access was never obtained
 * or no citation exists, and demanding evidence there would either park
 * coverage below 100% forever or invite invented quotations.
 */

use App\Services\CitationStudy\AdjudicationStore;
use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\EvidenceCoverage;
use Illuminate\Support\Facades\File;

const COV_ROOT = 'storage/framework/testing/citation-study-coverage';

function covCorpus(): CorpusManifest
{
    config(['study.root' => COV_ROOT]);
    $dir = base_path(COV_ROOT . '/corpora/covtest/sources/fixture');
    File::ensureDirectoryExists($dir);
    File::put($dir . '/original.md', "# stub\n");
    File::put(base_path(COV_ROOT . '/corpora/covtest/manifest.json'), json_encode([
        'corpus' => 'covtest',
        'frozen' => false,
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
        'entries' => [],
    ]));

    return CorpusManifest::load('covtest');
}

afterEach(fn () => File::deleteDirectory(base_path(COV_ROOT)));

test('only SCORED labels are counted; the un-quotable ones are exempt', function () {
    $manifest = covCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();

    // Scored: one evidenced, one not.
    $store->put($manifest, $book, 'fixture/c01', 'verified_intact', null, null, 'r1', 'run1', 'sam',
        evidence: '"the quoted sentence"');
    $store->put($manifest, $book, 'fixture/c02', 'claim_distortion', null, null, 'r2', 'run1', 'sam');
    // Non-scored: exempt whatever their evidence state.
    $store->put($manifest, $book, 'fixture/c03', 'unverifiable', null, 'paywalled, never got in', 'r3', 'run1', 'sam');
    $store->put($manifest, $book, 'fixture/c04', 'not_a_citation', null, 'phantom anchor', 'r4', 'run1', 'sam');
    $store->put($manifest, $book, 'fixture/c05', 'suspect', null, 'unsure', 'r5', 'run1', 'sam');

    $coverage = (new EvidenceCoverage($store))->forCorpus($manifest);

    expect($coverage['expected'])->toBe(2)
        ->and($coverage['evidenced'])->toBe(1)
        ->and($coverage['exempt'])->toBe(3)
        ->and($coverage['rate'])->toBe(0.5)
        ->and($coverage['missing'])->toHaveCount(1)
        ->and($coverage['missing'][0]['key'])->toBe('fixture/c02')
        ->and($coverage['missing'][0]['label'])->toBe('claim_distortion')
        ->and($coverage['missing'][0]['slug'])->toBe('fixture')
        // A gt_id already carries its slug, so naming it "fixture/fixture/c02"
        // would be wrong in both places that print it.
        ->and($coverage['missing'][0]['ref'])->toBe('fixture/c02');
});

test('whitespace-only evidence does not count as evidence', function () {
    $manifest = covCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();
    // The store normalises this to null anyway; asserted so a future change to
    // normalisation cannot quietly inflate the coverage number.
    $store->put($manifest, $book, 'fixture/c01', 'verified_intact', null, null, 'r1', 'run1', 'sam',
        evidence: "   \n\n  ");

    $coverage = (new EvidenceCoverage($store))->forCorpus($manifest);

    expect($coverage['expected'])->toBe(1)->and($coverage['evidenced'])->toBe(0);
});

test('an exempt label with no note is reported — the exemption is not a loophole', function () {
    $manifest = covCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();
    $store->put($manifest, $book, 'fixture/c01', 'unverifiable', null, 'could not obtain access', 'r1', 'run1', 'sam');
    $store->put($manifest, $book, 'fixture/c02', 'unverifiable', null, null, 'r2', 'run1', 'sam');

    $coverage = (new EvidenceCoverage($store))->forCorpus($manifest);

    expect($coverage['exempt'])->toBe(2)
        ->and($coverage['exempt_without_note'])->toHaveCount(1)
        ->and($coverage['exempt_without_note'][0]['key'])->toBe('fixture/c02');
});

test('unbound ref:-keyed verdicts are counted — they are human labels too', function () {
    $manifest = covCorpus();
    $book = $manifest->book('fixture');
    $store = new AdjudicationStore();
    $store->put($manifest, $book, 'ref:someref', 'verified_intact', null, null, 'someref', 'run1', 'sam');

    $coverage = (new EvidenceCoverage($store))->forCorpus($manifest);

    expect($coverage['expected'])->toBe(1)
        // An unbound key carries no slug, so it gets one for display.
        ->and($coverage['missing'][0]['ref'])->toBe('fixture/ref:someref');
});

test('no scored labels yields a NULL rate, never a 100% off zero', function () {
    // "100% evidenced" computed from nothing reads as a result when it is an
    // absence — and would be quoted as one.
    $manifest = covCorpus();
    $coverage = (new EvidenceCoverage(new AdjudicationStore()))->forCorpus($manifest);

    expect($coverage['expected'])->toBe(0)
        ->and($coverage['rate'])->toBeNull()
        ->and(EvidenceCoverage::summaryLine($coverage))->toContain('no scored human labels');
});
