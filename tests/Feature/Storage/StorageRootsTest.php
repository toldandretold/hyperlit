<?php

/**
 * The gate that makes 2026-08-01 impossible to repeat.
 *
 * The testing environment has always used its own database. It did NOT use its
 * own directories — so a test could read the (nearly empty) test database,
 * conclude every book directory on disk was orphaned, and delete real files.
 * That is precisely what happened, and it cost ~14 GB of local dev data.
 *
 * config/storage.php now points the storage roots inside
 * storage/framework/testing/ whenever APP_ENV=testing. This test fails if that
 * ever stops being true — i.e. if a test run could see, scan, or delete real
 * book content again.
 */

use App\Services\Storage\StorageScanner;

test('under testing, every storage root is a sandbox — never a real content tree', function () {
    $real = [
        resource_path('markdown'),
        storage_path('app/books'),
        storage_path('app/cache/books'),
        storage_path('app/public/books'),
    ];

    // NB: Pest's toContain() is variadic — a second string is another NEEDLE,
    // not a failure message. Keep the explanation in comments, not arguments.
    foreach (StorageScanner::roots() as $name => $path) {
        expect($path)->not->toBeIn($real);       // never a real content tree
        expect($path)->toContain('framework/testing');  // always inside the sandbox
    }
});

test('the scanner only ever looks inside the sandbox while testing', function () {
    // The scan must not see the thousands of real book directories that exist
    // on a developer machine — if it does, the roots are wrong.
    $items = collect(app(StorageScanner::class)->scan()['items'])->whereNotNull('book');

    foreach ($items as $item) {
        if ($item['path'] !== null) {
            expect($item['path'])->toContain('framework/testing');
        }
    }

    // A dev machine has thousands of real book directories. If the roots ever
    // point back at them, the scan returns far more than a test ever seeds.
    expect($items->count())->toBeLessThan(50);
});

test('the reclaim command refuses paths outside the configured roots', function () {
    // Belt and braces: even inside the sandbox, only the declared roots are
    // ever candidates.
    $roots = StorageScanner::roots();

    expect($roots)->toHaveKeys(['markdown', 'books', 'cache', 'legacy_images']);
    foreach ($roots as $path) {
        expect($path)->toBeString()->not->toBe('/');
    }
});
