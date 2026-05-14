<?php

/**
 * Backend regression test for book create + delete home-book consistency.
 *
 * Covers `UserHomeServerController::addBookToUserPage` (called from
 * DbLibraryController::bulkCreate when a book is newly created) and
 * `BookDeletionService::deleteBook` (called from DbLibraryController::destroy).
 *
 * Verifies that after a create or delete, all four home books
 * (`username`, `usernamePrivate`, `usernameAll`, `usernameAccount`)
 * stay consistent so the user lands on a correct shelf without
 * needing a page refresh to trigger regeneration.
 */

use App\Http\Controllers\UserHomeServerController;
use App\Services\BookDeletionService;

require_once __DIR__ . '/HomeBookTestHelpers.php';

beforeEach(fn () => hbCleanup());
afterEach(fn () => hbCleanup());

// ---------- CREATE ----------

test('creating a public book inserts the card into both username and All home books', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];

    $newBookId = $username . '_new_pub';
    $bookRecord = hbInsertBook($username, $newBookId, 'public', 'Brand New Public');

    app(UserHomeServerController::class)->addBookToUserPage($username, $bookRecord);

    expect(hbCardsIn($username))->toContain($newBookId)->toHaveCount(3);
    expect(hbCardsIn($username . 'All'))->toContain($newBookId)->toHaveCount(4);
    expect(hbCardsIn($username . 'Private'))->not->toContain($newBookId)->toHaveCount(1);
});

test('creating a private book inserts the card with isPrivate flag in the All book', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];
    $allBook = $username . 'All';

    $newBookId = $username . '_new_prv';
    $bookRecord = hbInsertBook($username, $newBookId, 'private', 'Brand New Private');

    app(UserHomeServerController::class)->addBookToUserPage($username, $bookRecord);

    expect(hbCardsIn($username . 'Private'))->toContain($newBookId)->toHaveCount(2);
    expect(hbCardsIn($allBook))->toContain($newBookId)->toHaveCount(4);

    $allChunk = hbAdmin()->table('nodes')
        ->where('book', $allBook)
        ->where('node_id', $allBook . '_' . $newBookId . '_card')
        ->first();
    expect($allChunk->content)->toContain('libraryCard-private');
});

test('creating a book replaces any empty-state card on the visibility home book', function () {
    $seed = hbSeedUserWithBooks(0, 1);
    $username = $seed['username'];

    expect(hbHasEmptyCard($username))->toBeTrue();

    $newBookId = $username . '_first_pub';
    $bookRecord = hbInsertBook($username, $newBookId, 'public', 'First public');
    app(UserHomeServerController::class)->addBookToUserPage($username, $bookRecord);

    expect(hbHasEmptyCard($username))->toBeFalse();
    expect(hbCardsIn($username))->toBe([$newBookId]);
});

test('creating a book invalidates sorted variants for that visibility AND for all', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];

    foreach (['public_title', 'all_connected', 'private_author'] as $variant) {
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
    }

    $newBookId = $username . '_new_pub';
    $bookRecord = hbInsertBook($username, $newBookId, 'public', 'New');
    app(UserHomeServerController::class)->addBookToUserPage($username, $bookRecord);

    expect(hbAdmin()->table('library')->where('book', $username . '_public_title')->exists())->toBeFalse();
    expect(hbAdmin()->table('library')->where('book', $username . '_all_connected')->exists())->toBeFalse();
    // Private variant is unaffected by a new public book
    expect(hbAdmin()->table('library')->where('book', $username . '_private_author')->exists())->toBeTrue();
});

test('creating a book bumps the home book and All book timestamps', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];

    $tsBefore = hbAdmin()->table('library')
        ->whereIn('book', [$username, $username . 'All'])
        ->pluck('timestamp', 'book');

    usleep(5000);

    $newBookId = $username . '_new_pub';
    $bookRecord = hbInsertBook($username, $newBookId, 'public', 'Timestamp test');
    app(UserHomeServerController::class)->addBookToUserPage($username, $bookRecord);

    $tsAfter = hbAdmin()->table('library')
        ->whereIn('book', [$username, $username . 'All'])
        ->pluck('timestamp', 'book');

    expect((int) $tsAfter[$username])->toBeGreaterThan((int) $tsBefore[$username]);
    expect((int) $tsAfter[$username . 'All'])->toBeGreaterThan((int) $tsBefore[$username . 'All']);
});

// ---------- DELETE ----------

test('deleting a public book removes the card from username AND All home books', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $bookId = $seed['public'][1];

    (new BookDeletionService())
        ->useConnection(hbAdmin())
        ->deleteBook($bookId);

    expect(hbCardsIn($username))->not->toContain($bookId)->toHaveCount(2);
    expect(hbCardsIn($username . 'All'))->not->toContain($bookId)->toHaveCount(4);
    expect(hbCardsIn($username . 'Private'))->toHaveCount(2);
});

test('deleting a private book removes the card from usernamePrivate AND All home books', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $bookId = $seed['private'][0];

    (new BookDeletionService())
        ->useConnection(hbAdmin())
        ->deleteBook($bookId);

    expect(hbCardsIn($username . 'Private'))->not->toContain($bookId)->toHaveCount(1);
    expect(hbCardsIn($username . 'All'))->not->toContain($bookId)->toHaveCount(4);
    expect(hbCardsIn($username))->toHaveCount(3);
});

