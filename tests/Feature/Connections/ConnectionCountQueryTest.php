<?php

/**
 * ConnectionCountQuery — the docuverse-connectedness score behind the
 * "Most Connected" / "Most Lit" feeds. Each test locks ONE counting rule, so a
 * regression names the rule it broke rather than "the number changed".
 *
 * The rules exist because the column this replaced (library.total_citations)
 * counted INBOUND hypercites only, was refreshed only for `listed = true`
 * books (so the harvested journal corpus was permanently NULL), and excluded
 * only literal self-citations — a user ring-citing their own books scored in
 * full, and `library.listed` defaults to TRUE.
 *
 * Seeds via pgsql_admin with beforeEach-only cleanup: afterEach admin deletes
 * deadlock against the open RefreshDatabase transaction (docs/journal-harvest.md).
 */

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Connections\ConnectionCountQuery;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

const CONN_PREFIX = 'book_conntest_';

function connDb()
{
    return DB::connection('pgsql_admin');
}

function connCleanup(): void
{
    foreach (['hypercites', 'hyperlights', 'bibliography', 'footnotes', 'library'] as $table) {
        connDb()->table($table)->where('book', 'LIKE', CONN_PREFIX . '%')->delete();
    }
    connDb()->table('canonical_source')->where('title', 'LIKE', 'ConnTest %')->delete();
}

beforeEach(fn () => connCleanup());

// These fixtures are hypercite EDGES, and an edge is global — anything that
// reads the whole graph (the docuverse endpoint counts every edge) sees rows
// this file leaves behind. beforeEach alone is not enough here: afterAll runs
// once the last RefreshDatabase transaction has closed, so the admin deletes
// cannot deadlock against it.
afterAll(fn () => connCleanup());

/** A public, content-bearing book — the only kind that forms docuverse edges. */
function connBook(string $suffix, array $opts = []): string
{
    $book = CONN_PREFIX . $suffix;
    connDb()->table('library')->insert(array_merge([
        'book'       => $book,
        'title'      => 'ConnTest ' . $suffix,
        'visibility' => 'public',
        'listed'     => false,
        'has_nodes'  => true,
        'creator'    => AutoVersionResolver::CREATOR,
        'type'       => 'book',
        'raw_json'   => '[]',
        'timestamp'  => 0,
        'created_at' => now(),
    ], $opts));

    return $book;
}

/** One hypercite edge: a passage of $cited quoted inside $citing. */
function connHypercite(string $cited, string $citing, ?string $anchor = null): void
{
    $anchor ??= 'hypercite_' . Str::lower(Str::random(8));
    connDb()->table('hypercites')->insert([
        'book'        => $cited,
        'hyperciteId' => 'hypercite_' . Str::lower(Str::random(8)),
        'citedIN'     => json_encode(["/{$citing}#{$anchor}"]),
        'raw_json'    => '{}',
        'charData'    => '{}',
        'created_at'  => now(),
    ]);
}

/** One resolved reference edge: $citing's bibliography points at held $cited. */
function connReference(string $citing, string $cited): void
{
    connDb()->table('bibliography')->insert([
        'book'              => $citing,
        'referenceId'       => 'ref_' . Str::lower(Str::random(8)),
        'content'           => 'ConnTest reference',
        'foundation_source' => $cited,
        'created_at'        => now(),
    ]);
}

function connScore(string $book): array
{
    $rows = (new ConnectionCountQuery())->forBooks([$book]);

    return $rows[$book] ?? ['hc_in' => 0, 'hc_out' => 0, 'ref_in' => 0, 'ref_out' => 0, 'hypercite' => 0, 'reference' => 0];
}

// ── direction ────────────────────────────────────────────────────────────────

test('both directions count: the citing book scores too, not just the cited one', function () {
    $cited = connBook('cited');
    $citing = connBook('citing');
    connHypercite($cited, $citing);

    // The old total_citations scored a text that cites others at zero — the
    // edge lives only on the cited row, with the citing side an ↗ in node HTML.
    expect(connScore($citing)['hc_out'])->toBe(1);
    expect(connScore($cited)['hc_in'])->toBe(1);
});

