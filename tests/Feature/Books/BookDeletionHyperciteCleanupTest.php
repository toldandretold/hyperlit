<?php

/**
 * Hypercite cleanup on book / sub-book deletion (App\Services\BookDeletionService).
 *
 * These two functions hold the entire cross-book citation invariant together and
 * had ZERO test coverage before this file:
 *
 * - delinkOrphanedHypercites($deletedBook): when the CITING book dies, every
 *   "/deletedBook#…" and "/deletedBook/…" entry is stripped from other books'
 *   hypercites' citedIN and relationshipStatus is recomputed — otherwise the
 *   source <u> shows dead citations forever (red in the manual health check).
 *
 * - markHypercitesAsDead($bookId): when the CITED book dies, its own hypercite
 *   rows are KEPT (pastes still render the citation text) but flipped to
 *   relationshipStatus 'dead', and every citing book's annotations_updated_at
 *   is bumped so clients re-pull and show the "Source text removed" state.
 *
 * AI Archivist answer books delete through the same DELETE /api/books/{id} →
 * deleteBook() path, so this coverage is theirs too.
 */

use App\Services\BookDeletionService;
use Illuminate\Support\Facades\DB;

function hcdelDb()
{
    return DB::connection('pgsql_admin');
}

function hcdelService(): BookDeletionService
{
    return (new BookDeletionService())->useConnection(hcdelDb());
}

