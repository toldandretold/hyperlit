<?php

/**
 * Ground truth is text-keyed (referenceIds are not stable across imports) and
 * bound to real bibliography rows after import. Binding must match exactly or
 * fuzzily above the floor, and fail hard on unmatched or ambiguous entries —
 * a corpus with unreliable ground truth must never run.
 */

use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\GroundTruthBinder;
use App\Services\CitationStudy\GroundTruthText;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

const BINDER_ROOT = 'storage/framework/testing/citation-study-binder';
const BINDER_BOOK = 'study_bindertest_fixture';

function binderDb()
{
    return DB::connection('pgsql_admin');
}

function binderWriteCorpus(array $gtEntries): CorpusManifest
{
    config(['study.root' => BINDER_ROOT]);
    $dir = base_path(BINDER_ROOT . '/corpora/bindertest/sources/fixture');
    File::ensureDirectoryExists($dir);
    File::put($dir . '/original.md', "# stub\n");

    File::put(base_path(BINDER_ROOT . '/corpora/bindertest/manifest.json'), json_encode([
        'corpus' => 'bindertest',
        'books' => [[
            'slug' => 'fixture',
            'arm' => 'control',
            'source_file' => 'sources/fixture/original.md',
            'ground_truth' => 'sources/fixture/ground_truth.json',
            'default_label' => 'intact',
        ]],
    ]));

    File::put($dir . '/ground_truth.json', json_encode([
        'book' => 'fixture',
        'entries' => $gtEntries,
        'binding' => ['bound_at' => null, 'book_id' => null, 'unmatched' => []],
    ]));

    return CorpusManifest::load('bindertest');
}

function binderGtEntry(string $gtId, string $bibText, ?string $snippet = null): array
{
    return [
        'gt_id' => $gtId,
        'label' => 'intact',
        'bib_text_normalized' => GroundTruthText::normalise($bibText),
        'bib_text_hash' => GroundTruthText::hash($bibText),
        'claim_snippet' => $snippet,
        'cited_occurrences' => 1,
        'expected_detection' => 'pass',
        'corruption_meta' => null,
        'bound_reference_id' => null,
    ];
}

