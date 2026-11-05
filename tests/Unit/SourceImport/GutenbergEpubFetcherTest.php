<?php

/**
 * GutenbergEpubFetcher — downloads original.epub from Gutenberg's per-format
 * URLs, preferring epub3-with-images and falling back through the epub2
 * variants. The ZIP magic-byte check matters: a missing variant can come back
 * as a 200 HTML page, which must not be written as original.epub. Http faked —
 * no network.
 */

use App\Services\SourceImport\Content\GutenbergEpubFetcher;
use App\Services\SourceImport\Identifier\ArxivId;
use App\Services\SourceImport\Identifier\GutenbergId;
use App\Services\SourceImport\Metadata\SourceMetadata;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

uses(TestCase::class);

beforeEach(function () {
    $this->destDir = sys_get_temp_dir() . '/gutenberg-fetch-test-' . uniqid();
    mkdir($this->destDir, 0755, true);
    $this->metadata = new SourceMetadata(['title' => 'Test'], 'gutenberg');
});

afterEach(function () {
    $epub = $this->destDir . '/original.epub';
    if (file_exists($epub)) {
        unlink($epub);
    }
    if (is_dir($this->destDir)) {
        rmdir($this->destDir);
    }
});

test('downloads the preferred epub3 variant as original.epub', function () {
    Http::fake([
        'www.gutenberg.org/ebooks/79922.epub3.images' => Http::response("PK\x03\x04fake-epub-bytes", 200),
    ]);

    $result = app(GutenbergEpubFetcher::class)->fetch(new GutenbergId('79922'), $this->metadata, $this->destDir);

    expect($result->ok)->toBeTrue();
    expect($result->extension)->toBe('epub');
    expect($result->localPath)->toBe($this->destDir . '/original.epub');
    expect(file_get_contents($result->localPath))->toStartWith('PK');
});

test('falls back to the next variant when the first 404s', function () {
    Http::fake([
        'www.gutenberg.org/ebooks/79922.epub3.images' => Http::response('Not Found', 404),
        'www.gutenberg.org/ebooks/79922.epub.images'  => Http::response("PK\x03\x04epub2-bytes", 200),
    ]);

    $result = app(GutenbergEpubFetcher::class)->fetch(new GutenbergId('79922'), $this->metadata, $this->destDir);

    expect($result->ok)->toBeTrue();
    expect($result->extension)->toBe('epub');
});

test('rejects a 200 response whose body is not a zip', function () {
    Http::fake([
        'www.gutenberg.org/ebooks/79922.epub3.images' => Http::response('<html>no such format</html>', 200),
        'www.gutenberg.org/ebooks/79922.epub.images'  => Http::response('<html>no such format</html>', 200),
        'www.gutenberg.org/ebooks/79922.epub.noimages' => Http::response('<html>no such format</html>', 200),
    ]);

    $result = app(GutenbergEpubFetcher::class)->fetch(new GutenbergId('79922'), $this->metadata, $this->destDir);

    expect($result->ok)->toBeFalse();
    expect(file_exists($this->destDir . '/original.epub'))->toBeFalse();
});

test('reports failure with the last HTTP status when every variant fails', function () {
    Http::fake([
        'www.gutenberg.org/ebooks/*' => Http::response('Not Found', 404),
    ]);

    $result = app(GutenbergEpubFetcher::class)->fetch(new GutenbergId('79922'), $this->metadata, $this->destDir);

    expect($result->ok)->toBeFalse();
    expect($result->reason)->toBe('http_error');
    expect($result->httpStatus)->toBe(404);
});

test('does not support non-Gutenberg identifiers', function () {
    $fetcher = app(GutenbergEpubFetcher::class);
    expect($fetcher->supports(new ArxivId('2302.08927'), $this->metadata))->toBeFalse();
    expect($fetcher->supports(new GutenbergId('79922'), $this->metadata))->toBeTrue();
});
