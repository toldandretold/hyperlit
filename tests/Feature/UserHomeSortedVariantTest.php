<?php

/**
 * The user page's Library has TWO feed mechanisms that must agree: the
 * persisted `recent` snapshot books ({u}/{u}Private/{u}All, maintained
 * incrementally) and the live-rebuilt sorted variants ({u}_{vis}_{sort}).
 * The reported bug: a book missing from Library (recent) but present under
 * "author a-z" — the sorted view queried live while the snapshot was stale.
 *
 * These tests pin: membership parity between the snapshot and the variants,
 * that a rendered variant row is never ITSELF a feed member (phantom cards),
 * that a metadata edit flushes the cached variants (title/author variants
 * never self-expire — only connected/lit do), and that the deletion-path
 * invalidator covers the All book.
 */

use App\Http\Controllers\UserHomeServerController;
use App\Services\ShelfCacheInvalidator;
use App\Support\UserHomeBookNames;

require_once __DIR__ . '/HomeBookTestHelpers.php';

beforeEach(fn () => hbCleanup());
afterEach(fn () => hbCleanup());

/** Render a sorted variant the way renderSorted/publicRenderSorted do, returning its book id. */
function usvRenderSorted(string $username, string $visibility, string $sort, bool $isOwner = true): string
{
    $controller = app(UserHomeServerController::class);
    $m = (new ReflectionClass($controller))->getMethod('renderSortedFeed');
    $m->setAccessible(true);
    $sanitized = str_replace(' ', '', $username);
    $resp = $m->invoke($controller, $username, $sanitized, $visibility, $sort, $isOwner);

    return $resp->getData(true)['bookId'];
}

test('a sorted variant holds exactly the same books as the recent snapshot', function () {
    $seed = hbSeedUserWithBooks(3, 2);
    $username = $seed['username'];
    $allBook = $username . 'All';

    $variantBook = usvRenderSorted($username, 'all', 'author');

    $snapshotSet = hbCardsIn($allBook);
    $variantSet = hbCardsIn($variantBook);
    sort($snapshotSet);
    sort($variantSet);

    expect($variantSet)->toBe($snapshotSet);
    expect($variantSet)->toHaveCount(5);
});

test('rendered sorted-variant rows are never themselves feed members', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];
    $allBook = $username . 'All';

    // Render two variants so their library rows exist (creator = username,
    // no slash, no shelf_ prefix — the exact shape that used to slip past
    // the member queries as phantom "…'s library (title)" cards).
    $authorVariant = usvRenderSorted($username, 'all', 'author');
    $titleVariant = usvRenderSorted($username, 'all', 'title');

    // A full regeneration must not pick the variant rows up as members…
    app(UserHomeServerController::class)->generateAllUserHomeBook($username);
    $variantNames = UserHomeBookNames::sortedVariantNames($username);
    foreach (hbCardsIn($allBook) as $cardBook) {
        expect($variantNames)->not->toContain($cardBook);
    }
    expect(hbCardsIn($allBook))->toHaveCount(3);

    // …and neither must a fresh sorted render (the regen flushed the caches,
    // so this rebuilds live — with itself and its siblings in the library).
    $rerendered = usvRenderSorted($username, 'all', 'author');
    $cards = hbCardsIn($rerendered);
    expect($cards)->toHaveCount(3);
    foreach ($cards as $cardBook) {
        expect($variantNames)->not->toContain($cardBook);
    }

    // Silence unused warnings — the first renders exist purely as bait rows.
    expect($authorVariant)->not->toBe($titleVariant);
});

test('a metadata edit through updateBookOnUserPage flushes the cached sorted variants', function () {
    $seed = hbSeedUserWithBooks(2, 0);
    $username = $seed['username'];

    $variantBook = usvRenderSorted($username, 'all', 'author');
    expect(hbAdmin()->table('nodes')->where('book', $variantBook)->exists())->toBeTrue();

    // Rename a member and run the incremental card update — the variant
    // caches rendered cards, so it must be flushed or it serves the old
    // title/author (and the old A–Z position) forever.
    $edited = $seed['public'][0];
    hbAdmin()->table('library')->where('book', $edited)->update(['title' => 'Zzz renamed']);
    app(UserHomeServerController::class)->updateBookOnUserPage($username, hbBookRecord($edited));

    expect(hbAdmin()->table('nodes')->where('book', $variantBook)->exists())->toBeFalse();
});

test('flushUserHomeShelves covers the All book and drops the sorted variants', function () {
    $seed = hbSeedUserWithBooks(1, 1);
    $username = $seed['username'];
    $allBook = $username . 'All';

    $variantBook = usvRenderSorted($username, 'all', 'title');
    $tsBefore = (int) hbAdmin()->table('library')->where('book', $allBook)->value('timestamp');

    usleep(5000);
    (new ShelfCacheInvalidator())->flushUserHomeShelves($username);

    // {u}All used to be missed by this invalidator, leaving the owner's
    // default Library view stale while public/private refreshed.
    expect((int) hbAdmin()->table('library')->where('book', $allBook)->value('timestamp'))
        ->toBeGreaterThan($tsBefore);
    expect(hbAdmin()->table('nodes')->where('book', $variantBook)->exists())->toBeFalse();
    expect(hbAdmin()->table('library')->where('book', $variantBook)->exists())->toBeFalse();
});
