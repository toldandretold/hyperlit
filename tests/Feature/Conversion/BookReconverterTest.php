<?php

/**
 * BookReconverter — the one "queue this book for reconversion" implementation, shared by the
 * HTTP reconvert endpoint and the consoles' bulk button.
 *
 * The property that matters most is the COST guard. A reconvert is supposed to re-run a fixed
 * processor over an UNCHANGED input: a PDF book replays `ocr_response.json`, which mistral_ocr.py
 * uses instead of calling the API. A book whose cache has gone misses it and gets OCR'd again for
 * real money — a visible surprise on one book, a silent four-figure one queued across a journal.
 */

use App\Jobs\ProcessDocumentImportJob;
use App\Services\Conversion\BookReconverter;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;

function brPath(string $book): string
{
    return resource_path("markdown/{$book}");
}

function brSeedBook(string $book, array $files): void
{
    File::ensureDirectoryExists(brPath($book));
    foreach ($files as $name => $contents) {
        File::put(brPath($book) . '/' . $name, $contents);
    }
}

afterEach(function () {
    foreach (File::directories(resource_path('markdown')) as $dir) {
        if (str_starts_with(basename($dir), 'book_brtest')) {
            File::deleteDirectory($dir);
        }
    }
});

test('a PDF book with its OCR cache queues, and reports the source it will replay', function () {
    Queue::fake();
    brSeedBook('book_brtest_cached', [
        'original.pdf'       => '%PDF-1.4 fake',
        'ocr_response.json'  => '{"pages":[]}',
    ]);

    $result = app(BookReconverter::class)
        ->queue('book_brtest_cached', null, ['creator' => 'x', 'creator_token' => null], requireCachedSource: true);

    expect($result['queued'])->toBeTrue();
    expect($result['source'])->toBe('pdf');
    Queue::assertPushed(ProcessDocumentImportJob::class);
});

test('a PDF book with NO OCR cache is refused under requireCachedSource, and nothing is queued', function () {
    Queue::fake();
    brSeedBook('book_brtest_nocache', ['original.pdf' => '%PDF-1.4 fake']);

    $result = app(BookReconverter::class)
        ->queue('book_brtest_nocache', null, ['creator' => 'x', 'creator_token' => null], requireCachedSource: true);

    expect($result['queued'])->toBeFalse();
    // The operator's next question is always "so what would it have cost" — the reason answers it.
    expect($result['reason'])->toContain('re-run OCR and be charged');
    Queue::assertNothingPushed();
});

test('the same book IS queued when the caller accepts the OCR cost', function () {
    Queue::fake();
    brSeedBook('book_brtest_nocache2', ['original.pdf' => '%PDF-1.4 fake']);

    // The single-book HTTP path: an operator re-OCRing one source is a deliberate act with
    // visible feedback, so it is allowed. Only the bulk callers pass requireCachedSource.
    $result = app(BookReconverter::class)
        ->queue('book_brtest_nocache2', null, ['creator' => 'x', 'creator_token' => null], requireCachedSource: false);

    expect($result['queued'])->toBeTrue();
    Queue::assertPushed(ProcessDocumentImportJob::class);
});

test('a non-PDF source needs no cache — its original IS the cache', function () {
    Queue::fake();
    brSeedBook('book_brtest_html', ['original.html' => '<html><body><p>Body.</p></body></html>']);

    $result = app(BookReconverter::class)
        ->queue('book_brtest_html', null, ['creator' => 'x', 'creator_token' => null], requireCachedSource: true);

    expect($result['queued'])->toBeTrue();
    expect($result['source'])->toBe('html');
});

test('a book with no source at all is refused rather than queued to fail on the worker', function () {
    Queue::fake();
    brSeedBook('book_brtest_empty', ['notes.txt' => 'nothing convertible here']);

    $result = app(BookReconverter::class)
        ->queue('book_brtest_empty', null, ['creator' => 'x', 'creator_token' => null], requireCachedSource: true);

    expect($result['queued'])->toBeFalse();
    expect($result['reason'])->toContain('no source file');
    Queue::assertNothingPushed();
});

test('a conversion already in flight blocks a second queue, but a stale marker does not', function () {
    Queue::fake();

    brSeedBook('book_brtest_inflight', [
        'original.pdf'      => '%PDF',
        'ocr_response.json' => '{}',
        'progress.json'     => json_encode(['status' => 'processing', 'updated_at' => now()->toIso8601String()]),
    ]);
    $busy = app(BookReconverter::class)
        ->queue('book_brtest_inflight', null, ['creator' => 'x', 'creator_token' => null]);
    expect($busy['queued'])->toBeFalse();
    expect($busy['reason'])->toContain('already in progress');

    // A worker that died mid-conversion leaves its marker behind forever. Honouring that would make
    // the book permanently unreconvertable, so markers older than 30 minutes are ignored.
    brSeedBook('book_brtest_stale', [
        'original.pdf'      => '%PDF',
        'ocr_response.json' => '{}',
        'progress.json'     => json_encode(['status' => 'processing', 'updated_at' => now()->subHours(2)->toIso8601String()]),
    ]);
    $stale = app(BookReconverter::class)
        ->queue('book_brtest_stale', null, ['creator' => 'x', 'creator_token' => null]);
    expect($stale['queued'])->toBeTrue();
});

test('hasCachedSource answers the same question without side effects', function () {
    Queue::fake();

    brSeedBook('book_brtest_probe_ok', ['original.pdf' => '%PDF', 'ocr_response.json' => '{}']);
    brSeedBook('book_brtest_probe_no', ['original.pdf' => '%PDF']);
    brSeedBook('book_brtest_probe_md', ['main-text.md' => '# Title']);

    $reconverter = app(BookReconverter::class);
    expect($reconverter->hasCachedSource('book_brtest_probe_ok'))->toBeTrue();
    expect($reconverter->hasCachedSource('book_brtest_probe_no'))->toBeFalse();
    expect($reconverter->hasCachedSource('book_brtest_probe_md'))->toBeTrue();
    expect($reconverter->hasCachedSource('book_brtest_probe_missing'))->toBeFalse();

    Queue::assertNothingPushed();
});
