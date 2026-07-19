<?php

/**
 * Annotation-preserving reconvert: AnnotationSnapshotService (old-node text
 * snapshot) + AnnotationReattachmentService (re-anchor hyperlights/hypercites
 * onto the NEW nodes) + BookContentClearer (annotation sub-books survive the
 * clear). Each test seeds OLD nodes + annotations, snapshots, swaps in NEW
 * nodes (the "reconversion"), runs reattach, and asserts the anchors moved —
 * with the cardinal rule that unmatchable rows are kept + orphan-stamped,
 * never deleted.
 */

use App\Services\Annotations\AnnotationReattachmentService;
use App\Services\Annotations\AnnotationSnapshotService;
use App\Services\Import\BookContentClearer;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

function arDb()
{
    return DB::connection('pgsql_admin');
}

/** Seed nodes: [[node_id, startLine, plainText], …]. */
function arSeedNodes(string $book, array $rows): void
{
    arDb()->table('nodes')->insert(array_map(fn ($r) => [
        'book' => $book, 'node_id' => $r[0], 'chunk_id' => 0, 'startLine' => $r[1],
        'content' => '<p>' . e($r[2]) . '</p>', 'plainText' => $r[2],
    ], $rows));
}

function arSeedHyperlight(string $book, string $id, array $nodeIds, array $charData, string $text, array $extra = []): void
{
    arDb()->table('hyperlights')->insert(array_merge([
        'book' => $book, 'hyperlight_id' => $id,
        'node_id' => json_encode($nodeIds), 'charData' => json_encode($charData),
        'highlightedText' => $text, 'startLine' => '1', 'time_since' => 1,
        'raw_json' => json_encode(['origin' => 'test']),
    ], $extra));
}

function arSeedHypercite(string $book, string $id, array $nodeIds, array $charData, string $text): void
{
    arDb()->table('hypercites')->insert([
        'book' => $book, 'hyperciteId' => $id,
        'node_id' => json_encode($nodeIds), 'charData' => json_encode($charData),
        'hypercitedText' => $text, 'relationshipStatus' => 'couple', 'time_since' => 1,
        'raw_json' => json_encode([]),
    ]);
}

/** Snapshot current nodes, then replace them with the "reconverted" set. */
function arReconvert(string $book, array $newRows): void
{
    app(AnnotationSnapshotService::class)->snapshot($book, arDb());
    arDb()->table('nodes')->where('book', $book)->delete();
    arSeedNodes($book, $newRows);
}

function arHyperlight(string $book, string $id): object
{
    $row = arDb()->table('hyperlights')->where('book', $book)->where('hyperlight_id', $id)->first();
    $row->node_id_arr = json_decode($row->node_id, true);
    $row->charData_arr = json_decode($row->charData, true);
    $row->raw = json_decode($row->raw_json, true);

    return $row;
}

/** The written anchor must carve exactly the expected text out of the NEW node. */
function arAssertAnchors(string $book, array $charData, array $expectations): void
{
    foreach ($expectations as $nodeId => $expected) {
        $plain = arDb()->table('nodes')->where('book', $book)->where('node_id', $nodeId)->value('plainText');
        $cd = $charData[$nodeId];
        expect(mb_substr($plain, $cd['charStart'], $cd['charEnd'] - $cd['charStart']))->toBe($expected);
    }
}

$book = null;

beforeEach(function () use (&$book) {
    $book = 'apitest_ar_' . Str::random(8);
    arDb()->table('library')->insert([
        'book' => $book, 'title' => 'Reattach Test', 'visibility' => 'public',
        'raw_json' => '{}', 'created_at' => now(), 'updated_at' => now(),
    ]);
});

afterEach(function () use (&$book) {
    foreach (['nodes', 'hyperlights', 'hypercites', 'library'] as $t) {
        arDb()->table($t)->where('book', $book)->orWhere('book', 'like', "{$book}/%")->delete();
    }
    File::deleteDirectory(resource_path("markdown/{$book}"));
});

