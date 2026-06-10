<?php

/**
 * Guards the per-visit freshness check in UserHomeServerController.
 *
 * The home book is maintained incrementally on every mutation, so a NORMAL
 * visit must NOT regenerate (regenerating on every visit — by json_decoding
 * every node's raw_json — was the cause of the "/u/ pauses for ages" stall).
 * The cheap timestamp guard should:
 *   - generate once on the true first visit,
 *   - do nothing on subsequent unchanged visits,
 *   - regenerate exactly once if a real library book is newer than the home
 *     book (an incremental update was missed), then settle.
 */

use App\Http\Controllers\UserHomeServerController;
use Illuminate\Support\Facades\DB;

require_once __DIR__ . '/HomeBookTestHelpers.php';

beforeEach(fn () => hbCleanup());
afterEach(fn () => hbCleanup());

/** Invoke the private guard the way show() does. */
function hbInvokeGuard(string $username, string $visibility): void
{
    $controller = app(UserHomeServerController::class);
    $m = (new ReflectionClass($controller))->getMethod('generateUserHomeBookIfNeeded');
    $m->setAccessible(true);
    $m->invoke($controller, $username, true, $visibility);
}

/** The home book's library.timestamp — bumped only when (re)generated/mutated. */
function hbHomeTimestamp(string $homeBook): int
{
    return (int) hbAdmin()->table('library')->where('book', $homeBook)->value('timestamp');
}

/** A fingerprint of the home book's nodes that changes iff they were delete+reinserted. */
function hbNodeFingerprint(string $homeBook): string
{
    $rows = hbAdmin()->table('nodes')->where('book', $homeBook)->orderBy('id')->pluck('id')->all();
    return implode(',', $rows);
}

test('an unchanged visit does NOT regenerate the home book', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];

    $tsBefore = hbHomeTimestamp($username);
    $fpBefore = hbNodeFingerprint($username);

    // Two more "visits" with nothing changed.
    hbInvokeGuard($username, 'public');
    hbInvokeGuard($username, 'public');

    expect(hbHomeTimestamp($username))->toBe($tsBefore);            // timestamp untouched
    expect(hbNodeFingerprint($username))->toBe($fpBefore);          // nodes never delete+reinserted
    expect(hbCardsIn($username))->toHaveCount(2);                   // content still correct
});

test('first visit (no home book yet) generates it once', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];

    // Simulate "never generated": drop the public home book entirely.
    hbAdmin()->table('nodes')->where('book', $username)->delete();
    hbAdmin()->table('library')->where('book', $username)->delete();
    expect(hbAdmin()->table('library')->where('book', $username)->exists())->toBeFalse();

    hbInvokeGuard($username, 'public');

    expect(hbAdmin()->table('library')->where('book', $username)->exists())->toBeTrue();
    expect(hbCardsIn($username))->toHaveCount(2);
});

test('a library book newer than the home book triggers exactly one regeneration, then settles', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];
    $newerBook = $seed['public'][0];

    $fpBefore = hbNodeFingerprint($username);

    // Simulate a MISSED incremental update: a real book's timestamp jumps ahead
    // of the home book without the card being updated.
    hbAdmin()->table('library')
        ->where('book', $newerBook)
        ->update(['timestamp' => hbHomeTimestamp($username) + 5000]);

    // First visit after the drift → one regeneration.
    hbInvokeGuard($username, 'public');
    $fpAfter = hbNodeFingerprint($username);
    expect($fpAfter)->not->toBe($fpBefore);                        // nodes were rebuilt
    expect(hbCardsIn($username))->toHaveCount(2);

    // It must SETTLE: the next visit does nothing (home ts now >= the book ts).
    $fpSettled = hbNodeFingerprint($username);
    hbInvokeGuard($username, 'public');
    expect(hbNodeFingerprint($username))->toBe($fpSettled);        // no repeat regen
});
