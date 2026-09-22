<?php

/**
 * /api/search/in-book (SearchController::searchInBook) — the reader's in-text
 * find bar in "meaning" mode. Same engine as /api/search/semantic, scoped to ONE
 * book, returning node-granular hits (no character offsets — what matched is the
 * whole paragraph).
 *
 * The embedding provider is mocked throughout; these tests never hit Fireworks.
 *
 * 🔒 The access tests are the point of this file. This search runs on the
 * BYPASSRLS connection, so SearchService::bookSemanticallySearchable is the ONLY
 * guard — a regression there hands out another user's private book's node text.
 */

use App\Services\EmbeddingService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function inBookAdminDb()
{
    return DB::connection('pgsql_admin');
}

/**
 * Seed a book with one embedded node. The vector is uniform 0.1s so a query of
 * the same shape gives distance 0 (similarity 1.0).
 */
function seedInBookFixture(array $opts = []): string
{
    $book = $opts['book'] ?? 'book_inbooktest_' . Str::random(8);

    inBookAdminDb()->table('library')->insert([
        'book'          => $book,
        'title'         => $opts['title'] ?? 'In-book test',
        'author'        => 'In-book author',
        'visibility'    => $opts['visibility'] ?? 'public',
        'listed'        => $opts['listed'] ?? true,
        'type'          => $opts['type'] ?? 'book',
        'encrypted'     => $opts['encrypted'] ?? false,
        'creator'       => $opts['creator'] ?? null,
        'creator_token' => $opts['creator_token'] ?? null,
        'has_nodes'     => true,
        'raw_json'      => $opts['raw_json'] ?? '[]',
        'timestamp'     => 0,
    ]);

    $vector = '[' . implode(',', array_fill(0, 768, 0.1)) . ']';
    inBookAdminDb()->table('nodes')->insert([
        'book'       => $book,
        'chunk_id'   => 7,
        'startLine'  => 420,
        'node_id'    => $book . '_node_1',
        'content'    => '<p>the tendency of the rate of profit to fall</p>',
        'plainText'  => 'the tendency of the rate of profit to fall',
        'embedding'  => inBookAdminDb()->raw("'{$vector}'::halfvec"),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $book;
}

/** A query vector identical to the seeded node's → distance 0, similarity 1. */
function nearVector(): array
{
    return array_fill(0, 768, 0.1);
}

// pgsql_admin inserts aren't rolled back by RefreshDatabase, and the array cache
// would otherwise leak the 60s payload cache between tests in one process.
beforeEach(function () {
    Cache::flush();
    inBookAdminDb()->table('nodes')->whereRaw("book LIKE 'book_inbooktest_%'")->delete();
    inBookAdminDb()->table('library')->whereRaw("book LIKE 'book_inbooktest_%'")->delete();
});

afterEach(fn () => $this->cleanupApiFixtures());

test('returns the envelope with a seeded hit carrying chunk_id', function () {
    $book = seedInBookFixture();
    $this->mock(EmbeddingService::class)
        ->shouldReceive('embedSearchQuery')->andReturn(nearVector());

    $response = $this->getJson('/api/search/in-book?book=' . urlencode($book) . '&q=falling profitability')
        ->assertStatus(200)
        ->assertJsonStructure(['success', 'results', 'query', 'book', 'mode', 'count'])
        ->assertJson(['success' => true, 'mode' => 'semantic', 'book' => $book]);

    $hit = $response->json('results.0');

    expect($hit)->not->toBeNull()
        ->and($hit['startLine'])->toEqual(420)
        // chunk_id is why this endpoint exists separately from /semantic: the
        // toolbar needs it to know whether the hit's chunk is already lazy-loaded.
        ->and($hit['chunk_id'])->toEqual(7)
        ->and($hit['excerpt'])->toContain('rate of profit')
        ->and($hit['similarity'])->toBeGreaterThan(0.99)
        // Identical vectors → similarity 1.0 → a TRUE 100 (top unclamped).
        ->and($hit['match'])->toBe(100);

    // No book/title/author echoed back — the caller is reading the book already.
    expect($hit)->not->toHaveKey('title');
});

test('another users private book is refused, not searched', function () {
    $owner = $this->apiUser(['name' => 'inbook_owner_' . Str::random(6)]);
    $book = seedInBookFixture(['visibility' => 'private', 'listed' => false, 'creator' => $owner->name]);

    // A DIFFERENT logged-in user. The hole this guards: BookAccess reads library
    // on the RLS connection, gets NO ROW for someone else's private book, and
    // returns true ("legacy or public content") — which on a BYPASSRLS search
    // would return the node text.
    $this->loginUser();

    $this->mock(EmbeddingService::class)->shouldReceive('embedSearchQuery')->never();

    $this->assertApiError(
        $this->getJson('/api/search/in-book?book=' . urlencode($book) . '&q=falling profitability'),
        403,
    );
});

test('the owner can search their own private book', function () {
    $owner = $this->apiUser(['name' => 'inbook_owner_' . Str::random(6)]);
    $book = seedInBookFixture(['visibility' => 'private', 'listed' => false, 'creator' => $owner->name]);

    $this->actingAs($owner);
    $this->mock(EmbeddingService::class)
        ->shouldReceive('embedSearchQuery')->andReturn(nearVector());

    $this->getJson('/api/search/in-book?book=' . urlencode($book) . '&q=falling profitability')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'count' => 1]);
});

