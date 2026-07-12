<?php

/**
 * ContentFetchService's citation-OCR save path — the step that turns a
 * vacuumed+OCR'd PDF into nodes, which AutoVersionResolver then requires
 * (has_nodes=true) before wiring auto_version_book.
 *
 * Regression guarded here: the conversion pipeline emits nodes.jsonl /
 * footnotes.jsonl (streamed), while nodes.json is a renumbered artifact the
 * SAVER produces. ContentFetchService used to wait for and read nodes.json,
 * so every citation OCR run "timed out" after a successful conversion — which
 * is why only one auto version ever existed.
 */

use App\Services\ContentFetchService;
use Illuminate\Support\Facades\File;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
    canonvDb()->table('nodes')->where('book', 'LIKE', 'book_canonv_%')->delete();
    canonvDb()->table('footnotes')->where('book', 'LIKE', 'book_canonv_%')->delete();
});

function canonvInvoke(string $method, string $dir, string $book): void
{
    $svc = app(ContentFetchService::class);
    $ref = new ReflectionMethod($svc, $method);
    $ref->setAccessible(true);
    $ref->invoke($svc, $dir, $book);
}

function canonvWorkDir(string $book): string
{
    $dir = resource_path("markdown/{$book}");
    File::makeDirectory($dir, 0755, true);
    return $dir;
}

test('node save consumes the pipeline nodes.jsonl contract and emits the nodes.json artifact', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Jsonl Contract', 'has_nodes' => false]);
    $dir = canonvWorkDir($book);

    File::put("{$dir}/nodes.jsonl",
        json_encode(['content' => '<p>first node</p>', 'plainText' => 'first node', 'type' => 'p']) . "\n" .
        json_encode(['content' => '<p>second node</p>', 'plainText' => 'second node', 'type' => 'p']) . "\n"
    );

    try {
        canonvInvoke('saveNodesToDatabase', $dir, $book);

        expect(canonvDb()->table('nodes')->where('book', $book)->count())->toBe(2);

        // The renumbered nodes.json artifact (read by the editor saver) must
        // exist WITHOUT clobbering the pipeline's nodes.jsonl.
        expect(File::exists("{$dir}/nodes.json"))->toBeTrue();
        expect(File::exists("{$dir}/nodes.jsonl"))->toBeTrue();
        $artifact = json_decode(File::get("{$dir}/nodes.json"), true);
        expect($artifact)->toHaveCount(2);
        expect($artifact[0]['startLine'])->toBe(100);
    } finally {
        File::deleteDirectory($dir);
    }
});

test('footnote save accepts the pipeline footnotes.jsonl format', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Footnote Jsonl', 'has_nodes' => false]);
    $dir = canonvWorkDir($book);

    File::put("{$dir}/footnotes.jsonl",
        json_encode(['footnoteId' => '1', 'content' => '<p>a footnote</p>']) . "\n"
    );

    try {
        canonvInvoke('saveFootnotesToDatabase', $dir, $book);

        expect(canonvDb()->table('footnotes')->where('book', $book)->count())->toBe(1);
        // Enriched legacy artifact written alongside
        expect(File::exists("{$dir}/footnotes.json"))->toBeTrue();
    } finally {
        File::deleteDirectory($dir);
    }
});