function hcdelBook(string $book, array $extra = []): void
{
    hcdelDb()->table('library')->insert(array_merge([
        'book' => $book,
        'title' => 'Hypercite deletion test',
        'creator' => null,
        'creator_token' => '22222222-2222-2222-2222-222222222222',
        'visibility' => 'public',
        'timestamp' => now()->timestamp,
        'annotations_updated_at' => 0,
        'raw_json' => json_encode([]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $extra));
}

function hcdelHypercite(string $book, string $hyperciteId, array $citedIN, string $status): void
{
    hcdelDb()->table('hypercites')->insert([
        'book' => $book,
        'hyperciteId' => $hyperciteId,
        'citedIN' => json_encode($citedIN),
        'relationshipStatus' => $status,
        'raw_json' => '{}',
        'charData' => '{}',
        'created_at' => now(),
    ]);
}

function hcdelReadHypercite(string $book, string $hyperciteId): ?object
{
    $row = hcdelDb()->table('hypercites')->where('book', $book)->where('hyperciteId', $hyperciteId)->first();
    if ($row) {
        $row->citedIN_decoded = json_decode($row->citedIN, true);
    }
    return $row;
}

/**
 * Cleanup split — deleteBook bumps annotations_updated_at through the DEFAULT
 * connection (DB::select('SELECT update_annotations_timestamp…')), which runs
 * inside RefreshDatabase's wrapping transaction and holds row locks on the
 * hcdel% LIBRARY rows until the test's teardown rollback. An afterEach
 * admin-connection DELETE on library therefore deadlocks (the same
 * cross-connection block that made AskStandaloneBookTest avoid the delete
 * path). So: library rows are swept in beforeEach — by then the PREVIOUS
 * test's transaction has rolled back and released its locks — and only the
 * admin-written tables (never touched by the default connection) are cleaned
 * in afterEach. Rows from the run's last test are prefix-scoped cruft removed
 * by the next run's beforeEach.
 */
beforeEach(function () {
    hcdelDb()->table('library')->where('book', 'like', 'hcdel%')->delete();
});

afterEach(function () {
    $admin = hcdelDb();
    foreach (['hypercites', 'hyperlights', 'footnotes', 'nodes'] as $table) {
        $admin->table($table)->where('book', 'like', 'hcdel%')->delete();
    }
});

// ─────────────────────────────────────────────────────────────────
// Direction 1: the CITING book is deleted → other books' citedIN cleaned
// ─────────────────────────────────────────────────────────────────

test('deleting the CITING book strips its citedIN entries from other books and recomputes status', function () {
    hcdelBook('hcdel_src');
    hcdelBook('hcdel_citer');
    hcdelBook('hcdel_other');
    hcdelHypercite('hcdel_src', 'hypercite_poly1', [
        '/hcdel_citer#hypercite_a1',
        '/hcdel_other#hypercite_b1',
    ], 'poly');

    $stats = hcdelService()->deleteBook('hcdel_citer');

    expect($stats['hypercites_delinked'])->toBe(1);
    $row = hcdelReadHypercite('hcdel_src', 'hypercite_poly1');
    expect($row->citedIN_decoded)->toBe(['/hcdel_other#hypercite_b1']);
    expect($row->relationshipStatus)->toBe('couple');
});

test('delink demotes couple→single when the deleted book held the only citation', function () {
    hcdelBook('hcdel_src');
    hcdelBook('hcdel_citer');
    hcdelHypercite('hcdel_src', 'hypercite_only1', ['/hcdel_citer#hypercite_a1'], 'couple');

    hcdelService()->deleteBook('hcdel_citer');

    $row = hcdelReadHypercite('hcdel_src', 'hypercite_only1');
    expect($row->citedIN_decoded)->toBe([]);
    expect($row->relationshipStatus)->toBe('single');
});

test('delink is prefix-safe: deleting hcdel_citer never touches hcdel_citerx entries', function () {
    hcdelBook('hcdel_src');
    hcdelBook('hcdel_citer');
    hcdelBook('hcdel_citerx');
    hcdelHypercite('hcdel_src', 'hypercite_pfx1', ['/hcdel_citerx#hypercite_c1'], 'couple');

    $stats = hcdelService()->deleteBook('hcdel_citer');

    expect($stats['hypercites_delinked'])->toBe(0);
    $row = hcdelReadHypercite('hcdel_src', 'hypercite_pfx1');
    expect($row->citedIN_decoded)->toBe(['/hcdel_citerx#hypercite_c1']);
    expect($row->relationshipStatus)->toBe('couple');
});

test('citedIN entries pointing INTO a deleted book\'s sub-books are stripped too (the "/book/…" branch)', function () {
    hcdelBook('hcdel_src');
    hcdelBook('hcdel_parent2');
    hcdelBook('hcdel_other2');
    hcdelHypercite('hcdel_src', 'hypercite_sub1', [
        '/hcdel_parent2/Fn1#hypercite_z1',
        '/hcdel_other2#hypercite_k1',
    ], 'poly');

    hcdelService()->deleteBook('hcdel_parent2');

    $row = hcdelReadHypercite('hcdel_src', 'hypercite_sub1');
    expect($row->citedIN_decoded)->toBe(['/hcdel_other2#hypercite_k1']);
    expect($row->relationshipStatus)->toBe('couple');
});

test('delink bumps annotations_updated_at on the SOURCE book so clients re-pull', function () {
    hcdelBook('hcdel_src');
    hcdelBook('hcdel_citer');
    hcdelHypercite('hcdel_src', 'hypercite_ts1', ['/hcdel_citer#hypercite_a1'], 'couple');

    hcdelService()->deleteBook('hcdel_citer');

    // Read via the DEFAULT connection: update_annotations_timestamp runs there,
    // inside RefreshDatabase's transaction — the admin connection can't see it.
    $ts = DB::table('library')->where('book', 'hcdel_src')->value('annotations_updated_at');
    expect((int) $ts)->toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────
// Direction 2: the CITED book is deleted → its rows kept, marked dead
// ─────────────────────────────────────────────────────────────────

test('deleting the CITED book KEEPS its hypercite rows but marks cited ones dead', function () {
    hcdelBook('hcdel_dead');
    hcdelBook('hcdel_citer2');
    hcdelHypercite('hcdel_dead', 'hypercite_cited1', ['/hcdel_citer2#hypercite_x1'], 'couple');
    hcdelHypercite('hcdel_dead', 'hypercite_uncited1', [], 'single');

    $stats = hcdelService()->deleteBook('hcdel_dead');

    expect($stats['hypercites_marked_dead'])->toBe(1);
    expect($stats['hypercites_kept'])->toBe(2);

    $cited = hcdelReadHypercite('hcdel_dead', 'hypercite_cited1');
    expect($cited)->not->toBeNull(); // row RETAINED, never deleted
    expect($cited->relationshipStatus)->toBe('dead');

    // Uncited rows stay as-is — nothing cites them, nothing to signal.
    expect(hcdelReadHypercite('hcdel_dead', 'hypercite_uncited1')->relationshipStatus)->toBe('single');
});

test('marking dead bumps annotations_updated_at on every CITING book', function () {
    hcdelBook('hcdel_dead');
    hcdelBook('hcdel_citer2');
    hcdelHypercite('hcdel_dead', 'hypercite_cited2', ['/hcdel_citer2#hypercite_x1'], 'couple');

    hcdelService()->deleteBook('hcdel_dead');

    // Default connection — see the delink timestamp test above.
    $ts = DB::table('library')->where('book', 'hcdel_citer2')->value('annotations_updated_at');
    expect((int) $ts)->toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────
// Descendants: footnote sub-books die with the parent, hyperlight
// sub-books survive as metadata_only — hypercites follow suit
// ─────────────────────────────────────────────────────────────────

test('a footnote sub-book\'s hypercites are marked dead when the parent book is deleted', function () {
    hcdelBook('hcdel_parent');
    hcdelBook('hcdel_parent/Fn9');
    hcdelBook('hcdel_citer3');
    hcdelDb()->table('footnotes')->insert([
        'book' => 'hcdel_parent', 'footnoteId' => 'Fn9',
        'content' => '<p>footnote content</p>',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    hcdelHypercite('hcdel_parent/Fn9', 'hypercite_fnsub1', ['/hcdel_citer3#hypercite_y1'], 'couple');

    $stats = hcdelService()->deleteBook('hcdel_parent');

    expect($stats['hypercites_marked_dead'])->toBe(1);
    expect(hcdelReadHypercite('hcdel_parent/Fn9', 'hypercite_fnsub1')->relationshipStatus)->toBe('dead');
    expect(hcdelDb()->table('library')->where('book', 'hcdel_parent/Fn9')->value('visibility'))->toBe('deleted');
});

test('CHARACTERIZATION (known over-reach): a preserved hyperlight sub-book still loses its citedIN registration', function () {
    // Hyperlight sub-books are metadata_only — their CONTENT survives the parent's
    // deletion (their citing anchors keep rendering) — yet delinkOrphanedHypercites'
    // '%"/book/%' LIKE also strips THEIR entries from source books' citedIN. This
    // test pins the current behaviour so a deliberate fix flips it consciously;
    // it is NOT an endorsement.
    hcdelBook('hcdel_parent3');
    hcdelBook('hcdel_parent3/HL_1');
    hcdelBook('hcdel_src3');
    hcdelDb()->table('hyperlights')->insert([
        'book' => 'hcdel_parent3',
        'hyperlight_id' => 'HL_1',
        'sub_book_id' => 'hcdel_parent3/HL_1',
        'node_id' => json_encode([]),
        'charData' => json_encode([]),
        'highlightedText' => 'annotated text',
        'creator' => 'someone',
        'time_since' => time(),
        'raw_json' => '{}',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    hcdelDb()->table('nodes')->insert([
        'book' => 'hcdel_parent3/HL_1', 'startLine' => 100, 'chunk_id' => 0,
        'node_id' => 'hcdel_sub_node_1', 'content' => '<p>preserved annotation content</p>',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    hcdelHypercite('hcdel_src3', 'hypercite_hlsub1', ['/hcdel_parent3/HL_1#hypercite_q1'], 'couple');

    hcdelService()->deleteBook('hcdel_parent3');

    // metadata_only: the sub-book's CONTENT survives…
    expect(hcdelDb()->table('nodes')->where('book', 'hcdel_parent3/HL_1')->count())->toBe(1);
    // …but its registration on the source side is stripped anyway (the over-reach).
    $row = hcdelReadHypercite('hcdel_src3', 'hypercite_hlsub1');
    expect($row->citedIN_decoded)->toBe([]);
    expect($row->relationshipStatus)->toBe('single');
});
