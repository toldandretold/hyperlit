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

/**
 * Invoke the private guard the way show() does, then drain the deferred-regen
 * queue the way the terminating phase does in production (a stale rebuild is
 * deferred to after the response — runDeferredRegens is the drain seam).
 */
function hbInvokeGuard(string $username, string $visibility): void
{
    $controller = app(UserHomeServerController::class);
    $m = (new ReflectionClass($controller))->getMethod('generateUserHomeBookIfNeeded');
    $m->setAccessible(true);
    $m->invoke($controller, $username, true, $visibility);
    $controller->runDeferredRegens();
}

/** The guard WITHOUT the drain — what the response itself sees. */
function hbInvokeGuardNoDrain(string $username, string $visibility): UserHomeServerController
{
    $controller = app(UserHomeServerController::class);
    $m = (new ReflectionClass($controller))->getMethod('generateUserHomeBookIfNeeded');
    $m->setAccessible(true);
    $m->invoke($controller, $username, true, $visibility);

    return $controller;
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

    // Simulate a MISSED incremental update: a real book's CITATION METADATA
    // changes (the library_meta_touch trigger stamps meta_updated_at) without
    // the card being patched. Note this is a raw DB::table update — triggers
    // fire regardless of the write mechanism, which is the whole point of
    // maintaining the column in Postgres rather than application code.
    hbAdmin()->table('library')
        ->where('book', $newerBook)
        ->update(['title' => 'Renamed behind the incremental path']);

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

test('a CONTENT edit (timestamp bump, no metadata change) does NOT trip the guard', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];
    $editedBook = $seed['public'][0];

    $tsBefore = hbHomeTimestamp($username);
    $fpBefore = hbNodeFingerprint($username);

    // A content-editing session: the sync path bumps library.timestamp (the
    // client's concurrency base) but touches no card-relevant field. The cards
    // would be byte-identical, so the guard must NOT rebuild — the old
    // timestamp-keyed guard tripped a full rebuild + client feed redownload on
    // the first /u/ visit after every editing session.
    hbAdmin()->table('library')
        ->where('book', $editedBook)
        ->update(['timestamp' => hbHomeTimestamp($username) + 5000]);

    hbInvokeGuard($username, 'public');

    expect(hbHomeTimestamp($username))->toBe($tsBefore);   // no timestamp bump → client cache stays valid
    expect(hbNodeFingerprint($username))->toBe($fpBefore); // no rebuild
});

test('a stale rebuild is DEFERRED: the response serves the current feed, the drain rebuilds it', function () {
    $seed = hbSeedUserWithBooks(2, 1);
    $username = $seed['username'];
    $newerBook = $seed['public'][0];

    $fpBefore = hbNodeFingerprint($username);

    hbAdmin()->table('library')
        ->where('book', $newerBook)
        ->update(['title' => 'Renamed to trip the metadata guard']);

    // The guard alone must NOT rebuild — this is what kept the owner's TTFB
    // stalled ~3s per home book on prod (2026-09-23): the rebuild ran inline
    // in the page request. The response serves the current (order-stale) feed.
    $controller = hbInvokeGuardNoDrain($username, 'public');
    expect(hbNodeFingerprint($username))->toBe($fpBefore);

    // The terminating-phase drain does the rebuild, and it settles.
    $controller->runDeferredRegens();
    expect(hbNodeFingerprint($username))->not->toBe($fpBefore);
    expect(hbCardsIn($username))->toHaveCount(2);

    // Draining twice is a no-op (the queue empties on drain).
    $fpAfter = hbNodeFingerprint($username);
    $controller->runDeferredRegens();
    expect(hbNodeFingerprint($username))->toBe($fpAfter);
});
