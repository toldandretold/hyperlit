<?php

/**
 * Multi-work footnotes: per-sub-citation resolution outcomes must be PERSISTED
 * onto the parent row's llm_metadata (sub_citations[i].resolution). Before this,
 * a sub-citation's search outcome was recorded nowhere — the no-match loop
 * skipped ::sub pool keys — so the review could not tell that a footnote's
 * second work (e.g. a possibly-fabricated journal article) was searched and not
 * found. The ::subN key suffix is 1-based into the sub_citations array.
 */

use App\Jobs\CitationScanBibliographyJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function subPersistDb()
{
    return DB::connection('pgsql_admin');
}

test('persistSubResolutions writes matched and no_match outcomes into the parent llm_metadata', function () {
    $db = subPersistDb();
    $book = 'book_canonv_subres_' . Str::random(8);
    $fnId = 'fn_parent_1';

    $meta = [
        'type' => 'report', 'title' => 'ANAO Report', 'authors' => ['ANAO'],
        'sub_citations' => [
            ['type' => 'journal-article', 'title' => 'Carney Article'],
            ['type' => 'journal-article', 'title' => 'Second Article'],
        ],
    ];

    $db->table('library')->insert([
        'book' => $book, 'title' => 'SubRes Test Book', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    $db->table('footnotes')->insert([
        'book' => $book, 'footnoteId' => $fnId,
        'content' => '<p>ANAO, Report (2014); Carney, Article (2018); Other, Article (2019).</p>',
        'is_citation' => true,
        'llm_metadata' => json_encode($meta),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    try {
        $job = new CitationScanBibliographyJob('scan_subres', $book);

        $ref = new ReflectionClass($job);
        $ref->getProperty('sourceTable')->setValue($job, 'footnotes');
        $ref->getProperty('subResolutions')->setValue($job, [
            $fnId => [
                "{$fnId}::sub1" => ['status' => 'no_match', 'searched_title' => 'Carney Article'],
                "{$fnId}::sub2" => ['status' => 'matched', 'book' => 'stub_book_x'],
            ],
        ]);

        $ref->getMethod('persistSubResolutions')->invoke($job, $db, [$fnId => $meta]);

        $stored = json_decode(
            $db->table('footnotes')->where('book', $book)->where('footnoteId', $fnId)->value('llm_metadata'),
            true
        );

        // toEqual, not toBe: Postgres jsonb reorders object keys on storage
        expect($stored['sub_citations'][0]['resolution'])
            ->toEqual(['status' => 'no_match', 'searched_title' => 'Carney Article']);
        expect($stored['sub_citations'][1]['resolution'])
            ->toEqual(['status' => 'matched', 'book' => 'stub_book_x']);
        // Primary metadata untouched
        expect($stored['type'])->toBe('report');
        expect($stored['title'])->toBe('ANAO Report');
    } finally {
        $db->table('footnotes')->where('book', $book)->delete();
        $db->table('library')->where('book', $book)->delete();
    }
});

test('persistSubResolutions is a no-op for parents without sub_citations metadata', function () {
    $db = subPersistDb();
    $book = 'book_canonv_subres_' . Str::random(8);
    $fnId = 'fn_solo_1';
    $meta = ['type' => 'report', 'title' => 'Solo Report'];

    $db->table('library')->insert([
        'book' => $book, 'title' => 'SubRes Noop Book', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    $db->table('footnotes')->insert([
        'book' => $book, 'footnoteId' => $fnId,
        'content' => '<p>Solo.</p>', 'is_citation' => true,
        'llm_metadata' => json_encode($meta),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    try {
        $job = new CitationScanBibliographyJob('scan_subres2', $book);
        $ref = new ReflectionClass($job);
        $ref->getProperty('sourceTable')->setValue($job, 'footnotes');
        // A stray outcome for a parent whose metadata has no subs must not corrupt the row
        $ref->getProperty('subResolutions')->setValue($job, [
            $fnId => ["{$fnId}::sub1" => ['status' => 'no_match', 'searched_title' => 'Ghost']],
        ]);

        $ref->getMethod('persistSubResolutions')->invoke($job, $db, [$fnId => $meta]);

        $stored = json_decode(
            $db->table('footnotes')->where('book', $book)->where('footnoteId', $fnId)->value('llm_metadata'),
            true
        );
        expect($stored)->toEqual($meta);
    } finally {
        $db->table('footnotes')->where('book', $book)->delete();
        $db->table('library')->where('book', $book)->delete();
    }
});

test('a resolved sub-citation records HOW it resolved (match_method / match_score)', function () {
    // A sub has no row of its own, so the wave's updateSourceEntry() write of match_method
    // updated nothing and the method was lost — every multi-work sub-claim reached the review
    // method-less, web-search hits included (deloitte-2025-pdf). The scan now carries it into
    // the sub's resolution record.
    $db = subPersistDb();
    $job = new CitationScanBibliographyJob('scan_subres', 'book_canonv_subres_' . Str::random(8));
    $ref = new ReflectionClass($job);
    $ref->getProperty('sourceTable')->setValue($job, 'bibliography'); // no parent write-back

    $pool = [
        'fn1::sub1' => ['referenceId' => 'fn1::sub1', 'parentRefId' => 'fn1'],
        'fn1::sub2' => ['referenceId' => 'fn1::sub2', 'parentRefId' => 'fn1'],
    ];
    $job->updateSourceEntry($db, 'fn1::sub1', ['foundation_source' => 'web_x', 'match_method' => 'brave_search', 'match_score' => null]);
    $job->removeRelatedPoolEntries($pool, 'fn1::sub1', $db, 'web_x');
    $job->updateSourceEntry($db, 'fn1::sub2', ['foundation_source' => 'b_y', 'match_method' => 'openalex', 'match_score' => 0.91]);
    $job->removeRelatedPoolEntries($pool, 'fn1::sub2', $db, 'b_y');

    $outcomes = $ref->getProperty('subResolutions')->getValue($job)['fn1'];
    expect($outcomes['fn1::sub1'])->toBe(['status' => 'matched', 'book' => 'web_x', 'match_method' => 'brave_search'])
        ->and($outcomes['fn1::sub2'])->toBe(['status' => 'matched', 'book' => 'b_y', 'match_method' => 'openalex', 'match_score' => 0.91])
        ->and($pool)->toBe([]);
});
