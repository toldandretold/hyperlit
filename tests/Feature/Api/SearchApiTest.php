<?php

/**
 * Search endpoints (SearchController) — public, throttled, read-only.
 *
 * Representative of the Phase-2 read-path pattern: no auth, assert the JSON
 * envelope the SPA consumes. Kept deterministic — we use the short-query branch
 * (which returns an empty envelope without touching search infra or OpenAlex) so
 * these don't depend on indexed content or the network.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

test('GET /api/search/library is public and returns the search envelope', function () {
    // Guest, short query (<2 chars) → the early empty-results branch.
    $this->getJson('/api/search/library?q=a')
        ->assertStatus(200)
        ->assertJsonStructure(['success', 'results', 'query', 'mode'])
        ->assertJson(['success' => true, 'mode' => 'library', 'results' => []]);
});

test('GET /api/search/library echoes the query back', function () {
    $this->getJson('/api/search/library?q=x')
        ->assertStatus(200)
        ->assertJson(['query' => 'x']);
});

test('GET /api/search/combined rejects an invalid sourceScope', function () {
    // Validation fails before any search/OpenAlex work, so this is deterministic.
    // sourceScope must be one of public|mine|shelf — invalid value is rejected by
    // validation before any search/OpenAlex work runs, so this is deterministic.
    // (This endpoint returns a proper 422 — one of the more consistent ones.)
    $this->assertApiError($this->getJson('/api/search/combined?q=hello&sourceScope=bogus'), 422);
});

test('GET /api/search/nodes: one long book cannot fill the page — the other book still appears within the limit', function () {
    $admin = DB::connection('pgsql_admin');
    $tag = Str::lower(Str::random(6));
    $books = [];
    try {
        foreach (['long', 'short'] as $kind) {
            $book = "book_nsearch_{$kind}_{$tag}";
            $books[$kind] = $book;
            $admin->table('library')->insert([
                'book' => $book, 'title' => "Nsearch {$kind} {$tag}", 'author' => 'Nsearch Author',
                'visibility' => 'public', 'listed' => true, 'has_nodes' => true, 'type' => 'book',
                'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
            ]);
        }
        // A token no real book carries, so the page is only these two books.
        $word = "zq{$tag}glockenspiel";
        for ($i = 1; $i <= 30; $i++) {
            $admin->table('nodes')->insert([
                'book' => $books['long'], 'chunk_id' => 0, 'startLine' => $i, 'node_id' => $books['long'] . "_n{$i}",
                'content' => "<p>the {$word} paragraph {$i}</p>", 'plainText' => "the {$word} paragraph {$i}",
                'created_at' => now(), 'updated_at' => now(),
            ]);
        }
        $admin->table('nodes')->insert([
            'book' => $books['short'], 'chunk_id' => 0, 'startLine' => 1, 'node_id' => $books['short'] . '_n1',
            'content' => "<p>a lone {$word}</p>", 'plainText' => "a lone {$word}",
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $res = $this->getJson("/api/search/nodes?q={$word}&limit=10")->assertOk();
        $groups = collect($res->json('results'));

        expect($res->json('count'))->toBe(10)
            ->and($groups->pluck('book')->all())->toContain($books['long'])->toContain($books['short'])
            ->and(count($groups->firstWhere('book', $books['long'])['matches']))->toBe(9)
            ->and(count($groups->firstWhere('book', $books['short'])['matches']))->toBe(1);
    } finally {
        $admin->table('nodes')->whereIn('book', array_values($books))->delete();
        $admin->table('library')->whereIn('book', array_values($books))->delete();
    }
});
