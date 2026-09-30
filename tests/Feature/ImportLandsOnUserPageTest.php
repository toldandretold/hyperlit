<?php

/**
 * A newly created book must get its card on the owner's user page whatever
 * path created it. Only DbLibraryController::bulkCreate used to call
 * addBookToUserPage; imports, URL imports, beacon sync and
 * LibraryService::create all bypassed it — the book existed in `library`
 * (and in the live-queried "author a-z" view) but had no card in the
 * `recent` snapshot until the freshness guard happened to trip. Worse, the
 * old max-timestamp guard could be permanently defeated by one future-skewed
 * client timestamp, making the miss permanent.
 *
 * The fix has two halves, each pinned here:
 *  - updateBookOnUserPage UPSERTS: no card yet → delegate to
 *    addBookToUserPage (this is what LibraryService::syncHomepage lands on,
 *    so every path that calls the seam now mints the card);
 *  - the creation sites actually call the seam (source-level gate, because
 *    the seam defers via DB::afterCommit which never fires under
 *    RefreshDatabase's wrapping transaction).
 */

use App\Http\Controllers\UserHomeServerController;

require_once __DIR__ . '/HomeBookTestHelpers.php';

beforeEach(fn () => hbCleanup());
afterEach(fn () => hbCleanup());

test('updateBookOnUserPage upserts a card for a book that has none', function () {
    $seed = hbSeedUserWithBooks(1, 0);
    $username = $seed['username'];
    $allBook = $username . 'All';

    // A book created behind the card-insert's back (import path shape).
    $newBook = hbInsertBook($username, $username . '_imported', 'private', 'Imported Book');
    expect(hbCardsIn($username . 'Private'))->not->toContain($newBook->book);

    app(UserHomeServerController::class)->updateBookOnUserPage($username, $newBook);

    expect(hbCardsIn($username . 'Private'))->toContain($newBook->book);
    expect(hbCardsIn($allBook))->toContain($newBook->book);
});

test('the upsert never mints cards for sub-books, shelf renders or generated books', function () {
    $seed = hbSeedUserWithBooks(1, 0);
    $username = $seed['username'];
    $controller = app(UserHomeServerController::class);

    $cardsBefore = hbCardsIn($username . 'All');

    // A sub-book (footnote book) — the import job bulk-inserts these rows.
    $subBook = hbInsertBook($username, $username . '_pub_0/Fn1', 'public', 'Footnote 1');
    $controller->updateBookOnUserPage($username, $subBook);

    // A sorted-variant row wearing this user's name.
    $variant = hbInsertBook($username, $username . '_all_author', 'private', 'phantom');
    $controller->updateBookOnUserPage($username, $variant);

    expect(hbCardsIn($username . 'All'))->toBe($cardsBefore);
    expect(hbCardsIn($username))->not->toContain($subBook->book);
});

test('every bypassing creation site calls the syncHomepage seam (source gate)', function () {
    $sites = [
        app_path('Http/Controllers/ImportController.php') => 2,
        app_path('Http/Controllers/UrlImportController.php') => 1,
        app_path('Http/Controllers/BeaconSyncController.php') => 1,
        app_path('Jobs/ProcessDocumentImportJob.php') => 1,
    ];

    foreach ($sites as $file => $minCalls) {
        $source = file_get_contents($file);
        $count = substr_count($source, '->syncHomepage(');
        expect($count)->toBeGreaterThanOrEqual(
            $minCalls,
            basename($file) . " must route new/updated books through LibraryService::syncHomepage (found {$count}, expected >= {$minCalls})"
        );
    }
});