test('inbound is weighted double, outbound single', function () {
    $subject = connBook('subject');
    connHypercite($subject, connBook('quoter'));          // 1 inbound
    connHypercite(connBook('quoted'), $subject);          // 1 outbound

    $s = connScore($subject);
    expect([$s['hc_in'], $s['hc_out']])->toBe([1, 1]);
    expect($s['hypercite'])->toBe(ConnectionCountQuery::INBOUND_WEIGHT + ConnectionCountQuery::OUTBOUND_WEIGHT);
    expect(ConnectionCountQuery::INBOUND_WEIGHT)->toBeGreaterThan(ConnectionCountQuery::OUTBOUND_WEIGHT);
});

// ── distinct counterparts ────────────────────────────────────────────────────

test('five quotes from one book is ONE connection, not five', function () {
    $cited = connBook('popular');
    $citing = connBook('enthusiast');
    for ($i = 0; $i < 5; $i++) {
        connHypercite($cited, $citing);
    }

    expect(connScore($cited)['hc_in'])->toBe(1);
});

test('quotes from five different books are five connections', function () {
    $cited = connBook('reached');
    for ($i = 0; $i < 5; $i++) {
        connHypercite($cited, connBook("reacher{$i}"));
    }

    expect(connScore($cited)['hc_in'])->toBe(5);
});

// ── self and ownership ───────────────────────────────────────────────────────

test('a book citing itself scores nothing', function () {
    $book = connBook('narcissus');
    connHypercite($book, $book);

    expect(connScore($book)['hypercite'])->toBe(0);
});

test('two books owned by the same real user do not connect each other', function () {
    $a = connBook('ring_a', ['creator' => 'ringleader']);
    $b = connBook('ring_b', ['creator' => 'ringleader']);
    connHypercite($a, $b);

    expect(connScore($a)['hypercite'])->toBe(0);
    expect(connScore($b)['hypercite'])->toBe(0);
});

test('two books owned by the same anonymous token do not connect each other', function () {
    $token = (string) Str::uuid();
    $a = connBook('anon_a', ['creator' => null, 'creator_token' => $token]);
    $b = connBook('anon_b', ['creator' => null, 'creator_token' => $token]);
    connHypercite($a, $b);

    expect(connScore($a)['hypercite'])->toBe(0);
});

test('commons books share a creator but still connect — the journal corpus depends on it', function () {
    // Every harvested article is minted with AutoVersionResolver::CREATOR, so a
    // blanket same-creator rule would delete every journal↔journal edge.
    $a = connBook('commons_a');
    $b = connBook('commons_b');
    expect(connDb()->table('library')->where('book', $a)->value('creator'))
        ->toBe(AutoVersionResolver::CREATOR);

    connHypercite($a, $b);

    expect(connScore($a)['hc_in'])->toBe(1);
    expect(connScore($b)['hc_out'])->toBe(1);
});

test('books owned by different users connect normally', function () {
    $a = connBook('alice_book', ['creator' => 'alice']);
    $b = connBook('bob_book', ['creator' => 'bob']);
    connHypercite($a, $b);

    expect(connScore($a)['hc_in'])->toBe(1);
});

// ── endpoint eligibility ─────────────────────────────────────────────────────

test('an edge to a private book is not a docuverse connection', function () {
    $public = connBook('open', ['creator' => 'alice']);
    $private = connBook('closed', ['creator' => 'bob', 'visibility' => 'private']);
    connHypercite($public, $private);

    expect(connScore($public)['hypercite'])->toBe(0);
});

test('an edge to a contentless stub does not count', function () {
    $real = connBook('real', ['creator' => 'alice']);
    $stub = connBook('stub', ['creator' => 'bob', 'has_nodes' => false]);
    connReference($stub, $real);

    expect(connScore($real)['reference'])->toBe(0);
});

// ── sub-book rollup ──────────────────────────────────────────────────────────

test('an edge from a footnote sub-book credits its parent', function () {
    $cited = connBook('parent_target', ['creator' => 'alice']);
    $parent = connBook('parent_source', ['creator' => 'bob']);
    connHypercite($cited, $parent . '/Fn1');

    expect(connScore($parent)['hc_out'])->toBe(1);
    expect(connScore($cited)['hc_in'])->toBe(1);
});

test('a parent citing its own footnote is a self-loop after rollup', function () {
    $parent = connBook('selfnote');
    connHypercite($parent, $parent . '/Fn1');

    expect(connScore($parent)['hypercite'])->toBe(0);
});

// ── reference edges ──────────────────────────────────────────────────────────