test('identical text: exact reattach, charData recomputed against the new node', function () use (&$book) {
    arSeedNodes($book, [
        ["{$book}_o1", 1, 'The quick brown fox jumps over the lazy dog.'],
        ["{$book}_o2", 2, 'A second paragraph of perfectly ordinary prose.'],
    ]);
    // "brown fox" = chars 10..19 in o1.
    arSeedHyperlight($book, 'hl1', ["{$book}_o1"], ["{$book}_o1" => ['charStart' => 10, 'charEnd' => 19]], 'brown fox');

    arReconvert($book, [
        ["{$book}_n1", 1, 'The quick brown fox jumps over the lazy dog.'],
        ["{$book}_n2", 2, 'A second paragraph of perfectly ordinary prose.'],
    ]);
    $report = app(AnnotationReattachmentService::class)->reattach($book);

    expect($report['reattached'])->toBe(1);
    $hl = arHyperlight($book, 'hl1');
    expect($hl->node_id_arr)->toBe(["{$book}_n1"]);
    expect($hl->raw['reattach']['status'])->toBe('reattached');
    expect($hl->raw['origin'])->toBe('test'); // prior raw_json preserved
    expect($hl->startLine)->toBe('1');
    arAssertAnchors($book, $hl->charData_arr, ["{$book}_n1" => 'brown fox']);
});

test('footnote-marker drift: plain [1] becomes superscript — normalized find still lands', function () use (&$book) {
    arSeedNodes($book, [["{$book}_o1", 1, 'An important claim[1] that scholars dispute at length.']]);
    // "important claim[1] that" = chars 3..26.
    arSeedHyperlight($book, 'hl1', ["{$book}_o1"], ["{$book}_o1" => ['charStart' => 3, 'charEnd' => 26]], 'important claim[1] that');

    // Reconverted: marker now a superscript ¹ and curly apostrophe elsewhere.
    arReconvert($book, [["{$book}_n1", 1, "An important claim\u{00B9} that scholars dispute at length."]]);
    $report = app(AnnotationReattachmentService::class)->reattach($book);

    expect($report['reattached'])->toBe(1);
    $hl = arHyperlight($book, 'hl1');
    expect($hl->node_id_arr)->toBe(["{$book}_n1"]);
    // The located span covers the same words in the NEW text.
    $cd = $hl->charData_arr["{$book}_n1"];
    $plain = arDb()->table('nodes')->where('node_id', "{$book}_n1")->value('plainText');
    expect(mb_substr($plain, $cd['charStart'], $cd['charEnd'] - $cd['charStart']))
        ->toContain('important claim');
});

test('node split in two: the concat fallback carves per-node segments', function () use (&$book) {
    arSeedNodes($book, [["{$book}_o1", 1, 'First sentence of a paragraph. Second sentence follows it closely.']]);
    // Highlight spans both sentences: chars 6..46 = "sentence of a paragraph. Second sentence".
    arSeedHyperlight(
        $book, 'hl1',
        ["{$book}_o1"], ["{$book}_o1" => ['charStart' => 6, 'charEnd' => 47]],
        'sentence of a paragraph. Second sentence',
    );

    // Reconverted: the paragraph split into two nodes.
    arReconvert($book, [
        ["{$book}_n1", 1, 'First sentence of a paragraph.'],
        ["{$book}_n2", 2, 'Second sentence follows it closely.'],
    ]);
    $report = app(AnnotationReattachmentService::class)->reattach($book);

    expect($report['reattached'])->toBe(1);
    $hl = arHyperlight($book, 'hl1');
    expect($hl->node_id_arr)->toBe(["{$book}_n1", "{$book}_n2"]);
    expect($hl->raw['reattach']['method'])->toBe('concat');
    arAssertAnchors($book, $hl->charData_arr, [
        "{$book}_n1" => 'sentence of a paragraph.',
        "{$book}_n2" => 'Second sentence',
    ]);
});

