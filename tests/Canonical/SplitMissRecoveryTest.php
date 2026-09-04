<?php

/**
 * Split-miss recovery: when a footnote's raw text carries a semicolon-separated
 * multi-work signature but its (possibly cached) llm_metadata is single-work,
 * the scan re-runs extraction with a must-split instruction and — on success —
 * replaces the metadata with primary + sub_citations, so the missed works enter
 * the ordinary sub-citation search. A retry that still returns one work leaves
 * the metadata untouched (the report's render-side warning is the backstop).
 *
 * Also: fetchEntries falls back to the footnotes table when a referenceId isn't
 * a bibliography row — before this, `citation:scan-bibliography book:fnId` on a
 * footnote-only book found nothing (single-footnote re-scans were impossible).
 */

use App\Jobs\CitationScanBibliographyJob;
use App\Services\LlmService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function smrDb()
{
    return DB::connection('pgsql_admin');
}

function smrSeed(string $book, array $footnotes): void
{
    smrDb()->table('library')->insert([
        'book' => $book, 'title' => 'SMR Test Book', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    foreach ($footnotes as $fn) {
        smrDb()->table('footnotes')->insert([
            'book' => $book, 'footnoteId' => $fn['id'],
            'content' => $fn['content'], 'is_citation' => true,
            'llm_metadata' => json_encode($fn['meta']),
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
}

function smrCleanup(string $book): void
{
    smrDb()->table('footnotes')->where('book', $book)->delete();
    smrDb()->table('library')->where('book', $book)->delete();
}

const SMR_UNSPLIT_CONTENT = '<p>Department of Finance (Cth), Risk Management Toolkit (Web Page, 2023) '
    . 'https://www.finance.gov.au/toolkit ; Institute of Internal Auditors, '
    . 'The IIA Three Lines Model (Position Paper, July 2020).</p>';

test('recoverUnsplitFootnotes re-splits and persists primary + sub_citations', function () {
    $book = 'smr_' . Str::random(8);
    $singleMeta = ['type' => 'website', 'title' => 'Risk Management Toolkit', 'year' => 2023];
    smrSeed($book, [['id' => 'fn1', 'content' => SMR_UNSPLIT_CONTENT, 'meta' => $singleMeta]]);

    try {
        $llm = Mockery::mock(LlmService::class);
        $llm->shouldReceive('extractFootnoteCitationsBatch')
            ->once()
            ->withArgs(fn ($citations, $emphasise) => array_keys($citations) === ['fn1'] && $emphasise === true)
            ->andReturn(['fn1' => [
                ['type' => 'website', 'title' => 'Risk Management Toolkit', 'year' => 2023],
                ['type' => 'report', 'title' => 'The IIA Three Lines Model', 'year' => 2020],
            ]]);

        $job = new CitationScanBibliographyJob('scan_smr1', $book);
        $ref = new ReflectionClass($job);
        $ref->getProperty('sourceTable')->setValue($job, 'footnotes');

        $entry = (object) ['referenceId' => 'fn1', 'content' => SMR_UNSPLIT_CONTENT];
        $metaMap = ['fn1' => $singleMeta];
        $ref->getMethod('recoverUnsplitFootnotes')->invokeArgs($job, [smrDb(), $llm, [$entry], &$metaMap]);

        // In-memory map re-split
        expect($metaMap['fn1']['title'])->toBe('Risk Management Toolkit');
        expect($metaMap['fn1']['sub_citations'])->toHaveCount(1);
        expect($metaMap['fn1']['sub_citations'][0]['title'])->toBe('The IIA Three Lines Model');

        // Cached row re-split
        $stored = json_decode(smrDb()->table('footnotes')->where('book', $book)->where('footnoteId', 'fn1')->value('llm_metadata'), true);
        expect($stored['sub_citations'][0]['title'])->toBe('The IIA Three Lines Model');
    } finally {
        smrCleanup($book);
    }
});

test('recoverUnsplitFootnotes leaves metadata untouched when the retry still returns one work', function () {
    $book = 'smr_' . Str::random(8);
    $singleMeta = ['type' => 'website', 'title' => 'Risk Management Toolkit', 'year' => 2023];
    smrSeed($book, [['id' => 'fn1', 'content' => SMR_UNSPLIT_CONTENT, 'meta' => $singleMeta]]);

    try {
        $llm = Mockery::mock(LlmService::class);
        $llm->shouldReceive('extractFootnoteCitationsBatch')->once()
            ->andReturn(['fn1' => [['type' => 'website', 'title' => 'Risk Management Toolkit', 'year' => 2023]]]);

        $job = new CitationScanBibliographyJob('scan_smr2', $book);
        $ref = new ReflectionClass($job);
        $ref->getProperty('sourceTable')->setValue($job, 'footnotes');

        $entry = (object) ['referenceId' => 'fn1', 'content' => SMR_UNSPLIT_CONTENT];
        $metaMap = ['fn1' => $singleMeta];
        $ref->getMethod('recoverUnsplitFootnotes')->invokeArgs($job, [smrDb(), $llm, [$entry], &$metaMap]);

        expect($metaMap['fn1'])->toEqual($singleMeta);
        $stored = json_decode(smrDb()->table('footnotes')->where('book', $book)->where('footnoteId', 'fn1')->value('llm_metadata'), true);
        expect($stored)->toEqual($singleMeta);
    } finally {
        smrCleanup($book);
    }
});

test('recoverUnsplitFootnotes ignores already-split and clean single-work footnotes', function () {
    $book = 'smr_' . Str::random(8);
    smrSeed($book, [
        ['id' => 'fn_split', 'content' => SMR_UNSPLIT_CONTENT,
         'meta' => ['type' => 'website', 'title' => 'A', 'sub_citations' => [['type' => 'report', 'title' => 'B']]]],
        ['id' => 'fn_clean', 'content' => '<p>Author, A Single Work (Publisher, 2020).</p>',
         'meta' => ['type' => 'book', 'title' => 'A Single Work']],
    ]);

    try {
        $llm = Mockery::mock(LlmService::class);
        $llm->shouldNotReceive('extractFootnoteCitationsBatch');

        $job = new CitationScanBibliographyJob('scan_smr3', $book);
        $ref = new ReflectionClass($job);
        $ref->getProperty('sourceTable')->setValue($job, 'footnotes');

        $entries = [
            (object) ['referenceId' => 'fn_split', 'content' => SMR_UNSPLIT_CONTENT],
            (object) ['referenceId' => 'fn_clean', 'content' => '<p>Author, A Single Work (Publisher, 2020).</p>'],
        ];
        $metaMap = [
            'fn_split' => ['type' => 'website', 'title' => 'A', 'sub_citations' => [['type' => 'report', 'title' => 'B']]],
            'fn_clean' => ['type' => 'book', 'title' => 'A Single Work'],
        ];
        $ref->getMethod('recoverUnsplitFootnotes')->invokeArgs($job, [smrDb(), $llm, $entries, &$metaMap]);
        expect(true)->toBeTrue(); // shouldNotReceive verified on teardown
    } finally {
        smrCleanup($book);
    }
});

test('fetchEntries targets a single FOOTNOTE by referenceId on a footnote-only book', function () {
    $book = 'smr_' . Str::random(8);
    smrSeed($book, [
        ['id' => 'fn1', 'content' => '<p>One.</p>', 'meta' => ['type' => 'book', 'title' => 'One']],
        ['id' => 'fn2', 'content' => '<p>Two.</p>', 'meta' => ['type' => 'book', 'title' => 'Two']],
    ]);

    try {
        $job = new CitationScanBibliographyJob('scan_smr4', $book, 'fn2');
        $ref = new ReflectionClass($job);
        $entries = $ref->getMethod('fetchEntries')->invoke($job, smrDb());

        expect($entries)->toHaveCount(1);
        expect($entries->first()->referenceId)->toBe('fn2');
        expect($ref->getProperty('sourceTable')->getValue($job))->toBe('footnotes');
    } finally {
        smrCleanup($book);
    }
});
