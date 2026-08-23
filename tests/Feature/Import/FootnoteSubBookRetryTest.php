<?php

/**
 * ProcessDocumentImportJob::saveFootnotesToDatabase must be retry-safe.
 *
 * The job re-runs wholesale on queue retry ($tries = 3), and an attempt that
 * dies AFTER its chunked footnote inserts has already committed footnotes +
 * sub-book library + nodes rows. The next attempt used to die on
 * library_pkey (duplicate key) because the pre-insert cleanup deleted with
 * the pattern "{$book}/Fn%" — but pipeline footnote ids look like
 * "seq1_Fn177…_kq0t", so the delete matched nothing. (The same bug was
 * already fixed in the sub_book visibility trigger migration and never
 * ported here.)
 *
 * These tests lock: a retry that re-streams the SAME footnote ids does not
 * throw and leaves exactly one row set; stale sub-books from a prior run are
 * cleared even with new-style seq{n}_Fn ids; and user annotation sub-books
 * (hyperlights.sub_book_id) survive the clear, same as BookContentClearer.
 */

use App\Jobs\ProcessDocumentImportJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

function fnrDb()
{
    return DB::connection('pgsql_admin');
}

function fnrInvoke(string $path, string $book): void
{
    $job = new ProcessDocumentImportJob($book, 'pdf', null, [], []);
    $ref = new ReflectionMethod($job, 'saveFootnotesToDatabase');
    $ref->setAccessible(true);
    $ref->invoke($job, $path, $book);
}

/** Seed the three rows attempt 1 would have committed for one footnote. */
function fnrSeedCommittedFootnote(string $book, string $footnoteId): void
{
    $sub = "{$book}/{$footnoteId}";
    fnrDb()->table('footnotes')->insert([
        'book' => $book, 'footnoteId' => $footnoteId, 'content' => '<p>old</p>',
        'sub_book_id' => $sub, 'preview_nodes' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    fnrDb()->table('library')->insert([
        'book' => $sub, 'type' => 'sub_book', 'title' => "Annotation: {$footnoteId}",
        'has_nodes' => true, 'raw_json' => json_encode([]), 'timestamp' => 1,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    fnrDb()->table('nodes')->insert([
        'book' => $sub, 'node_id' => (string) Str::uuid(), 'chunk_id' => 0, 'startLine' => 1,
        'content' => '<p>old</p>', 'plainText' => 'old',
        'created_at' => now(), 'updated_at' => now(),
    ]);
}

$book = null;
$path = null;

beforeEach(function () use (&$book, &$path) {
    $book = 'apitest_fnr_'.Str::random(8);
    $path = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($path);
    fnrDb()->table('library')->insert([
        'book' => $book, 'title' => 'Footnote Retry Test', 'visibility' => 'private',
        'raw_json' => '{}', 'created_at' => now(), 'updated_at' => now(),
    ]);
});

afterEach(function () use (&$book, &$path) {
    fnrDb()->table('footnotes')->where('book', $book)->delete();
    foreach (['nodes', 'hyperlights', 'library'] as $t) {
        fnrDb()->table($t)->where('book', $book)->orWhere('book', 'like', "{$book}/%")->delete();
    }
    File::deleteDirectory($path);
});

test('retry re-streaming the same footnote ids does not die on library_pkey', function () use (&$book, &$path) {
    $fnId = 'seq1_Fn1787478148715_kq0t';
    fnrSeedCommittedFootnote($book, $fnId); // attempt 1's committed partial work
    fnrSeedCommittedFootnote($book, 'seq1_Fn1787478148715_a4x3');

    File::put("{$path}/footnotes.jsonl",
        json_encode(['footnoteId' => $fnId, 'content' => '<p>same id again</p>'])."\n".
        json_encode(['footnoteId' => 'seq1_Fn1787478148715_a4x3', 'content' => '<p>same id again</p>'])."\n"
    );

    fnrInvoke($path, $book); // would have thrown SQLSTATE[23505] before the fix

    expect(fnrDb()->table('library')->where('book', "{$book}/{$fnId}")->count())->toBe(1);
    expect(fnrDb()->table('footnotes')->where('book', $book)->count())->toBe(2);
    expect(fnrDb()->table('footnotes')->where('book', $book)->where('footnoteId', $fnId)->value('content'))
        ->toBe('<p>same id again</p>');
});

test('stale seq{n}_Fn sub-books from a prior run are cleared', function () use (&$book, &$path) {
    $stale = 'seq1_Fn1700000000000_dead';
    fnrSeedCommittedFootnote($book, $stale);

    File::put("{$path}/footnotes.jsonl",
        json_encode(['footnoteId' => 'seq1_Fn1787478148715_new1', 'content' => '<p>fresh</p>'])."\n"
    );

    fnrInvoke($path, $book);

    expect(fnrDb()->table('library')->where('book', "{$book}/{$stale}")->exists())->toBeFalse();
    expect(fnrDb()->table('nodes')->where('book', "{$book}/{$stale}")->exists())->toBeFalse();
    expect(fnrDb()->table('footnotes')->where('book', $book)->pluck('footnoteId')->all())
        ->toBe(['seq1_Fn1787478148715_new1']);
});

test('user annotation sub-books survive the footnote clear', function () use (&$book, &$path) {
    $annotationSub = "{$book}/ann_user_note_1";
    fnrDb()->table('library')->insert([
        'book' => $annotationSub, 'type' => 'sub_book', 'title' => 'My note',
        'has_nodes' => true, 'raw_json' => json_encode([]), 'timestamp' => 1,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    fnrDb()->table('nodes')->insert([
        'book' => $annotationSub, 'node_id' => (string) Str::uuid(), 'chunk_id' => 0, 'startLine' => 1,
        'content' => '<p>user note</p>', 'plainText' => 'user note',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    fnrDb()->table('hyperlights')->insert([
        'book' => $book, 'hyperlight_id' => 'hl_ann',
        'node_id' => json_encode(['n1']), 'charData' => json_encode([]),
        'highlightedText' => 'x', 'startLine' => '1', 'time_since' => 1,
        'sub_book_id' => $annotationSub, 'raw_json' => json_encode([]),
    ]);

    File::put("{$path}/footnotes.jsonl",
        json_encode(['footnoteId' => 'seq1_Fn1787478148715_new1', 'content' => '<p>fresh</p>'])."\n"
    );

    fnrInvoke($path, $book);

    expect(fnrDb()->table('library')->where('book', $annotationSub)->exists())->toBeTrue();
    expect(fnrDb()->table('nodes')->where('book', $annotationSub)->exists())->toBeTrue();
});