test('footnote save clears stale sub-books from a prior conversion (no orphans)', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Footnote Reconvert', 'has_nodes' => false]);
    $dir = canonvWorkDir($book);

    // Simulate a PRIOR conversion's footnote sub-book with an old id that a re-OCR will not reuse.
    $staleSub = $book . '/oldFn_stale';
    canonvDb()->table('footnotes')->insert([
        'book' => $book, 'footnoteId' => 'oldFn_stale', 'content' => '<p>stale</p>',
        'sub_book_id' => $staleSub, 'preview_nodes' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    canonvDb()->table('library')->insert([
        'book' => $staleSub, 'type' => 'sub_book', 'title' => 'Annotation: oldFn_stale',
        'has_nodes' => true, 'raw_json' => json_encode([]), 'timestamp' => 1,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    File::put("{$dir}/footnotes.jsonl",
        json_encode(['footnoteId' => 'newFn_1', 'content' => '<p>a fresh footnote</p>']) . "\n"
    );

    try {
        canonvInvoke('saveFootnotesToDatabase', $dir, $book);

        // The fresh footnote is present; the stale one and its sub-book are GONE.
        $rows = canonvDb()->table('footnotes')->where('book', $book)->pluck('footnoteId')->all();
        expect($rows)->toBe(['newFn_1']);
        expect(canonvDb()->table('library')->where('book', $staleSub)->exists())->toBeFalse();
    } finally {
        canonvDb()->table('footnotes')->where('book', $book)->delete();
        canonvDb()->table('library')->where('book', 'LIKE', $book . '/%')->delete();
        File::deleteDirectory($dir);
    }
});

test('node save is a no-op (no crash) when nodes.jsonl is absent', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Missing Jsonl', 'has_nodes' => false]);
    $dir = canonvWorkDir($book);

    try {
        canonvInvoke('saveNodesToDatabase', $dir, $book);
        expect(canonvDb()->table('nodes')->where('book', $book)->count())->toBe(0);
    } finally {
        File::deleteDirectory($dir);
    }
});

/**
 * Regression: the PDF-OCR lane (processLocalPdf) used to save nodes + footnotes but
 * NEVER references.json, so every auto-versioned PDF rendered "Reference not found:
 * <id>" in the reader — the bibliography row backing each in-text citation was never
 * written. The JATS/HTML lane always saved them. saveReferencesToDatabase closes the gap.
 */
test('reference save persists references.json into the bibliography table', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV References', 'has_nodes' => false]);
    $dir = canonvWorkDir($book);

    File::put("{$dir}/references.json", json_encode([
        ['referenceId' => 'krippendorff1980', 'content' => '<p><a class="bib-entry" id="krippendorff1980"></a>Krippendorff, K. (1980).</p>'],
        ['referenceId' => 'berelson1952', 'content' => '<p>Berelson, B. (1952).</p>', 'source_id' => 'S123'],
    ]));

    try {
        canonvInvoke('saveReferencesToDatabase', $dir, $book);

        expect(canonvDb()->table('bibliography')->where('book', $book)->count())->toBe(2);
        $krip = canonvDb()->table('bibliography')
            ->where('book', $book)->where('referenceId', 'krippendorff1980')->first();
        expect($krip)->not->toBeNull();
        expect($krip->content)->toContain('Krippendorff');
    } finally {
        canonvDb()->table('bibliography')->where('book', $book)->delete();
        File::deleteDirectory($dir);
    }
});

test('reference save replaces existing rows and skips overlong / id-less entries', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Ref Replace', 'has_nodes' => false]);
    $dir = canonvWorkDir($book);

    // A stale row that a re-conversion must clear.
    canonvDb()->table('bibliography')->insert([
        'book' => $book, 'referenceId' => 'stale1999', 'content' => '<p>stale</p>',
        'created_at' => now(), 'updated_at' => now(),
    ]);

    File::put("{$dir}/references.json", json_encode([
        ['referenceId' => 'good2001', 'content' => '<p>keeps</p>'],
        ['content' => '<p>no id — skipped</p>'],
        ['referenceId' => str_repeat('x', 300), 'content' => '<p>overlong id — skipped</p>'],
        ['referenceId' => 'good2001', 'content' => '<p>dup — deduped</p>'],
    ]));

    try {
        canonvInvoke('saveReferencesToDatabase', $dir, $book);

        $rows = canonvDb()->table('bibliography')->where('book', $book)->get();
        expect($rows)->toHaveCount(1);
        expect($rows->first()->referenceId)->toBe('good2001');
        // Stale row gone (delete-then-insert), and the overlong-id row didn't blow up the batch.
        expect(canonvDb()->table('bibliography')->where('book', $book)->where('referenceId', 'stale1999')->exists())->toBeFalse();
    } finally {
        canonvDb()->table('bibliography')->where('book', $book)->delete();
        File::deleteDirectory($dir);
    }
});

test('reference save is a no-op (no crash) when references.json is absent or empty', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Ref Missing', 'has_nodes' => false]);
    $dir = canonvWorkDir($book);

    try {
        canonvInvoke('saveReferencesToDatabase', $dir, $book);
        expect(canonvDb()->table('bibliography')->where('book', $book)->count())->toBe(0);

        File::put("{$dir}/references.json", json_encode([]));
        canonvInvoke('saveReferencesToDatabase', $dir, $book);
        expect(canonvDb()->table('bibliography')->where('book', $book)->count())->toBe(0);
    } finally {
        canonvDb()->table('bibliography')->where('book', $book)->delete();
        File::deleteDirectory($dir);
    }
});