test('nodes merged into one: a multi-node highlight folds to a single anchor', function () use (&$book) {
    arSeedNodes($book, [
        ["{$book}_o1", 1, 'Alpha beta gamma.'],
        ["{$book}_o2", 2, 'Delta epsilon zeta.'],
    ]);
    // Highlight tail of o1 + head of o2.
    arSeedHyperlight($book, 'hl1', ["{$book}_o1", "{$book}_o2"], [
        "{$book}_o1" => ['charStart' => 6, 'charEnd' => 17],  // "beta gamma."
        "{$book}_o2" => ['charStart' => 0, 'charEnd' => 13],  // "Delta epsilon"
    ], 'beta gamma. Delta epsilon');

    // Reconverted: one merged node.
    arReconvert($book, [["{$book}_n1", 1, 'Alpha beta gamma. Delta epsilon zeta.']]);
    $report = app(AnnotationReattachmentService::class)->reattach($book);

    expect($report['reattached'])->toBe(1);
    $hl = arHyperlight($book, 'hl1');
    expect($hl->node_id_arr)->toBe(["{$book}_n1"]);
    arAssertAnchors($book, $hl->charData_arr, ["{$book}_n1" => 'beta gamma. Delta epsilon']);
});

test('duplicate paragraphs: order-preserving buckets keep two identical nodes distinct', function () use (&$book) {
    $dup = 'And so it goes, again and again, exactly the same.';
    arSeedNodes($book, [
        ["{$book}_o1", 1, $dup],
        ["{$book}_o2", 2, 'A distinct middle paragraph sits between the twins.'],
        ["{$book}_o3", 3, $dup],
    ]);
    arSeedHyperlight($book, 'hl_first', ["{$book}_o1"], ["{$book}_o1" => ['charStart' => 0, 'charEnd' => 6]], 'And so');
    arSeedHyperlight($book, 'hl_last', ["{$book}_o3"], ["{$book}_o3" => ['charStart' => 0, 'charEnd' => 6]], 'And so');

    arReconvert($book, [
        ["{$book}_n1", 1, $dup],
        ["{$book}_n2", 2, 'A distinct middle paragraph sits between the twins.'],
        ["{$book}_n3", 3, $dup],
    ]);
    $report = app(AnnotationReattachmentService::class)->reattach($book);

    expect($report['reattached'])->toBe(2);
    expect(arHyperlight($book, 'hl_first')->node_id_arr)->toBe(["{$book}_n1"]);
    expect(arHyperlight($book, 'hl_last')->node_id_arr)->toBe(["{$book}_n3"]);
});

test('deleted paragraph: the row is KEPT, pointers untouched, orphan-stamped', function () use (&$book) {
    arSeedNodes($book, [
        ["{$book}_o1", 1, 'This paragraph will vanish in the reconversion entirely.'],
        ["{$book}_o2", 2, 'This one survives.'],
    ]);
    arSeedHyperlight($book, 'hl1', ["{$book}_o1"], ["{$book}_o1" => ['charStart' => 0, 'charEnd' => 14]], 'This paragraph will vanish');

    arReconvert($book, [["{$book}_n2", 1, 'This one survives.']]);
    $report = app(AnnotationReattachmentService::class)->reattach($book);

    expect($report['orphaned'])->toBe(1);
    $hl = arHyperlight($book, 'hl1');
    expect($hl->node_id_arr)->toBe(["{$book}_o1"]); // untouched dead pointer — renders as nothing
    expect($hl->raw['reattach']['status'])->toBe('orphaned');
    expect($hl->raw['origin'])->toBe('test');
    // Snapshot preserved for a future retry.
    expect(File::exists(resource_path("markdown/{$book}/annotation_snapshot.used.json")))->toBeTrue();
});

test('ghost hypercite (-1 anchors): node ids remap, charData stays ghostly', function () use (&$book) {
    $text = 'A ghostly paragraph that moved between conversions.';
    arSeedNodes($book, [["{$book}_o1", 1, $text]]);
    arSeedHypercite($book, 'hc1', ["{$book}_o1"], ["{$book}_o1" => ['charStart' => -1, 'charEnd' => -1]], '');

    arReconvert($book, [
        ["{$book}_nX", 1, 'A brand new opening paragraph.'],
        ["{$book}_n1", 2, $text],
    ]);
    $report = app(AnnotationReattachmentService::class)->reattach($book);

    expect($report['reattached'])->toBe(1);
    $row = arDb()->table('hypercites')->where('book', $book)->where('hyperciteId', 'hc1')->first();
    expect(json_decode($row->node_id, true))->toBe(["{$book}_n1"]);
    // toEqual not toBe: Postgres jsonb normalizes key order.
    expect(json_decode($row->charData, true)["{$book}_n1"])->toEqual(['charStart' => -1, 'charEnd' => -1]);
});

