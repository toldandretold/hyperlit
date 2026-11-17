<?php

/**
 * Public shelf search modes — the journal page's search box rides these:
 * default (mode=library) = titles & authors within the shelf's public books
 * (homepage parity), no mode = full-text node search (pre-existing).
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (afterEach admin deletes
 * deadlock against the open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use App\Services\EmbeddingService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function jsearchDb()
{
    return DB::connection('pgsql_admin');
}

function jsearchCleanup(): void
{
    $db = jsearchDb();
    $shelfIds = $db->table('shelves')->where('name', 'LIKE', 'JSearch %')->pluck('id');
    foreach ($shelfIds as $shelfId) {
        $db->table('shelf_items')->where('shelf_id', $shelfId)->delete();
    }
    $db->table('shelves')->whereIn('id', $shelfIds)->delete();
    $db->table('library')->where('title', 'LIKE', 'JSearch %')->delete();
}

beforeEach(fn() => jsearchCleanup());

function jsearchSeedShelfWithBooks(): array
{
    $db = jsearchDb();
    $shelfId = (string) Str::uuid();
    $db->table('shelves')->insert([
        'id'           => $shelfId,
        'creator'      => 'jsearch_creator',
        'name'         => 'JSearch ' . Str::random(6),
        'slug'         => 'jsearch-' . Str::lower(Str::random(8)),
        'visibility'   => 'public',
        'default_sort' => 'recent',
        'created_at'   => now(),
        'updated_at'   => now(),
    ]);

    $mk = function (string $title, string $author, string $visibility) use ($db, $shelfId) {
        $book = 'book_jsearch_' . Str::lower(Str::random(8));
        $db->table('library')->insert([
            'book' => $book, 'title' => $title, 'author' => $author,
            'visibility' => $visibility, 'listed' => false, 'has_nodes' => true,
            'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
        ]);
        $db->table('shelf_items')->insert(['shelf_id' => $shelfId, 'book' => $book, 'added_at' => now()]);
        return $book;
    };

    return [
        'shelfId'  => $shelfId,
        'match'    => $mk('JSearch Xylophone Economics', 'Doe, Jane', 'public'),
        'other'    => $mk('JSearch Unrelated Topic', 'Smith, Bob', 'public'),
        'private'  => $mk('JSearch Xylophone Hidden', 'Doe, Jane', 'private'),
    ];
}

test('mode=library searches titles & authors within the shelf, public books only', function () {
    $s = jsearchSeedShelfWithBooks();

    // A public book OUTSIDE the shelf that would match globally — must not appear.
    jsearchDb()->table('library')->insert([
        'book' => 'book_jsearch_' . Str::lower(Str::random(8)),
        'title' => 'JSearch Xylophone Outsider', 'author' => 'Doe, Jane',
        'visibility' => 'public', 'listed' => true, 'has_nodes' => true,
        'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
    ]);

    $response = $this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=xylophone&mode=library");
    $response->assertOk();

    expect($response->json('mode'))->toBe('library');
    $books = array_column($response->json('results'), 'book');
    expect($books)->toContain($s['match']);
    expect($books)->not->toContain($s['other']);      // no title match
    expect($books)->not->toContain($s['private']);    // private excluded
    expect(count($books))->toBe(1);                   // outsider excluded (shelf scope)

    $hit = collect($response->json('results'))->firstWhere('book', $s['match']);
    expect($hit['headline'])->toContain('Xylophone');
});

test('mode=library short queries return empty, non-public shelf 404s', function () {
    $s = jsearchSeedShelfWithBooks();

    $this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=x&mode=library")
        ->assertOk()
        ->assertJsonPath('results', []);

    jsearchDb()->table('shelves')->where('id', $s['shelfId'])->update(['visibility' => 'private']);
    $this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=xylophone&mode=library")
        ->assertStatus(404);
});

// -----------------------------------------------------------------------------
// mode=semantic — homepage semantic engine scoped to the shelf's public books
// -----------------------------------------------------------------------------

function jsearchEmbedNode(string $book): void
{
    $vector = '[' . implode(',', array_fill(0, 768, 0.1)) . ']';
    jsearchDb()->table('nodes')->insert([
        'book' => $book, 'chunk_id' => 0, 'startLine' => 1,
        'node_id' => $book . '_node_1',
        'content' => '<p>economics of xylophones</p>',
        'plainText' => 'economics of xylophones',
        'embedding' => jsearchDb()->raw("'{$vector}'::halfvec"),
        'created_at' => now(), 'updated_at' => now(),
    ]);
}

test('mode=semantic returns shelf public books only, with the semantic envelope', function () {
    Cache::flush(); // the per-shelf 60s payload cache would leak across runs
    $s = jsearchSeedShelfWithBooks();
    jsearchDb()->table('nodes')->whereRaw("book LIKE 'book_jsearch_%'")->delete();
    jsearchEmbedNode($s['match']);
    jsearchEmbedNode($s['private']); // in shelf but private — must not appear

    // Public embedded book OUTSIDE the shelf — must not appear either.
    $outsider = 'book_jsearch_' . Str::lower(Str::random(8));
    jsearchDb()->table('library')->insert([
        'book' => $outsider, 'title' => 'JSearch Outsider', 'author' => 'Doe, Jane',
        'visibility' => 'public', 'listed' => true, 'has_nodes' => true,
        'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
    ]);
    jsearchEmbedNode($outsider);

    $this->mock(EmbeddingService::class)
        ->shouldReceive('embedSearchQuery')
        ->once()
        ->andReturn(array_fill(0, 768, 0.1)); // identical to seeded vectors → distance 0

    $response = $this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=xylophone economics&mode=semantic");
    $response->assertOk();

    expect($response->json('mode'))->toBe('semantic');
    $books = array_column($response->json('results'), 'book');
    expect($books)->toContain($s['match']);
    expect($books)->not->toContain($s['private']);
    expect($books)->not->toContain($outsider);

    $hit = collect($response->json('results'))->firstWhere('book', $s['match']);
    expect($hit['excerpt'])->toContain('xylophones');
    expect($hit['match'])->toBe(100); // identical vectors → true 100
});

test("mode=semantic leaves out the shelf's overview book; title search still finds it", function () {
    Cache::flush();
    $s = jsearchSeedShelfWithBooks();
    jsearchDb()->table('nodes')->whereRaw("book LIKE 'book_jsearch_%'")->delete();
    jsearchEmbedNode($s['match']);
    jsearchEmbedNode($s['other']);
    // The course guide: it talks about everything on the shelf, so it would
    // otherwise sit at the top of every "find me a source" query.
    jsearchDb()->table('shelves')->where('id', $s['shelfId'])->update(['overview_book' => $s['other']]);

    $this->mock(EmbeddingService::class)
        ->shouldReceive('embedSearchQuery')
        ->once()
        ->andReturn(array_fill(0, 768, 0.1));

    $books = array_column(
        $this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=xylophone economics&mode=semantic")
            ->assertOk()->json('results'),
        'book',
    );
    expect($books)->toContain($s['match']);
    expect($books)->not->toContain($s['other']);

    // Looking it up BY NAME is a different job, and still works.
    $titles = array_column(
        $this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=unrelated&mode=library")
            ->assertOk()->json('results'),
        'book',
    );
    expect($titles)->toContain($s['other']);
});

test('mode=semantic short query returns empty; provider outage 503s', function () {
    Cache::flush();
    $s = jsearchSeedShelfWithBooks();

    $mock = $this->mock(EmbeddingService::class);
    $mock->shouldReceive('embedSearchQuery')->never();
    $this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=ab&mode=semantic")
        ->assertOk()
        ->assertJsonPath('results', []);

    $mock->shouldReceive('embedSearchQuery')->once()->andReturn(null);
    $this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=xylophone economics&mode=semantic")
        ->assertStatus(503);
});

// ── Cited texts: the search reaches what the page's map draws ────────────────

/** A hypercite row on $cited naming $citing (the row lives on the CITED book). */
function jsearchCite(string $cited, string $citing): void
{
    jsearchDb()->table('hypercites')->insert([
        'book' => $cited,
        'hyperciteId' => 'hypercite_' . Str::lower(Str::random(7)),
        'citedIN' => json_encode(['/' . $citing . '#hypercite_' . Str::lower(Str::random(7))]),
        'raw_json' => '{}',
        'created_at' => now(), 'updated_at' => now(),
    ]);
}