test('an unlisted but public book IS searchable', function () {
    // Harvested journal articles are minted listed = false. The homepage
    // visibility clause would refuse them; "may I read this book" must not.
    $book = seedInBookFixture(['listed' => false]);
    $this->mock(EmbeddingService::class)
        ->shouldReceive('embedSearchQuery')->andReturn(nearVector());

    $this->getJson('/api/search/in-book?book=' . urlencode($book) . '&q=falling profitability')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'count' => 1]);
});

test('books whose nodes are never embedded are refused up front', function (array $opts) {
    $book = seedInBookFixture($opts);

    // Refused BEFORE any embedding call — the result could only ever be empty,
    // so spending a provider round-trip to discover that is pure waste.
    $this->mock(EmbeddingService::class)->shouldReceive('embedSearchQuery')->never();

    $this->assertApiError(
        $this->getJson('/api/search/in-book?book=' . urlencode($book) . '&q=falling profitability'),
        403,
    );
})->with([
    'E2EE encrypted'      => [['encrypted' => true]],
    'sub-book'            => [['type' => 'sub_book']],
    'generated card list' => [['raw_json' => '{"type":"shelf"}']],
    'deleted'             => [['visibility' => 'deleted']],
]);

test('a book with no library row at all is refused', function () {
    $this->mock(EmbeddingService::class)->shouldReceive('embedSearchQuery')->never();

    $this->assertApiError(
        $this->getJson('/api/search/in-book?book=book_inbooktest_nonexistent&q=falling profitability'),
        403,
    );
});

test('a missing book parameter is a 422', function () {
    $this->assertApiError($this->getJson('/api/search/in-book?q=falling profitability'), 422);
});

test('short query returns empty results without embedding', function () {
    $book = seedInBookFixture();
    $this->mock(EmbeddingService::class)->shouldReceive('embedSearchQuery')->never();

    $this->getJson('/api/search/in-book?book=' . urlencode($book) . '&q=ab')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'mode' => 'semantic', 'results' => [], 'count' => 0]);
});

test('embedding provider outage returns 503', function () {
    $book = seedInBookFixture();

    $mock = $this->partialMock(EmbeddingService::class);
    $mock->shouldReceive('embed')->once()->andReturn(null);

    $this->assertApiError(
        $this->getJson('/api/search/in-book?book=' . urlencode($book) . '&q=provider outage probe'),
        503,
    );
});

test('a node below the in-book similarity floor is dropped', function () {
    $book = seedInBookFixture();

    // Node vectors are uniform 0.1s; concentrate the query elsewhere → cosine
    // distance ~1, far below semantic_in_book_min_similarity.
    $far = array_fill(0, 768, 0.0);
    $far[0] = 1.0;
    $this->mock(EmbeddingService::class)
        ->shouldReceive('embedSearchQuery')
        ->andReturn($far);

    $this->getJson('/api/search/in-book?book=' . urlencode($book) . '&q=an utterly unrelated query')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'results' => [], 'count' => 0]);
});

test('match% rescales from the IN-BOOK floor, not the homepage floor', function () {
    // The whole reason the in-book knobs exist. Within one document the cosine
    // noise floor is ~0.67 (measured on chacko c128), so a paragraph that is
    // merely topically adjacent must NOT badge like a strong corpus-wide hit.
    config([
        'services.llm.semantic_in_book_match_floor' => 0.65,
        'services.llm.semantic_in_book_min_similarity' => 0.5,
        // Deliberately different, to prove the in-book path doesn't read these.
        'services.llm.semantic_match_floor' => 0.55,
        'services.llm.semantic_max_distance' => 0.6,
    ]);

    $book = seedInBookFixture();

    // A query vector at a MID-RANGE cosine similarity to the uniform node
    // vector: keep every dimension aligned but push one off-axis. With the node
    // at 0.1 across 768 dims, dim0 = 2.5 lands around 0.77 — comfortably above
    // the 0.65 floor (so neither scale clamps to zero and the comparison below
    // is meaningful) and well short of a verbatim match.
    $vec = array_fill(0, 768, 0.1);
    $vec[0] = 2.5;
    $this->mock(EmbeddingService::class)->shouldReceive('embedSearchQuery')->andReturn($vec);

    $hit = $this->getJson('/api/search/in-book?book=' . urlencode($book) . '&q=a merely adjacent paragraph')
        ->assertStatus(200)
        ->json('results.0');

    expect($hit)->not->toBeNull();

    $sim = $hit['similarity'];

    // Fail loudly if the fixture drifts out of the mid-range band, rather than
    // silently comparing two clamped zeros.
    expect($sim)->toBeGreaterThan(0.7)->toBeLessThan(0.9);

    $expectedInBook = (int) round(max(0, ($sim - 0.65) / (1 - 0.65)) * 100);
    $wouldBeHomepage = (int) round(max(0, ($sim - 0.55) / (1 - 0.55)) * 100);

    expect($hit['match'])->toBe($expectedInBook)
        // Guards against someone "simplifying" this back onto the shared knobs:
        // the two scales must visibly disagree on a mid-range hit.
        ->and($expectedInBook)->toBeLessThan($wouldBeHomepage);
});