test('hypercite text anchors reattach like hyperlights', function () use (&$book) {
    arSeedNodes($book, [["{$book}_o1", 1, 'The cited passage lives here, in the middle of prose.']]);
    arSeedHypercite($book, 'hc1', ["{$book}_o1"], ["{$book}_o1" => ['charStart' => 4, 'charEnd' => 17]], 'cited passage');

    arReconvert($book, [["{$book}_n1", 1, 'Preamble added. The cited passage lives here, in the middle of prose.']]);
    $report = app(AnnotationReattachmentService::class)->reattach($book);

    expect($report['reattached'])->toBe(1);
    $row = arDb()->table('hypercites')->where('book', $book)->where('hyperciteId', 'hc1')->first();
    $cd = json_decode($row->charData, true)["{$book}_n1"];
    $plain = arDb()->table('nodes')->where('node_id', "{$book}_n1")->value('plainText');
    expect(mb_substr($plain, $cd['charStart'], $cd['charEnd'] - $cd['charStart']))->toBe('cited passage');
});

test('no snapshot → reattach is a no-op (fresh imports unaffected)', function () use (&$book) {
    arSeedNodes($book, [["{$book}_n1", 1, 'Fresh import, no history.']]);
    $report = app(AnnotationReattachmentService::class)->reattach($book);
    expect($report['skipped'])->toBe('no snapshot');
});

test('clearBookContent preserves annotation sub-books, clears footnote sub-books', function () use (&$book) {
    arSeedNodes($book, [["{$book}_o1", 1, 'Main content.']]);

    // A footnote sub-book (regenerated on reconvert — must be cleared)…
    arDb()->table('library')->insert([
        'book' => "{$book}/Fn1", 'title' => 'Fn', 'type' => 'sub_book', 'visibility' => 'public',
        'raw_json' => '{}', 'created_at' => now(), 'updated_at' => now(),
    ]);
    arSeedNodes("{$book}/Fn1", [["{$book}/Fn1_x", 1, 'Footnote body.']]);

    // …and a hyperlight ANNOTATION sub-book (user-authored — must SURVIVE).
    $annotationSub = "{$book}/hl_note_1";
    arDb()->table('library')->insert([
        'book' => $annotationSub, 'title' => 'My annotation', 'type' => 'sub_book', 'visibility' => 'public',
        'raw_json' => '{}', 'created_at' => now(), 'updated_at' => now(),
    ]);
    arSeedNodes($annotationSub, [["{$annotationSub}_x", 1, 'The reader wrote this essay under a highlight.']]);
    arSeedHyperlight(
        $book, 'hl_note_1',
        ["{$book}_o1"], ["{$book}_o1" => ['charStart' => 0, 'charEnd' => 4]], 'Main',
        ['sub_book_id' => $annotationSub],
    );

    app(BookContentClearer::class)->clear($book, arDb());

    // Footnote sub-book gone; annotation sub-book (library + nodes) intact.
    expect(arDb()->table('library')->where('book', "{$book}/Fn1")->exists())->toBeFalse();
    expect(arDb()->table('nodes')->where('book', "{$book}/Fn1")->exists())->toBeFalse();
    expect(arDb()->table('library')->where('book', $annotationSub)->exists())->toBeTrue();
    expect(arDb()->table('nodes')->where('book', $annotationSub)->count())->toBe(1);
    // Main content cleared; hyperlight row untouched.
    expect(arDb()->table('nodes')->where('book', $book)->exists())->toBeFalse();
    expect(arDb()->table('hyperlights')->where('book', $book)->exists())->toBeTrue();
});
