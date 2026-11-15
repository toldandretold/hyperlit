<?php

/**
 * Public shelves as title-search results (PublicShelfSearch + the `shelves=1`
 * arm of GET /api/search/library), and the mirror rule: a shelf's synthetic
 * RENDER book (`shelf_{id}_{sort}[_pub]`, titled with the shelf name) is app
 * furniture and is never a search result — the shelf is found as a shelf and
 * linked at its public page.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (afterEach admin deletes
 * deadlock against the open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use App\Services\Shelves\PublicShelfSearch;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function ssrDb()
{
    return DB::connection('pgsql_admin');
}

function ssrCleanup(): void
{
    $db = ssrDb();
    $shelfIds = $db->table('shelves')->where('name', 'LIKE', 'SSR %')->pluck('id');
    $db->table('archive_sources')->whereIn('shelf_id', $shelfIds)->delete();
    $db->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
    $db->table('shelves')->whereIn('id', $shelfIds)->delete();
    $db->table('library')->where('title', 'LIKE', 'SSR %')->delete();
}

beforeEach(fn () => ssrCleanup());
afterAll(fn () => ssrCleanup());

function ssrBook(string $title, array $opts = []): string
{
    $book = $opts['book'] ?? 'book_ssr_' . Str::lower(Str::random(10));
    ssrDb()->table('library')->insert(array_merge([
        'book' => $book, 'title' => $title, 'author' => 'Nobody, Ann',
        'visibility' => 'public', 'listed' => true, 'has_nodes' => true,
        'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
    ], $opts));

    return $book;
}

/** A shelf holding one public readable book unless $books says otherwise. */
function ssrShelf(string $name, array $opts = [], ?array $books = null): string
{
    $id = (string) Str::uuid();
    ssrDb()->table('shelves')->insert(array_merge([
        'id' => $id, 'creator' => 'Ssr Owner', 'name' => $name,
        'slug' => 'ssr-' . Str::lower(Str::random(8)),
        'visibility' => 'public', 'kind' => 'user', 'default_sort' => 'recent',
        'created_at' => now(), 'updated_at' => now(),
    ], $opts));

    foreach ($books ?? [ssrBook('SSR Member ' . Str::random(4), ['listed' => false])] as $book) {
        ssrDb()->table('shelf_items')->insert(['shelf_id' => $id, 'book' => $book, 'added_at' => now()]);
    }

    return $id;
}

test('a public shelf is found by its name and links the owner page shelf deep-link', function () {
    $id = ssrShelf('SSR Zymurgy Readings', ['slug' => 'ssr-zymurgy']);

    $hits = (new PublicShelfSearch())->search('zymurgy read');

    expect($hits)->toHaveCount(1);
    expect($hits[0])->toMatchArray([
        'type' => 'shelf',
        'kind' => 'shelf',
        'shelf_id' => $id,
        'name' => 'SSR Zymurgy Readings',
        'creator' => 'Ssr Owner',
        'count' => 1,
        // Username spaces are stripped in the URL form (UsernameKey::forUrl).
        'url' => '/u/SsrOwner/shelf/ssr-zymurgy',
    ]);
});

test('private, system-kind and unreadable shelves are never results', function () {
    ssrShelf('SSR Zymurgy Private', ['visibility' => 'private']);
    ssrShelf('SSR Zymurgy Likes', ['kind' => 'likes']);
    ssrShelf('SSR Zymurgy Empty', [], []);
    ssrShelf('SSR Zymurgy Only Private Books', [], [ssrBook('SSR Hidden', ['visibility' => 'private'])]);
    ssrShelf('SSR Zymurgy Only Stubs', [], [ssrBook('SSR Stub', ['has_nodes' => false])]);

    expect((new PublicShelfSearch())->search('zymurgy'))->toBe([]);
});

test('every word must match, the owner name counts, and LIKE wildcards are literal', function () {
    ssrShelf('SSR Zymurgy Readings');

    $search = new PublicShelfSearch();
    expect($search->search('zymurgy quokka'))->toBe([]);
    expect($search->search('ssr owner zymurgy'))->toHaveCount(1);
    // "%" must not behave as match-anything.
    expect($search->search('zym%zzz'))->toBe([]);
    expect($search->search('%%'))->toBe([]);
});

test('a shelf backing an archive is named and linked as the archive', function () {
    $id = ssrShelf('SSR Zymurgy Shelf');
    ssrDb()->table('archive_sources')->insert([
        'id' => (string) Str::uuid(), 'shelf_id' => $id,
        'slug' => 'ssr-zymurgy-archive-' . Str::lower(Str::random(5)),
        'display_name' => 'SSR Fermentation Archive',
    ]);
    $slug = ssrDb()->table('archive_sources')->where('shelf_id', $id)->value('slug');

    // Found through the ARCHIVE's display name, not only the shelf's.
    $hits = (new PublicShelfSearch())->search('fermentation');

    expect($hits)->toHaveCount(1);
    expect($hits[0]['kind'])->toBe('archive');
    expect($hits[0]['name'])->toBe('SSR Fermentation Archive');
    expect($hits[0]['url'])->toBe('/a/' . $slug);
});

test('GET /api/search/library adds shelves only when asked, ahead of the books', function () {
    ssrShelf('SSR Zymurgy Readings');
    $book = ssrBook('SSR Zymurgy Handbook');

    $plain = $this->getJson('/api/search/library?q=zymurgy')->assertOk()->json('results');
    expect(array_column($plain, 'book'))->toContain($book);
    expect(array_filter($plain, fn ($r) => ($r['type'] ?? null) === 'shelf'))->toBe([]);

    $with = $this->getJson('/api/search/library?q=zymurgy&shelves=1')->assertOk()->json('results');
    expect($with[0]['type'])->toBe('shelf');
    expect($with[0]['name'])->toBe('SSR Zymurgy Readings');
    expect(array_column($with, 'book'))->toContain($book);
});

test("a shelf's synthetic render book is never a title-search result", function () {
    $id = ssrShelf('SSR Zymurgy Readings');
    $real = ssrBook('SSR Zymurgy Handbook');
    // The render book as ShelfController::renderShelf mints it — given
    // listed + public here so ONLY the synthetic-type rule can keep it out.
    $render = ssrBook('SSR Zymurgy Readings', [
        'book' => "shelf_{$id}_published_pub",
        'raw_json' => json_encode(['type' => 'shelf', 'shelf_id' => $id, 'sort' => 'published']),
    ]);

    $books = array_column(
        $this->getJson('/api/search/library?q=zymurgy&shelves=1')->assertOk()->json('results'),
        'book',
    );

    expect($books)->toContain($real);       // control: the search itself works
    expect($books)->not->toContain($render);
});
