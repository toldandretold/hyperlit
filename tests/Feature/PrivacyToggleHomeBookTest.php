<?php

/**
 * Backend regression test for the privacy-toggle / library-upsert flow.
 *
 * Covers `UserHomeServerController::moveBookBetweenHomeBooks` and the
 * upsert wiring in DbLibraryController. Verifies that flipping a book's
 * visibility correctly mutates the user's home books (`username`,
 * `usernamePrivate`, `usernameAll`) without leaving stale or duplicated
 * cards.
 */

use App\Http\Controllers\UserHomeServerController;

require_once __DIR__ . '/HomeBookTestHelpers.php';

beforeEach(fn () => hbCleanup());
afterEach(fn () => hbCleanup());

test('all four home books exist after seeding', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];

    app(UserHomeServerController::class)->generateAccountBook($username);

    foreach ([$username, $username . 'Private', $username . 'All', $username . 'Account'] as $bookName) {
        expect(hbAdmin()->table('library')->where('book', $bookName)->exists())
            ->toBeTrue("Home book {$bookName} should exist");
    }

    expect(hbCardsIn($username))->toHaveCount(3);
    expect(hbCardsIn($username . 'Private'))->toHaveCount(2);
    expect(hbCardsIn($username . 'All'))->toHaveCount(5);
});

test('moveBookBetweenHomeBooks moves card from public to private home', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $bookId = $seed['public'][1];

    hbAdmin()->table('library')->where('book', $bookId)->update(['visibility' => 'private']);

    app(UserHomeServerController::class)
        ->moveBookBetweenHomeBooks($username, hbBookRecord($bookId), 'public', 'private');

    $publicCards = hbCardsIn($username);
    $privateCards = hbCardsIn($username . 'Private');

    expect($publicCards)->not->toContain($bookId);
    expect($privateCards)->toContain($bookId);
    expect($publicCards)->toHaveCount(2);
    expect($privateCards)->toHaveCount(3);
});

test('moveBookBetweenHomeBooks updates the All-book card isPrivate flag', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $bookId = $seed['public'][0];
    $allBook = $username . 'All';

    hbAdmin()->table('library')->where('book', $bookId)->update(['visibility' => 'private']);

    app(UserHomeServerController::class)
        ->moveBookBetweenHomeBooks($username, hbBookRecord($bookId), 'public', 'private');

    $allChunk = hbAdmin()->table('nodes')
        ->where('book', $allBook)
        ->where('node_id', $allBook . '_' . $bookId . '_card')
        ->first();

    expect($allChunk)->not->toBeNull();
    expect($allChunk->content)->toContain('libraryCard-private');
});

test('no card is duplicated across home books after toggle', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $bookId = $seed['public'][0];

    hbAdmin()->table('library')->where('book', $bookId)->update(['visibility' => 'private']);

    app(UserHomeServerController::class)
        ->moveBookBetweenHomeBooks($username, hbBookRecord($bookId), 'public', 'private');

    $publicCards = hbCardsIn($username);
    $privateCards = hbCardsIn($username . 'Private');

    expect(array_intersect($publicCards, $privateCards))->toBe([]);
    expect($publicCards)->toEqual(array_values(array_unique($publicCards)));
    expect($privateCards)->toEqual(array_values(array_unique($privateCards)));
});

test('home book timestamps bump on visibility toggle', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $bookId = $seed['public'][0];

    $tsBefore = hbAdmin()->table('library')
        ->whereIn('book', [$username, $username . 'Private', $username . 'All'])
        ->pluck('timestamp', 'book');

    usleep(5000);

    hbAdmin()->table('library')->where('book', $bookId)->update(['visibility' => 'private']);

    app(UserHomeServerController::class)
        ->moveBookBetweenHomeBooks($username, hbBookRecord($bookId), 'public', 'private');

    $tsAfter = hbAdmin()->table('library')
        ->whereIn('book', [$username, $username . 'Private', $username . 'All'])
        ->pluck('timestamp', 'book');

    foreach ([$username, $username . 'Private', $username . 'All'] as $home) {
        expect((int) $tsAfter[$home])->toBeGreaterThan((int) $tsBefore[$home], "{$home} timestamp should bump");
    }
});

test('toggling the only public book private leaves an empty-state card on public', function () {
    $seed = hbSeedUserWithBooks(1, 0);
    $username = $seed['username'];
    $bookId = $seed['public'][0];

    hbAdmin()->table('library')->where('book', $bookId)->update(['visibility' => 'private']);

    app(UserHomeServerController::class)
        ->moveBookBetweenHomeBooks($username, hbBookRecord($bookId), 'public', 'private');

    expect(hbHasEmptyCard($username))->toBeTrue("Empty-state card should be present in public home");
    expect(hbCardsIn($username))->toBe([]);
    expect(hbCardsIn($username . 'Private'))->toContain($bookId);
});

test('sorted variants are invalidated for both visibilities', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $bookId = $seed['public'][0];

    foreach (['public_title', 'private_author', 'all_connected'] as $variant) {
        $variantBook = $username . '_' . $variant;
        hbAdmin()->table('library')->insert([
            'book' => $variantBook,
            'title' => 'sorted variant',
            'creator' => $username,
            'visibility' => 'private',
            'listed' => false,
            'timestamp' => round(microtime(true) * 1000),
            'raw_json' => json_encode(['type' => 'user_home_sorted', 'variant' => $variant]),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        hbAdmin()->table('nodes')->insert([
            'book' => $variantBook,
            'chunk_id' => 0,
            'startLine' => 100,
            'node_id' => $variantBook . '_marker',
            'content' => '<p>marker</p>',
            'plainText' => 'marker',
            'type' => 'p',
            'raw_json' => '{}',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    hbAdmin()->table('library')->where('book', $bookId)->update(['visibility' => 'private']);

    app(UserHomeServerController::class)
        ->moveBookBetweenHomeBooks($username, hbBookRecord($bookId), 'public', 'private');

    foreach (['public_title', 'private_author', 'all_connected'] as $variant) {
        $variantBook = $username . '_' . $variant;
        expect(hbAdmin()->table('library')->where('book', $variantBook)->exists())
            ->toBeFalse("Sorted variant {$variantBook} should be invalidated");
        expect(hbAdmin()->table('nodes')->where('book', $variantBook)->exists())
            ->toBeFalse("Sorted variant nodes for {$variantBook} should be invalidated");
    }
});

test('round-trip toggle (public to private and back) leaves consistent state', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $bookId = $seed['public'][1];
    $controller = app(UserHomeServerController::class);

    hbAdmin()->table('library')->where('book', $bookId)->update(['visibility' => 'private']);
    $controller->moveBookBetweenHomeBooks($username, hbBookRecord($bookId), 'public', 'private');

    hbAdmin()->table('library')->where('book', $bookId)->update(['visibility' => 'public']);
    $controller->moveBookBetweenHomeBooks($username, hbBookRecord($bookId), 'private', 'public');

    expect(hbCardsIn($username))->toContain($bookId);
    expect(hbCardsIn($username . 'Private'))->not->toContain($bookId);
    expect(hbCardsIn($username))->toHaveCount(3);
    expect(hbCardsIn($username . 'Private'))->toHaveCount(2);

    $allBook = $username . 'All';
    $allChunk = hbAdmin()->table('nodes')
        ->where('book', $allBook)
        ->where('node_id', $allBook . '_' . $bookId . '_card')
        ->first();
    expect($allChunk->content)->not->toContain('libraryCard-private');
});
