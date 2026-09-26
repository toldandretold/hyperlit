<?php

/**
 * Before a corpus entry can carry a verdict about the AUTHOR's citation, something has to
 * answer "is this text even what the document says?" — otherwise a labeller is grading our
 * own conversion and calling it the author's work.
 *
 * Triage answers it from the source document's own text. It could not, for any pathway
 * corpus: `pdfPathFor` looked only at `provenance.source_book_id`, which a book adopted from
 * a RAW FILE does not have, so all 129 of deloitte-2025-pdf's entries reported `no_witness`
 * and the workbench's conversion-check pane said "no triage data" forever — while the PDF sat
 * in the corpus directory beside the ground truth. The same shape killed the second witness:
 * `referenceListRows` was handed the raw PDF BYTES, so the document's own Reference List
 * appendix (which prints every note's number, page and full text) yielded zero rows.
 *
 * And the one witness that did run had a false negative that hid the very cases this was
 * bought for: a token absent from the document was forgiven if it appeared in the document's
 * SPACE-STRIPPED text, which for a short token is pure coincidence — "thaw" is inside
 * "wi(th a w)arning" and "stoe" inside "citizen(s to e)nsure", so "Failing Thaw It Is Intended
 * to Serve" and a junk definition "StoE" both reported CLEAN.
 */

use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\GroundTruthTriage;
use Illuminate\Support\Facades\File;

const TRIAGE_ROOT = 'storage/framework/testing/citation-study-triage';

function triageCorpus(string $sourceName, string $sourceBody, array $entries): array
{
    config(['study.root' => TRIAGE_ROOT]);
    $dir = base_path(TRIAGE_ROOT . '/corpora/triagetest');
    File::ensureDirectoryExists($dir . '/sources/fixture');
    File::put($dir . '/sources/fixture/' . $sourceName, $sourceBody);
    File::put($dir . '/sources/fixture/ground_truth.json', json_encode([
        'book' => 'fixture',
        'entries' => $entries,
    ]));
    File::put($dir . '/manifest.json', json_encode([
        'corpus' => 'triagetest',
        'frozen' => false,
        'books' => [[
            'slug' => 'fixture',
            'arm' => 'control',
            'source_file' => 'sources/fixture/' . $sourceName,
            'ground_truth' => 'sources/fixture/ground_truth.json',
            'default_label' => 'intact',
            'provenance' => ['source_book_id' => null],
        ]],
    ]));
    $manifest = CorpusManifest::load('triagetest');
    return [$manifest, $manifest->book('fixture')];
}

function triageEntry(string $id, string $text): array
{
    return [
        'gt_id' => 'fixture/' . $id,
        'label' => 'intact',
        'bib_text_normalized' => $text,
        'corruption_meta' => null,
    ];
}

afterEach(function () {
    File::deleteDirectory(base_path(TRIAGE_ROOT));
});

test('a pathway book adopted from a raw HTML file still gets a source witness', function () {
    [$manifest, $book] = triageCorpus('original.html', <<<'HTML'
        <html><body>
        <p>Senate Education and Employment References Committee,
        <em>Jobactive: Failing Those It Is Intended to Serve</em> (Report, February 2019).</p>
        </body></html>
        HTML, [triageEntry('c01', 'senate education and employment references committee jobactive failing those it is intended to serve report february 2019')]);

    $result = app(GroundTruthTriage::class)->triage($manifest, $book);

    expect($result['witnesses']['pdf'])->toBeTrue()
        ->and($result['entries'][0]['status'])->toBe(GroundTruthTriage::CLEAN);
});

test('a word the document never contains is reported as invented, however short', function () {
    [$manifest, $book] = triageCorpus('original.html', <<<'HTML'
        <html><body>
        <p>Nothing here will warn the reader, and citizens to ensure compliance.</p>
        <p>Senate Education and Employment References Committee,
        Jobactive: Failing Those It Is Intended to Serve (Report, February 2019).</p>
        </body></html>
        HTML, [
        // "thaw" is inside "wi(th a w)arning"-shaped text; "stoe" inside "citizen(s to e)nsure".
        // Both are absent from the document as WORDS, which is the only question that matters.
        triageEntry('c01', 'senate education and employment references committee jobactive failing thaw it is intended to serve report february 2019'),
        triageEntry('c02', 'stoe and some further text so the entry is long enough to judge'),
    ]);

    $result = app(GroundTruthTriage::class)->triage($manifest, $book);
    $byId = collect($result['entries'])->keyBy('gt_id');

    expect($byId['fixture/c01']['status'])->toBe(GroundTruthTriage::OCR_GARBLED)
        ->and($byId['fixture/c01']['invented_tokens'])->toContain('thaw')
        ->and($byId['fixture/c02']['status'])->toBe(GroundTruthTriage::OCR_GARBLED)
        ->and($byId['fixture/c02']['invented_tokens'])->toContain('stoe');
});

test('a long word the document writes unsplit is still a spacing artifact, not an invention', function () {
    // The allowance the length floor must not take away: our converter split a word the
    // document writes as one ("marketdriven" -> "market driven"), which is not an invention.
    [$manifest, $book] = triageCorpus('original.html',
        '<html><body><p>A study of marketdriven welfare administration.</p></body></html>',
        [triageEntry('c01', 'a study of market driven welfare administration')]);

    $result = app(GroundTruthTriage::class)->triage($manifest, $book);

    expect($result['entries'][0]['status'])->toBe(GroundTruthTriage::CLEAN)
        ->and($result['entries'][0]['invented_tokens'])->toBe([]);
});

test('marked-up author names are not read as words the converter invented', function () {
    // strip_tags would glue "<span>Hansen</span><span>, </span>" into one token and every
    // surname in a marked-up reference list would read as invented — 8 of barnett-2020-paste's
    // 26 entries, on a PASTE pathway that cannot invent a word at all.
    [$manifest, $book] = triageCorpus('original.html',
        '<html><body><ol><li><span>Hansen</span><span>, </span><span>Larsen</span>'
        . '<span> (2020) A study of something.</span></li></ol></body></html>',
        [triageEntry('c01', 'hansen larsen 2020 a study of something')]);

    $result = app(GroundTruthTriage::class)->triage($manifest, $book);

    expect($result['entries'][0]['invented_tokens'])->toBe([])
        ->and($result['entries'][0]['status'])->toBe(GroundTruthTriage::CLEAN);
});

test('a pathway with no readable source says so instead of guessing', function () {
    [$manifest, $book] = triageCorpus('original.epub', 'PK binary container bytes',
        [triageEntry('c01', 'some citation text that cannot be checked against anything')]);

    $result = app(GroundTruthTriage::class)->triage($manifest, $book);

    expect($result['witnesses']['pdf'])->toBeFalse()
        ->and($result['entries'][0]['status'])->toBe(GroundTruthTriage::NO_WITNESS);
});