test('deleting the only public book leaves an empty-state card on the public home', function () {
    $seed = hbSeedUserWithBooks(1, 1);
    $username = $seed['username'];
    $bookId = $seed['public'][0];

    (new BookDeletionService())
        ->useConnection(hbAdmin())
        ->deleteBook($bookId);

    expect(hbCardsIn($username))->toBe([]);
    expect(hbHasEmptyCard($username))->toBeTrue("Empty-state card should appear in public home");
    expect(hbCardsIn($username . 'Private'))->toHaveCount(1);
    expect(hbCardsIn($username . 'All'))->toHaveCount(1);
});

test('deleting the last book of any visibility leaves empty-state cards everywhere it cleared', function () {
    $seed = hbSeedUserWithBooks(1, 0);
    $username = $seed['username'];
    $bookId = $seed['public'][0];

    (new BookDeletionService())
        ->useConnection(hbAdmin())
        ->deleteBook($bookId);

    foreach ([$username, $username . 'All'] as $home) {
        expect(hbCardsIn($home))->toBe([], "{$home} should have no real cards");
        expect(hbHasEmptyCard($home))->toBeTrue("{$home} should have an empty-state card");
    }
});

test('deleting a book invalidates sorted variants for all visibilities', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $bookId = $seed['public'][1];

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
    }

    (new BookDeletionService())
        ->useConnection(hbAdmin())
        ->deleteBook($bookId);

    foreach (['public_title', 'private_author', 'all_connected'] as $variant) {
        $variantBook = $username . '_' . $variant;
        expect(hbAdmin()->table('library')->where('book', $variantBook)->exists())
            ->toBeFalse("Sorted variant {$variantBook} should be invalidated");
    }
});

test('deleting a book bumps timestamps on all three home books', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $bookId = $seed['public'][0];

    $tsBefore = hbAdmin()->table('library')
        ->whereIn('book', [$username, $username . 'Private', $username . 'All'])
        ->pluck('timestamp', 'book');

    usleep(5000);

    (new BookDeletionService())
        ->useConnection(hbAdmin())
        ->deleteBook($bookId);

    $tsAfter = hbAdmin()->table('library')
        ->whereIn('book', [$username, $username . 'Private', $username . 'All'])
        ->pluck('timestamp', 'book');

    foreach ([$username, $username . 'Private', $username . 'All'] as $home) {
        expect((int) $tsAfter[$home])->toBeGreaterThan((int) $tsBefore[$home], "{$home} timestamp should bump");
    }
});

// ---------- COMBINED end-to-end ----------

test('after a create-then-delete round trip the user sees their original library', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];
    $controller = app(UserHomeServerController::class);

    $newBookId = $username . '_temp';
    $bookRecord = hbInsertBook($username, $newBookId, 'public', 'Temp');
    $controller->addBookToUserPage($username, $bookRecord);

    expect(hbCardsIn($username))->toContain($newBookId)->toHaveCount(3);
    expect(hbCardsIn($username . 'All'))->toContain($newBookId)->toHaveCount(4);

    (new BookDeletionService())
        ->useConnection(hbAdmin())
        ->deleteBook($newBookId);

    expect(hbCardsIn($username))->not->toContain($newBookId)->toHaveCount(2);
    expect(hbCardsIn($username . 'All'))->not->toContain($newBookId)->toHaveCount(3);
    expect(hbCardsIn($username . 'Private'))->toHaveCount(1);
});

test('user lands on consistent state after multiple creates and one delete', function () {
    $seed = hbSeedUserWithBooks(1, 1);
    $username = $seed['username'];
    $controller = app(UserHomeServerController::class);

    $created = [];
    for ($i = 0; $i < 4; $i++) {
        $id = $username . '_seq_' . $i;
        $vis = ($i % 2 === 0) ? 'public' : 'private';
        $controller->addBookToUserPage($username, hbInsertBook($username, $id, $vis, 'Seq ' . $i));
        $created[] = ['id' => $id, 'visibility' => $vis];
    }

    (new BookDeletionService())
        ->useConnection(hbAdmin())
        ->deleteBook($created[1]['id']); // delete a private one

    $remainingPublic = array_values(array_filter($created, fn ($c) => $c['visibility'] === 'public'));
    $remainingPrivate = array_values(array_filter(
        $created,
        fn ($c) => $c['visibility'] === 'private' && $c['id'] !== $created[1]['id']
    ));

    expect(hbCardsIn($username))->toHaveCount(1 + count($remainingPublic));
    expect(hbCardsIn($username . 'Private'))->toHaveCount(1 + count($remainingPrivate));
    expect(hbCardsIn($username . 'All'))->toHaveCount(2 + count($remainingPublic) + count($remainingPrivate));

    foreach ($remainingPublic as $c) {
        expect(hbCardsIn($username))->toContain($c['id']);
        expect(hbCardsIn($username . 'All'))->toContain($c['id']);
    }
    foreach ($remainingPrivate as $c) {
        expect(hbCardsIn($username . 'Private'))->toContain($c['id']);
        expect(hbCardsIn($username . 'All'))->toContain($c['id']);
    }
    expect(hbCardsIn($username . 'All'))->not->toContain($created[1]['id']);
});
