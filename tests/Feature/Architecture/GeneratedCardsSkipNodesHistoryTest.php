<?php

/**
 * Pins the nodes_history versioning-trigger exclusions
 * (2026_09_23_000000_exclude_generated_cards_from_nodes_history):
 *
 * Generated library-card nodes (node_id ending `_card` — every card minted by
 * LibraryCardGenerator across user home books, sorted variants and shelf
 * renders) must NOT be archived on insert/update/delete: those feed books are
 * rebuilt by delete-all + re-insert, and on production one user's home books
 * were the two largest entries in nodes_history. Real nodes must KEEP
 * versioning — including rows with a NULL node_id, because `x NOT LIKE y` is
 * NULL (not true) for NULL x and a naive WHEN clause would silently drop
 * their history.
 *
 * Writes go through pgsql_admin, which commits OUTSIDE the test transaction
 * (see the RLS harness notes) — so this file cleans up its own rows and uses
 * throwaway book ids no other test touches.
 */

use Illuminate\Support\Facades\DB;

const HIST_CARD_BOOK = 'nh_trigger_card_probe';
const HIST_REAL_BOOK = 'nh_trigger_real_probe';

function nhAdmin()
{
    return DB::connection('pgsql_admin');
}

function nhCleanup(): void
{
    nhAdmin()->table('nodes')->whereIn('book', [HIST_CARD_BOOK, HIST_REAL_BOOK])->delete();
    nhAdmin()->table('nodes_history')->whereIn('book', [HIST_CARD_BOOK, HIST_REAL_BOOK])->delete();
}

beforeEach(fn () => nhCleanup());
afterEach(fn () => nhCleanup());

function nhInsertNode(string $book, ?string $nodeId, string $content = '<p>v1</p>'): void
{
    nhAdmin()->table('nodes')->insert([
        'book' => $book, 'chunk_id' => 0, 'startLine' => 100,
        'node_id' => $nodeId, 'content' => $content, 'plainText' => strip_tags($content),
    ]);
}

function nhHistoryCount(string $book): int
{
    return nhAdmin()->table('nodes_history')->where('book', $book)->count();
}

test('a generated card node writes NO history on update or delete', function () {
    nhInsertNode(HIST_CARD_BOOK, HIST_CARD_BOOK . '_book_123_card');

    nhAdmin()->table('nodes')->where('book', HIST_CARD_BOOK)
        ->update(['content' => '<p>v2</p>']);
    expect(nhHistoryCount(HIST_CARD_BOOK))->toBe(0);

    nhAdmin()->table('nodes')->where('book', HIST_CARD_BOOK)->delete();
    expect(nhHistoryCount(HIST_CARD_BOOK))->toBe(0);
});

test('the empty-card and balance-card sentinels are excluded too', function () {
    nhInsertNode(HIST_CARD_BOOK, HIST_CARD_BOOK . '_empty_card');
    nhAdmin()->table('nodes')->where('book', HIST_CARD_BOOK)->delete();

    expect(nhHistoryCount(HIST_CARD_BOOK))->toBe(0);
});

test('a real node still versions on update and delete', function () {
    // Realistic generated id shape: {book}_{ts}_{rand9}
    nhInsertNode(HIST_REAL_BOOK, HIST_REAL_BOOK . '_1790000000000_a1b2c3d4e');

    nhAdmin()->table('nodes')->where('book', HIST_REAL_BOOK)
        ->update(['content' => '<p>v2</p>']);
    expect(nhHistoryCount(HIST_REAL_BOOK))->toBe(1);

    nhAdmin()->table('nodes')->where('book', HIST_REAL_BOOK)->delete();
    expect(nhHistoryCount(HIST_REAL_BOOK))->toBe(2);
});

test('a node with a NULL node_id still versions (NULL NOT LIKE is not true)', function () {
    nhInsertNode(HIST_REAL_BOOK, null);

    nhAdmin()->table('nodes')->where('book', HIST_REAL_BOOK)
        ->update(['content' => '<p>v2</p>']);
    expect(nhHistoryCount(HIST_REAL_BOOK))->toBe(1);
});

test('a node_id merely CONTAINING card mid-string still versions (suffix match only)', function () {
    nhInsertNode(HIST_REAL_BOOK, HIST_REAL_BOOK . '_cardigan_notes');

    nhAdmin()->table('nodes')->where('book', HIST_REAL_BOOK)
        ->update(['content' => '<p>v2</p>']);
    expect(nhHistoryCount(HIST_REAL_BOOK))->toBe(1);
});