test('a resolved reference is a connection in both directions', function () {
    $citing = connBook('ref_citing', ['creator' => 'alice']);
    $cited = connBook('ref_cited', ['creator' => 'bob']);
    connReference($citing, $cited);

    expect(connScore($citing)['ref_out'])->toBe(1);
    expect(connScore($cited)['ref_in'])->toBe(1);
});

test("the scan's 'unknown' sentinel is not a target", function () {
    $citing = connBook('unresolved', ['creator' => 'alice']);
    connDb()->table('library')->insert([
        'book' => 'unknown', 'title' => 'ConnTest sentinel', 'visibility' => 'public',
        'has_nodes' => true, 'creator' => 'bob', 'type' => 'book', 'raw_json' => '[]',
        'timestamp' => 0, 'created_at' => now(),
    ]);
    connReference($citing, 'unknown');

    try {
        expect(connScore($citing)['reference'])->toBe(0);
    } finally {
        connDb()->table('library')->where('book', 'unknown')->delete();
    }
});

test('a citation footnote resolving to a held book counts; a non-citation footnote does not', function () {
    $cited = connBook('fn_cited', ['creator' => 'alice']);
    $citing = connBook('fn_citing', ['creator' => 'bob']);
    $other = connBook('fn_other', ['creator' => 'carol']);

    connDb()->table('footnotes')->insert([
        'book' => $citing, 'footnoteId' => 'fn1', 'content' => 'ConnTest note',
        'is_citation' => true, 'foundation_source' => $cited, 'created_at' => now(),
    ]);
    connDb()->table('footnotes')->insert([
        'book' => $citing, 'footnoteId' => 'fn2', 'content' => 'ConnTest aside',
        'is_citation' => false, 'foundation_source' => $other, 'created_at' => now(),
    ]);

    expect(connScore($citing)['ref_out'])->toBe(1);
    expect(connScore($other)['reference'])->toBe(0);
});

test('hypercite and reference families are scored separately', function () {
    $subject = connBook('two_families', ['creator' => 'alice']);
    connHypercite($subject, connBook('hc_source', ['creator' => 'bob']));
    connReference(connBook('ref_source', ['creator' => 'carol']), $subject);

    $s = connScore($subject);
    expect($s['hypercite'])->toBe(ConnectionCountQuery::INBOUND_WEIGHT);
    expect($s['reference'])->toBe(ConnectionCountQuery::INBOUND_WEIGHT);
});

// ── persistence ──────────────────────────────────────────────────────────────

test('recompute persists the columns, including a genuine zero for unconnected books', function () {
    $cited = connBook('persist_cited', ['creator' => 'alice']);
    $citing = connBook('persist_citing', ['creator' => 'bob']);
    $lonely = connBook('persist_lonely', ['creator' => 'carol']);
    connHypercite($cited, $citing);

    (new ConnectionCountQuery())->recompute([$cited, $citing, $lonely]);

    $row = fn ($b) => connDb()->table('library')->where('book', $b)->first();

    expect($row($cited)->hypercite_connections)->toBe(ConnectionCountQuery::INBOUND_WEIGHT);
    expect($row($citing)->hypercite_connections)->toBe(ConnectionCountQuery::OUTBOUND_WEIGHT);
    // Zero, not NULL: "computed and unconnected" must be distinguishable from
    // "never computed", which is what the whole journal corpus used to be.
    expect($row($lonely)->hypercite_connections)->toBe(0);
    expect($row($lonely)->reference_connections)->toBe(0);
});

test('recompute counts hyperlights for an unlisted book — the old job skipped those entirely', function () {
    $book = connBook('lit_book', ['creator' => 'alice', 'listed' => false]);
    foreach (range(1, 3) as $i) {
        connDb()->table('hyperlights')->insert([
            'book' => $book, 'hyperlight_id' => 'hl_' . $i, 'raw_json' => '{}',
            'created_at' => now(),
        ]);
    }

    (new ConnectionCountQuery())->recompute([$book]);

    expect(connDb()->table('library')->where('book', $book)->value('total_highlights'))->toBe(3);
});

test('recompute is idempotent and reports only rows that actually changed', function () {
    $cited = connBook('idem_cited', ['creator' => 'alice']);
    connHypercite($cited, connBook('idem_citing', ['creator' => 'bob']));

    $q = new ConnectionCountQuery();
    expect($q->recompute([$cited]))->toBeGreaterThan(0);
    // The IS DISTINCT FROM guard: a no-change pass must not rewrite the row,
    // or the 15-minute job churns dead tuples forever.
    expect($q->recompute([$cited]))->toBe(0);
});