function binderSeedBib(array $rows): void
{
    foreach ($rows as $referenceId => $content) {
        binderDb()->table('bibliography')->insert([
            'book' => BINDER_BOOK,
            'referenceId' => $referenceId,
            'content' => $content,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }
}

beforeEach(function () {
    binderDb()->table('bibliography')->where('book', BINDER_BOOK)->delete();
});

afterEach(function () {
    binderDb()->table('bibliography')->where('book', BINDER_BOOK)->delete();
    File::deleteDirectory(base_path(BINDER_ROOT));
});

// The binder derives the bookId from the corpus ('study_bindertest_fixture'),
// which is why BINDER_BOOK uses that exact shape.

test('exact and fuzzy matches bind and are written back to the ground-truth file', function () {
    $manifest = binderWriteCorpus([
        binderGtEntry('fixture/c01', 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.'),
        // Fuzzy: import appended a DOI the ground truth does not carry.
        binderGtEntry('fixture/c02', 'Boren, Q. (2012). Second fixture reference with a long enough title. Journal B, 2(2), 11-20.'),
    ]);
    binderSeedBib([
        'alder2010' => '<p>Alder, P. (2010). First fixture reference. <i>Journal A</i>, 1(1), 1–10.</p>',
        'boren2012' => 'Boren, Q. (2012). Second fixture reference with a long enough title. Journal B, 2(2), 11-20. doi:10.1000/x',
    ]);

    $result = (new GroundTruthBinder())->bind($manifest, $manifest->book('fixture'));
    expect($result['bound'])->toBe(2);

    $gt = $manifest->loadGroundTruth($manifest->book('fixture'));
    $bound = array_column($gt['entries'], 'bound_reference_id', 'gt_id');
    expect($bound['fixture/c01'])->toBe('alder2010')
        ->and($bound['fixture/c02'])->toBe('boren2012')
        ->and($gt['binding']['book_id'])->toBe(BINDER_BOOK)
        ->and($gt['binding']['bound_at'])->not->toBeNull();
});

test('an unmatched ground-truth entry fails the bind', function () {
    $manifest = binderWriteCorpus([
        binderGtEntry('fixture/c01', 'Completely unrelated reference text that matches nothing at all here.'),
    ]);
    binderSeedBib(['alder2010' => 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.']);

    expect(fn () => (new GroundTruthBinder())->bind($manifest, $manifest->book('fixture')))
        ->toThrow(RuntimeException::class, 'did not match');
});

test('two bib-level entries competing for one row fail the bind (rows are consumed uniquely)', function () {
    $sameText = 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.';
    $manifest = binderWriteCorpus([
        binderGtEntry('fixture/c01', $sameText),
        binderGtEntry('fixture/c02', $sameText),
    ]);
    binderSeedBib(['alder2010' => $sameText]);

    expect(fn () => (new GroundTruthBinder())->bind($manifest, $manifest->book('fixture')))
        ->toThrow(RuntimeException::class, 'did not match');
});

test('duplicate texts pair off 1:1 when the rows exist (Chicago short-form footnotes)', function () {
    $shortForm = 'Wolfe, Evaporating Genres, 21.';
    $fullForm = 'Kincaid, Paul. On the Origins of Genre. Extrapolation 44, no. 4 (2003): 409-419.';
    $shortKincaid = 'Kincaid, On the Origins of Genre.';
    $manifest = binderWriteCorpus([
        binderGtEntry('fixture/c01', $fullForm),
        binderGtEntry('fixture/c02', $shortKincaid),
        binderGtEntry('fixture/c03', $shortForm),
        binderGtEntry('fixture/c04', $shortForm),
    ]);
    binderSeedBib([
        'fn1' => $fullForm,
        'fn2' => $shortKincaid,
        'fn3' => $shortForm,
        'fn4' => $shortForm,
    ]);

    $result = (new GroundTruthBinder())->bind($manifest, $manifest->book('fixture'));
    expect($result['bound'])->toBe(4);

    $gt = $manifest->loadGroundTruth($manifest->book('fixture'));
    $bound = array_column($gt['entries'], 'bound_reference_id', 'gt_id');
    // The short form must NOT steal the full citation's row via containment.
    expect($bound['fixture/c01'])->toBe('fn1')
        ->and($bound['fixture/c02'])->toBe('fn2')
        ->and(array_unique(array_values($bound)))->toHaveCount(4);
});

test('snippet-level entries may share a referenceId with the bib-level entry', function () {
    $text = 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.';
    $manifest = binderWriteCorpus([
        binderGtEntry('fixture/c01', $text),
        binderGtEntry('fixture/c02', $text, snippet: 'some swapped claim sentence'),
    ]);
    binderSeedBib(['alder2010' => $text]);

    $result = (new GroundTruthBinder())->bind($manifest, $manifest->book('fixture'));
    expect($result['bound'])->toBe(2);
});

test('bibliography rows with no ground-truth label are surfaced', function () {
    $manifest = binderWriteCorpus([
        binderGtEntry('fixture/c01', 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.'),
    ]);
    binderSeedBib([
        'alder2010' => 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.',
        'ghost2020' => 'Ghost, Z. (2020). An entry nobody labelled. Journal X, 9(9), 1-2.',
    ]);

    $result = (new GroundTruthBinder())->bind($manifest, $manifest->book('fixture'));
    expect($result['unlabelled_reference_ids'])->toBe(['ghost2020']);
});

// ── Re-binding after the book was RECONVERTED ────────────────────────────────
//
// referenceIds are minted per conversion, so every one of them changes when a book is
// re-imported. The bind is what re-points ground truth at the new rows — and for an entry
// whose text the reconversion CHANGED (because the old text was our converter's damage, not
// the author's citation) there is deliberately nothing to point at.
//
// saveGroundTruth carries a previous binding forward for any entry that has none, so that a
// GENERATOR rewriting the entries (corrupt / skeleton) does not throw away work. Applied to a
// fresh bind it undid the bind's own verdict: deloitte-2025-pdf came back from a reconversion
// claiming 129 of 129 bound while 11 pointed at footnote rows that had just been deleted.
// ClaimsJoiner keys on bound_reference_id, so a dangling one never errors — it simply never
// joins, and the entry vanishes from the workbench instead of asking to be re-labelled.

test('a bind that clears an entry is not undone by the carry-over', function () {
    $manifest = binderWriteCorpus([
        binderGtEntry('fixture/c01', 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.'),
        binderGtEntry('fixture/c02', 'Text that only ever existed because our converter invented it here.'),
    ]);
    binderSeedBib([
        'alder2010' => 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.',
        'boren2012' => 'Boren, Q. (2012). Second fixture reference with a long enough title. Journal B.',
    ]);

    // First bind: c02 has a counterpart, so both bind.
    $book = $manifest->book('fixture');
    $gt = $manifest->loadGroundTruth($book);
    $gt['entries'][1]['bound_reference_id'] = 'boren2012';
    $manifest->saveGroundTruth($book, $gt);

    // The book is reconverted: c02's text is no longer in it at all.
    expect(fn () => (new GroundTruthBinder())->bind($manifest, $book))
        ->toThrow(RuntimeException::class);

    $after = array_column($manifest->loadGroundTruth($book)['entries'], 'bound_reference_id', 'gt_id');
    expect($after['fixture/c01'])->toBe('alder2010')
        ->and($after['fixture/c02'])->toBeNull('a cleared binding must stay cleared, not be resurrected');
});

test('the carry-over still protects a binding when a GENERATOR rewrites the entries', function () {
    $manifest = binderWriteCorpus([
        binderGtEntry('fixture/c01', 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.'),
    ]);
    binderSeedBib(['alder2010' => 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.']);
    $book = $manifest->book('fixture');
    (new GroundTruthBinder())->bind($manifest, $book);

    // A regeneration rewrites the entries from scratch — no binding block, no bound ids.
    $regenerated = [
        'book' => 'fixture',
        'entries' => [binderGtEntry('fixture/c01', 'Alder, P. (2010). First fixture reference. Journal A, 1(1), 1-10.')],
    ];
    $manifest->saveGroundTruth($book, $regenerated);

    $after = array_column($manifest->loadGroundTruth($book)['entries'], 'bound_reference_id', 'gt_id');
    expect($after['fixture/c01'])->toBe('alder2010', 'a generator must not cost the corpus its bindings');
});
