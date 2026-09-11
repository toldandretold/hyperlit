<?php

/**
 * The corruption engine must be exactly reproducible from the committed spec —
 * that is what lets the paper's methods section claim the corpus is
 * regenerable. Same spec + seed => byte-identical outputs; different seed =>
 * different selection.
 */

use App\Services\CitationStudy\CitationCorruptor;
use App\Services\CitationStudy\CorpusManifest;
use Illuminate\Support\Facades\File;

const CORR_DET_ROOT = 'storage/framework/testing/citation-study-det';

function corrDetWriteCorpus(int $seed): CorpusManifest
{
    config(['study.root' => CORR_DET_ROOT]);
    $dir = base_path(CORR_DET_ROOT . '/corpora/unit/sources/fixture');
    File::ensureDirectoryExists($dir);

    File::put($dir . '/original.md', <<<'MD'
# Fixture Article

Alpha work showed that outcomes increased over time (Alder, 2010). Beta work found that 40 percent of cases were affected (Boren, 2012). A narrative mention of Cully (2014) showed that effects were stronger in later cohorts. Delta results were replicated in 12 further trials (Dagny, 2016).

## References

Alder, P. (2010). First fixture reference. *Journal A*, 1(1), 1–10.

Boren, Q. (2012). Second fixture reference. *Journal B*, 2(2), 11–20.

Cully, R. (2014). Third fixture reference. *Journal C*, 3(3), 21–30.

Dagny, S. (2016). Fourth fixture reference. *Journal D*, 4(4), 31–40.
MD);

    File::put($dir . '/corruption.json', json_encode([
        'seed' => $seed,
        'counts' => ['fabrication' => 1, 'source_swap' => 1, 'claim_distortion' => 1],
    ]));

    File::put(base_path(CORR_DET_ROOT . '/corpora/unit/manifest.json'), json_encode([
        'corpus' => 'unit',
        'books' => [[
            'slug' => 'fixture',
            'arm' => 'synthetic',
            'source_file' => 'sources/fixture/original.md',
            'study_file' => 'sources/fixture/corrupted.md',
            'corruption_spec' => 'sources/fixture/corruption.json',
            'ground_truth' => 'sources/fixture/ground_truth.json',
            'default_label' => 'intact',
        ]],
    ]));

    return CorpusManifest::load('unit');
}

afterEach(function () {
    File::deleteDirectory(base_path(CORR_DET_ROOT));
});

test('same seed regenerates byte-identical corrupted.md and ground truth', function () {
    $manifest = corrDetWriteCorpus(1234);
    $book = $manifest->book('fixture');
    $corruptor = new CitationCorruptor();

    $first = $corruptor->corrupt($manifest, $book, dryRun: true);
    $second = $corruptor->corrupt($manifest, $book, dryRun: true);

    expect($second['corrupted_md'])->toBe($first['corrupted_md'])
        ->and($second['ground_truth'])->toBe($first['ground_truth']);
});

test('corruption counts match the spec and every citation gets a ground-truth entry', function () {
    $manifest = corrDetWriteCorpus(1234);
    $result = (new CitationCorruptor())->corrupt($manifest, $manifest->book('fixture'), dryRun: true);

    expect($result['fabricated'])->toBe(1)
        ->and($result['swapped'])->toBe(1)
        ->and($result['distorted'])->toBe(1);

    $labels = array_count_values(array_column($result['ground_truth']['entries'], 'label'));
    expect($labels['fabricated_reference'] ?? 0)->toBe(1)
        ->and($labels['source_swap'] ?? 0)->toBe(1)
        ->and($labels['claim_distortion'] ?? 0)->toBe(1);

    // Bibliography-level entries (claim_snippet null) cover every reference
    // entry exactly once: 4 refs = 1 fabricated + 3 intact.
    $bibLevel = array_filter($result['ground_truth']['entries'], fn ($e) => $e['claim_snippet'] === null);
    expect(count($bibLevel))->toBe(4);
});

test('a different seed produces a different corruption selection', function () {
    $manifest = corrDetWriteCorpus(1234);
    $corruptor = new CitationCorruptor();
    $a = $corruptor->corrupt($manifest, $manifest->book('fixture'), dryRun: true);

    $manifestB = corrDetWriteCorpus(9999);
    $b = $corruptor->corrupt($manifestB, $manifestB->book('fixture'), dryRun: true);

    expect($b['corrupted_md'])->not->toBe($a['corrupted_md']);
});

test('a document without a references heading fails loudly', function () {
    $manifest = corrDetWriteCorpus(1234);
    File::put($manifest->path('sources/fixture/original.md'), "# No refs here\n\nJust text (Alder, 2010).\n");

    expect(fn () => (new CitationCorruptor())->corrupt($manifest, $manifest->book('fixture'), dryRun: true))
        ->toThrow(RuntimeException::class, 'no references');
});

test('a swap decrements the source entry occurrence count so the joiner sees no false orphan', function () {
    $manifest = corrDetWriteCorpus(1234);
    $result = (new CitationCorruptor())->corrupt($manifest, $manifest->book('fixture'), dryRun: true);

    $swap = collect($result['ground_truth']['entries'])->firstWhere('label', 'source_swap');
    $originalHash = $swap['corruption_meta']['original_bib_text_hash'];
    $sourceEntry = collect($result['ground_truth']['entries'])
        ->first(fn ($e) => $e['label'] === 'intact' && $e['bib_text_hash'] === $originalHash);

    // Each fixture entry is cited exactly once, so the swapped-away entry has
    // zero remaining callouts.
    expect($sourceEntry)->not->toBeNull()
        ->and($sourceEntry['cited_occurrences'])->toBe(0);

    // Same for distortion: the entry's only callout now carries the distorted
    // claim (labelled by the snippet entry), so its intact expectation is 0.
    $distortion = collect($result['ground_truth']['entries'])->firstWhere('label', 'claim_distortion');
    $distortedIntact = collect($result['ground_truth']['entries'])
        ->first(fn ($e) => $e['label'] === 'intact' && $e['bib_text_hash'] === $distortion['bib_text_hash']);
    expect($distortedIntact)->not->toBeNull()
        ->and($distortedIntact['cited_occurrences'])->toBe(0);
});
