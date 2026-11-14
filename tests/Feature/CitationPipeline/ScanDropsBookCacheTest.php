<?php

/**
 * A bibliography scan rewrites match columns without moving library.timestamp, so the book's
 * file cache must be dropped when the scan saves — otherwise the reader keeps getting the
 * pre-scan bibliography and no reference ever shows as verified (prod 2026-11-14:
 * 86 of 109 references linked in Postgres, zero in the served payload).
 */

use App\Jobs\CitationScanBibliographyJob;
use App\Services\BookCache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

test('saving scan results drops the book file cache', function () {
    $book = 'book_scancache_' . Str::lower(Str::random(8));
    $dir = storage_path('app/cache/books/' . $book);
    File::ensureDirectoryExists($dir);
    File::put($dir . '/bibliography.json', '{"stale":true}');

    $job = new CitationScanBibliographyJob((string) Str::uuid(), $book);
    $save = new ReflectionMethod($job, 'saveScanResults');
    $save->setAccessible(true);

    try {
        $save->invoke($job, DB::connection('pgsql_admin'), 0, 0, 0, 0, 0, []);
        expect(is_dir($dir))->toBeFalse();
    } finally {
        File::deleteDirectory($dir);
    }
});