function jsearchOutsideBook(string $title, string $visibility = 'public'): string
{
    $book = 'book_jsearch_' . Str::lower(Str::random(8));
    jsearchDb()->table('library')->insert([
        'book' => $book, 'title' => $title, 'author' => 'Marx, Karl',
        'visibility' => $visibility, 'listed' => true, 'has_nodes' => true,
        'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
    ]);

    return $book;
}

function jsearchTextNode(string $book, int $n, string $text): void
{
    jsearchDb()->table('nodes')->insert([
        'book' => $book, 'chunk_id' => 0, 'startLine' => $n,
        'node_id' => $book . '_node_' . $n,
        'content' => '<p>' . $text . '</p>',
        'plainText' => $text,
        'created_at' => now(), 'updated_at' => now(),
    ]);
}

test('every mode reaches a text the shelf CITES and labels it; a text that merely cites the shelf is not reached', function () {
    Cache::flush();
    $s = jsearchSeedShelfWithBooks();
    jsearchDb()->table('nodes')->whereRaw("book LIKE 'book_jsearch_%'")->delete();
    jsearchDb()->table('hypercites')->where('book', 'LIKE', 'book_jsearch_%')->delete();

    $cited = jsearchOutsideBook('JSearch Xylophone Capital');          // a member cites it → in
    $inbound = jsearchOutsideBook('JSearch Xylophone Delinquent');     // it cites a member → out
    $citedPrivate = jsearchOutsideBook('JSearch Xylophone Secret', 'private');
    jsearchCite($cited, $s['match']);
    jsearchCite($citedPrivate, $s['match']);
    jsearchCite($s['match'], $inbound);

    foreach ([$s['match'], $cited, $inbound, $citedPrivate] as $b) {
        jsearchTextNode($b, 1, 'the xylophone economy');
    }

    // Title search.
    $hits = collect($this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=xylophone&mode=library")->assertOk()->json('results'));
    expect($hits->pluck('book')->all())->toContain($s['match'])->toContain($cited)
        ->not->toContain($inbound)->not->toContain($citedPrivate);
    expect($hits->firstWhere('book', $cited)['cited'])->toBeTrue()
        ->and($hits->firstWhere('book', $s['match'])['cited'])->toBeFalse();

    // Full-text search.
    $hits = collect($this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=xylophone")->assertOk()->json('results'));
    expect($hits->pluck('book')->all())->toContain($s['match'])->toContain($cited)
        ->not->toContain($inbound)->not->toContain($citedPrivate);
    expect($hits->firstWhere('book', $cited)['cited'])->toBeTrue()
        ->and($hits->firstWhere('book', $s['match'])['cited'])->toBeFalse();

    // Semantic search.
    jsearchDb()->table('nodes')->whereRaw("book LIKE 'book_jsearch_%'")->delete();
    foreach ([$s['match'], $cited, $inbound, $citedPrivate] as $b) {
        jsearchEmbedNode($b);
    }
    $this->mock(EmbeddingService::class)->shouldReceive('embedSearchQuery')->once()->andReturn(array_fill(0, 768, 0.1));
    $hits = collect($this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=xylophone economics&mode=semantic")->assertOk()->json('results'));
    expect($hits->pluck('book')->all())->toContain($s['match'])->toContain($cited)
        ->not->toContain($inbound)->not->toContain($citedPrivate);
    expect($hits->firstWhere('book', $cited)['cited'])->toBeTrue()
        ->and($hits->firstWhere('book', $s['match'])['cited'])->toBeFalse();

    jsearchDb()->table('hypercites')->where('book', 'LIKE', 'book_jsearch_%')->delete();
});

test('one long book cannot fill the full-text page: the other book still appears, in the limit', function () {
    Cache::flush();
    $s = jsearchSeedShelfWithBooks();
    jsearchDb()->table('nodes')->whereRaw("book LIKE 'book_jsearch_%'")->delete();

    // 'match' is the long book: 30 matching paragraphs. 'other' has one.
    for ($i = 1; $i <= 30; $i++) {
        jsearchTextNode($s['match'], $i, "xylophone paragraph number {$i}");
    }
    jsearchTextNode($s['other'], 1, 'a lone xylophone');

    $res = $this->getJson("/api/public/shelves/{$s['shelfId']}/search?q=xylophone&limit=10")->assertOk();
    $groups = collect($res->json('results'));

    expect($groups->pluck('book')->all())->toContain($s['match'])->toContain($s['other']);
    expect($res->json('count'))->toBe(10);
    // The long book still gets the bulk of the page (backfill), just not all of it.
    expect(count($groups->firstWhere('book', $s['match'])['matches']))->toBe(9)
        ->and(count($groups->firstWhere('book', $s['other'])['matches']))->toBe(1);
});
