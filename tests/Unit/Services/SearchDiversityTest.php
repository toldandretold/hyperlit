<?php

/**
 * SearchService::diversifyByBook — the one rule for "no single book may fill a
 * node-search page". Pure function, no DB: the page keeps score order, caps a
 * book at perBookCap() while other books still have candidates, and backfills
 * from the skipped hits when the pool had fewer books than the cap allowed for.
 */

use App\Services\SearchService;

function sdRow(string $book, int $rank): array
{
    return ['book' => $book, 'rank' => $rank];
}

test('the per-book cap is about a fifth of the page, never below one', function () {
    expect(SearchService::perBookCap(20))->toBe(4)
        ->and(SearchService::perBookCap(50))->toBe(10)
        ->and(SearchService::perBookCap(10))->toBe(2)
        ->and(SearchService::perBookCap(3))->toBe(1)
        ->and(SearchService::perBookCap(0))->toBe(1)
        ->and(SearchService::poolSize(20))->toBe(20 * SearchService::DIVERSITY_POOL_FACTOR);
});

test('a dominant book is held to its cap while other books still have hits, in score order', function () {
    // Capital holds the 9 best hits; two essays come after. Page of 10, cap 2.
    $pool = [];
    for ($i = 1; $i <= 9; $i++) {
        $pool[] = sdRow('capital', $i);
    }
    $pool[] = sdRow('essay-a', 10);
    $pool[] = sdRow('essay-b', 11);
    for ($i = 12; $i <= 30; $i++) {
        $pool[] = sdRow('capital', $i);
    }

    $page = SearchService::diversifyByBook($pool, 10);

    expect($page)->toHaveCount(10);
    // The best hit overall is still first — the rule never reorders what it keeps.
    expect($page[0])->toBe(sdRow('capital', 1))
        ->and($page[1])->toBe(sdRow('capital', 2));
    // Both essays made the page instead of being crowded out...
    expect(array_column($page, 'book'))->toContain('essay-a')->toContain('essay-b');
    // ...and the essays come straight after Capital's capped share, ahead of
    // Capital's 3rd hit (which backfill then admits, in its own order).
    expect($page[2])->toBe(sdRow('essay-a', 10))
        ->and($page[3])->toBe(sdRow('essay-b', 11))
        ->and($page[4])->toBe(sdRow('capital', 3));
});

test('backfill fills a short page from the skipped hits rather than returning fewer results', function () {
    $pool = array_map(fn ($i) => sdRow('only-book', $i), range(1, 15));

    $page = SearchService::diversifyByBook($pool, 10);

    expect($page)->toHaveCount(10)
        ->and(array_column($page, 'rank'))->toBe(range(1, 10));
});

test('a pool with fewer rows than the page is returned whole, in order', function () {
    $pool = [sdRow('a', 1), sdRow('b', 2), sdRow('a', 3)];

    expect(SearchService::diversifyByBook($pool, 10))->toBe($pool);
});

test('objects are read by their book field and a custom accessor is honoured', function () {
    $obj = fn (string $book, int $n) => (object) ['book' => $book, 'n' => $n];
    $pool = [$obj('x', 1), $obj('x', 2), $obj('x', 3), $obj('y', 4)];

    // Page of 5 → cap 1: x1, then y4 (x2 skipped), then backfill x2, x3.
    $page = SearchService::diversifyByBook($pool, 5);
    expect(array_map(fn ($r) => $r->n, $page))->toBe([1, 4, 2, 3]);

    // Same pool grouped by a different key: every row is one group → untouched order.
    $byN = SearchService::diversifyByBook($pool, 5, fn ($r) => (string) $r->n);
    expect(array_map(fn ($r) => $r->n, $byN))->toBe([1, 2, 3, 4]);
});

test('a Collection is accepted as the pool', function () {
    $pool = collect([sdRow('a', 1), sdRow('a', 2), sdRow('b', 3)]);

    expect(array_column(SearchService::diversifyByBook($pool, 2), 'book'))->toBe(['a', 'b']);
});
