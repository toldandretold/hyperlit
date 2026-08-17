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
