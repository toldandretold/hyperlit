<?php

/**
 * /api/search/semantic (SearchController::searchSemantic) — public, throttled,
 * read-only, free (no billing path; guests search too).
 *
 * The embedding provider is mocked (constructor-injected EmbeddingService, so
 * $this->mock() swaps it in the container) — these tests never hit Fireworks.
 * Visibility scoping for the underlying SQL is locked separately in
 * tests/Feature/AiBrain/RetrievalScopeTest.php.
 */

use App\Services\EmbeddingService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function semanticAdminDb()
{
    return DB::connection('pgsql_admin');
}

function seedSemanticBook(array $opts = []): string
{
    $book = 'book_semtest_' . Str::random(8);
    semanticAdminDb()->table('library')->insert([
        'book'       => $book,
        'title'      => $opts['title'] ?? 'Semantic test book',
        'author'     => $opts['author'] ?? 'Semantic author',
        'visibility' => $opts['visibility'] ?? 'public',
        'listed'     => $opts['listed'] ?? true,
        'type'       => 'book',
        'has_nodes'  => true,
        'raw_json'   => '[]',
        'timestamp'  => 0,
    ]);

    $vector = '[' . implode(',', array_fill(0, 768, 0.1)) . ']';
    semanticAdminDb()->table('nodes')->insert([
        'book'       => $book,
        'chunk_id'   => 0,
        'startLine'  => 1,
        'node_id'    => $book . '_node_1',
        'content'    => '<p>capitalist accumulation on a world scale</p>',
        'plainText'  => 'capitalist accumulation on a world scale',
        'embedding'  => semanticAdminDb()->raw("'{$vector}'::halfvec"),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $book;
}

// pgsql_admin inserts aren't rolled back by RefreshDatabase; array cache would
// otherwise leak the 60s payload cache between tests in the same process.
beforeEach(function () {
    Cache::flush();
    semanticAdminDb()->table('nodes')->whereRaw("book LIKE 'book_semtest_%'")->delete();
    semanticAdminDb()->table('library')->whereRaw("book LIKE 'book_semtest_%'")->delete();
});

afterEach(fn () => $this->cleanupApiFixtures());

test('GET /api/search/semantic returns the envelope with a seeded hit', function () {
    $book = seedSemanticBook();

    // Query vector identical to the seeded node vector → distance 0, passes
    // any sane max-distance cutoff.
    $this->mock(EmbeddingService::class)
        ->shouldReceive('embed')
        ->once()
        ->andReturn(array_fill(0, 768, 0.1));

    $response = $this->getJson('/api/search/semantic?q=accumulation of capital')
        ->assertStatus(200)
        ->assertJsonStructure(['success', 'results', 'query', 'mode', 'count'])
        ->assertJson(['success' => true, 'mode' => 'semantic']);

    $results = collect($response->json('results'));
    $hit = $results->firstWhere('book', $book);
    expect($hit)->not->toBeNull()
        ->and($hit['title'])->toBe('Semantic test book')
        ->and($hit['author'])->toBe('Semantic author')
        ->and($hit['startLine'])->toEqual(1) // numeric PG column serializes as a string, same as /nodes
        ->and($hit['excerpt'])->toContain('capitalist accumulation')
        ->and($hit['similarity'])->toBeGreaterThan(0.9)
        // identical vectors → similarity 1.0 → floor-rescaled match = 100 (a
        // TRUE 100: the scale's top is unclamped, only the floor is shifted)
        ->and($hit['match'])->toBe(100);
});

test('short query returns empty results without embedding', function () {
    $this->mock(EmbeddingService::class)
        ->shouldReceive('embed')
        ->never();

    $this->getJson('/api/search/semantic?q=ab')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'mode' => 'semantic', 'results' => []]);
});

test('embedding provider outage returns 503, and the failure is not cached', function () {
    $mock = $this->mock(EmbeddingService::class);
    $mock->shouldReceive('embed')->once()->andReturn(null);

    $this->assertApiError($this->getJson('/api/search/semantic?q=provider outage probe'), 503);

    // A second request must re-attempt the embed (nulls are never cached) and
    // succeed once the provider recovers.
    $mock->shouldReceive('embed')->once()->andReturn(array_fill(0, 768, 0.1));
    $this->getJson('/api/search/semantic?q=provider outage probe')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'mode' => 'semantic']);
});

test('results beyond the max-distance cutoff are dropped', function () {
    seedSemanticBook();

    // Orthogonal-ish query vector: node vectors are uniform 0.1s, so embed a
    // vector concentrated elsewhere → cosine distance ~1, beyond any cutoff.
    $far = array_fill(0, 768, 0.0);
    $far[0] = 1.0;
    $this->mock(EmbeddingService::class)
        ->shouldReceive('embed')
        ->once()
        ->andReturn($far);

    $this->getJson('/api/search/semantic?q=totally unrelated far query')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'results' => [], 'count' => 0]);
});
