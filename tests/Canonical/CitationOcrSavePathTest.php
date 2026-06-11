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
        canonvInvoke('saveNodeChunksToDatabase', $dir, $book);

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

test('node save is a no-op (no crash) when nodes.jsonl is absent', function () {
    $book = canonvSeedLibrary(['title' => 'CanonV Missing Jsonl', 'has_nodes' => false]);
    $dir = canonvWorkDir($book);

    try {
        canonvInvoke('saveNodeChunksToDatabase', $dir, $book);
        expect(canonvDb()->table('nodes')->where('book', $book)->count())->toBe(0);
    } finally {
        File::deleteDirectory($dir);
    }
});
