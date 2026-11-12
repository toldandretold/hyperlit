<?php

/**
 * A shelf's OVERVIEW book (shelves.overview_book; App\Services\Shelves\ShelfOverview)
 * — the member the owner pins as the shelf's intro / readme.
 *
 * Invariants pinned here:
 *  - only a book ON the shelf can be nominated (422 otherwise); null clears;
 *    owner only.
 *  - the overview leads EVERY render — owner and public, whatever the sort —
 *    and its card carries the pin (libraryCard-overview).
 *  - a private overview is not pinned for visitors (no locked card up top).
 *  - taking the book off the shelf un-nominates it.
 *  - the shelf's archive page leaves the overview out of the document count
 *    always, but shows it as the page's ABOUT only when the owner opts in
 *    (page setting overview_as_about, default off — the page's own editable
 *    about stands otherwise, and comes back when the option is turned off).
 *
 * (The vault hub note is pinned in tests/Feature/ArchiveExport/ArchiveExportTest.php.)
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function shOvDb()
{
    return DB::connection('pgsql_admin');
}

function shOvCleanup(): void
{
    $ids = shOvDb()->table('shelves')->where('name', 'LIKE', 'ShOv %')->pluck('id');
    foreach ($ids as $id) {
        shOvDb()->table('nodes')->where('book', 'LIKE', 'shelf_' . $id . '_%')->delete();
        shOvDb()->table('library')->where('book', 'LIKE', 'shelf_' . $id . '_%')->delete();
        shOvDb()->table('nodes')->where('book', 'shelf_about_' . $id)->delete();
        shOvDb()->table('library')->where('book', 'shelf_about_' . $id)->delete();
    }
    if ($ids->isNotEmpty()) {
        shOvDb()->table('archive_sources')->whereIn('shelf_id', $ids)->delete();
        shOvDb()->table('shelf_items')->whereIn('shelf_id', $ids)->delete();
        shOvDb()->table('shelves')->whereIn('id', $ids)->delete();
    }
    shOvDb()->table('nodes')->where('book', 'LIKE', 'shov\_%')->delete();
    shOvDb()->table('library')->where('book', 'LIKE', 'shov\_%')->delete();
}

beforeEach(fn () => shOvCleanup());
afterEach(fn () => $this->cleanupApiFixtures());

function shOvBook(string $creator, string $title, string $visibility = 'public'): string
{
    $book = 'shov_' . Str::lower(Str::random(10));
    shOvDb()->table('library')->insert([
        'book' => $book, 'title' => $title, 'visibility' => $visibility, 'has_nodes' => true,
        'creator' => $creator, 'timestamp' => round(microtime(true) * 1000), 'raw_json' => '{}',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    shOvDb()->table('nodes')->insert([
        'book' => $book, 'node_id' => $book . '_n1', 'chunk_id' => 0, 'startLine' => 100,
        'content' => '<p id="100" data-node-id="' . $book . '_n1">Body of ' . e($title) . '.</p>',
        'plainText' => 'Body of ' . $title . '.', 'type' => 'p', 'created_at' => now(), 'updated_at' => now(),
    ]);

    return $book;
}

/** @return array{0: string, 1: string[]} [shelfId, books] */
function shOvShelf(string $creator, array $books): string
{
    $id = (string) Str::uuid();
    shOvDb()->table('shelves')->insert([
        'id' => $id, 'creator' => $creator, 'name' => 'ShOv Shelf ' . Str::lower(Str::random(5)),
        'slug' => 'shov-' . Str::lower(Str::random(6)), 'visibility' => 'public', 'default_sort' => 'title',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    foreach ($books as $book) {
        shOvDb()->table('shelf_items')->insert(['shelf_id' => $id, 'book' => $book, 'added_at' => now()]);
    }

    return $id;
}

function shOvCards(string $syntheticBook): array
{
    return shOvDb()->table('nodes')->where('book', $syntheticBook)->orderBy('startLine')->pluck('content')->all();
}

test('only a book on the shelf can be nominated; null clears; owner only', function () {
    $owner = $this->loginUser();
    $a = shOvBook($owner->name, 'ShOv Alpha');
    $stranger = shOvBook($owner->name, 'ShOv Not On Shelf');
    $shelf = shOvShelf($owner->name, [$a]);

    $this->patchJson("/api/shelves/{$shelf}", ['overview_book' => $stranger])->assertStatus(422);
    expect(shOvDb()->table('shelves')->where('id', $shelf)->value('overview_book'))->toBeNull();

    $this->patchJson("/api/shelves/{$shelf}", ['overview_book' => $a])->assertOk();
    expect(shOvDb()->table('shelves')->where('id', $shelf)->value('overview_book'))->toBe($a);

    // An unrelated PATCH leaves it alone; an explicit null clears it.
    $this->patchJson("/api/shelves/{$shelf}", ['default_sort' => 'recent'])->assertOk();
    expect(shOvDb()->table('shelves')->where('id', $shelf)->value('overview_book'))->toBe($a);
    $this->patchJson("/api/shelves/{$shelf}", ['overview_book' => null])->assertOk();
    expect(shOvDb()->table('shelves')->where('id', $shelf)->value('overview_book'))->toBeNull();

    $this->loginUser();
    $this->assertApiError($this->patchJson("/api/shelves/{$shelf}", ['overview_book' => $a]), 404);
});

test('the overview leads every render with a pin — owner and public', function () {
    $owner = $this->loginUser();
    $a = shOvBook($owner->name, 'ShOv Alpha');
    $z = shOvBook($owner->name, 'ShOv Zulu Course Intro');
    $shelf = shOvShelf($owner->name, [$a, $z]);

    // Title sort, no overview: Alpha first, no pin anywhere.
    $bookId = $this->getJson("/api/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId');
    $cards = shOvCards($bookId);
    expect($cards[0])->toContain('ShOv Alpha')->and(implode('', $cards))->not->toContain('libraryCard-overview');

    $this->patchJson("/api/shelves/{$shelf}", ['overview_book' => $z])->assertOk();

    $cards = shOvCards($this->getJson("/api/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId'));
    expect($cards)->toHaveCount(2)
        ->and($cards[0])->toContain('ShOv Zulu Course Intro')->toContain('libraryCard-overview')->toContain('pin-icon')
        ->and($cards[1])->toContain('ShOv Alpha')->not->toContain('libraryCard-overview');

    $this->app['auth']->forgetGuards();
    $cards = shOvCards($this->getJson("/api/public/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId'));
    expect($cards[0])->toContain('ShOv Zulu Course Intro')->toContain('libraryCard-overview');
});

test('a private overview is not pinned for visitors', function () {
    $owner = $this->apiUser();
    $a = shOvBook($owner->name, 'ShOv Alpha');
    $z = shOvBook($owner->name, 'ShOv Zulu Private Intro', 'private');
    $shelf = shOvShelf($owner->name, [$a, $z]);
    shOvDb()->table('shelves')->where('id', $shelf)->update(['overview_book' => $z]);

    $cards = shOvCards($this->getJson("/api/public/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId'));
    expect($cards[0])->toContain('ShOv Alpha')
        ->and(implode('', $cards))->not->toContain('libraryCard-overview');
});

test('taking the book off the shelf un-nominates it', function () {
    $owner = $this->loginUser();
    $a = shOvBook($owner->name, 'ShOv Alpha');
    $shelf = shOvShelf($owner->name, [$a]);
    shOvDb()->table('shelves')->where('id', $shelf)->update(['overview_book' => $a]);

    $this->deleteJson("/api/shelves/{$shelf}/items/{$a}")->assertOk();
    expect(shOvDb()->table('shelves')->where('id', $shelf)->value('overview_book'))->toBeNull();
});

test('the archive page shows the overview as its about only when the owner opts in', function () {
    $owner = $this->apiUser();
    $a = shOvBook($owner->name, 'ShOv Alpha');
    $b = shOvBook($owner->name, 'ShOv Beta');
    $intro = shOvBook($owner->name, 'ShOv Course Intro');
    $shelf = shOvShelf($owner->name, [$a, $b, $intro]);
    shOvDb()->table('shelves')->where('id', $shelf)->update(['overview_book' => $intro, 'description' => 'ShOv plain description.']);
    $slug = 'shov-arch-' . Str::lower(Str::random(5));
    shOvDb()->table('archive_sources')->insert([
        'shelf_id' => $shelf, 'slug' => $slug, 'display_name' => null, 'created_at' => now(), 'updated_at' => now(),
    ]);

    // Default: the page's own about stands (seeded from the description on
    // the owner's first visit); the overview is still not a "document".
    $this->actingAs($owner)->get("/a/{$slug}")->assertOk()
        ->assertDontSee('id="archive-overview-book"', false)
        ->assertSee('id="archive-about-book"', false)
        ->assertSee('ShOv plain description.')
        ->assertSee('2 documents readable on Hyperlit.');

    $this->putJson("/api/shelves/{$shelf}/archive/page-settings", ['overview_as_about' => 'yes'])->assertStatus(422);
    $this->putJson("/api/shelves/{$shelf}/archive/page-settings", ['overview_as_about' => true])
        ->assertOk()->assertJsonPath('page_settings.overview_as_about', true);

    $this->get("/a/{$slug}")->assertOk()
        ->assertSee('id="archive-overview-book"', false)
        ->assertSee('<p>Body of ShOv Course Intro.</p>', false) // block ids stripped from the excerpt
        ->assertSee('href="/' . $intro . '"', false)
        ->assertSee('2 documents readable on Hyperlit.')
        ->assertDontSee('ShOv plain description.');

    // Off again: the key is cleared and the page's own about is back.
    $this->putJson("/api/shelves/{$shelf}/archive/page-settings", ['overview_as_about' => false])
        ->assertOk()->assertJsonMissingPath('page_settings.overview_as_about');
    $this->get("/a/{$slug}")->assertOk()
        ->assertDontSee('id="archive-overview-book"', false)
        ->assertSee('ShOv plain description.');
});

test('markPinned adds one class and one leading pin to a finished card', function () {
    $generator = new \App\Services\LibraryCardGenerator();
    $record = (object) ['book' => 'shov_card', 'title' => 'ShOv Card', 'author' => 'A. Author', 'year' => '2020',
        'publisher' => null, 'journal' => null, 'bibtex' => null, 'volume' => null, 'issue' => null];
    $chunk = $generator->generateLibraryCardChunk($record, 'most-recent', 1, false, false, 0);

    $pinned = $generator->markPinned($chunk);
    expect($pinned['content'])->toContain('class="libraryCard libraryCard-pinned')
        ->toContain('<span class="pin-icon" title="Pinned"')
        ->and(substr_count($pinned['content'], 'pin-icon'))->toBe(1)
        ->and(strpos($pinned['content'], 'pin-icon'))->toBeLessThan(strpos($pinned['content'], 'card-citation'));

    // The unmarked chunk is untouched, and the shelf variant names itself.
    expect($chunk['content'])->not->toContain('pin-icon')
        ->and($generator->markAsOverview($chunk)['content'])->toContain('libraryCard-overview')->toContain('title="Shelf overview"');
});

test("the owner's user page hands the client each shelf's kind", function () {
    // shelfHeader marks only a kind 'user' shelf as overview-pinnable and as a
    // file-drop target; the page's shelf list once omitted `kind`, so neither
    // ever appeared on the shelf while every server test stayed green.
    $owner = $this->apiUser();
    $shelf = shOvShelf($owner->name, [shOvBook($owner->name, 'ShOv Alpha')]);

    $html = $this->actingAs($owner)->get(\App\Support\UsernameKey::profileUrl($owner->name))->assertOk()->getContent();

    expect(preg_match('/window\.userShelves = (\[.*?\]);/s', $html, $m))->toBe(1);
    $mine = collect(json_decode($m[1], true))->firstWhere('id', $shelf);
    expect($mine)->not->toBeNull()
        ->and($mine['kind'])->toBe('user')
        ->and(array_key_exists('overview_book', $mine))->toBeTrue();
});

test("the archive panel offers the plus to the shelf's creator only, naming the shelf a new book joins", function () {
    $owner = $this->apiUser();
    $shelf = shOvShelf($owner->name, [shOvBook($owner->name, 'ShOv Alpha')]);
    $slug = 'shov-arch-' . Str::lower(Str::random(5));
    shOvDb()->table('archive_sources')->insert([
        'shelf_id' => $shelf, 'slug' => $slug, 'display_name' => null, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->getJson("/api/archive-export/archive/{$slug}/panel")->assertOk()
        ->assertJsonPath('canAdd', false)->assertJsonPath('addShelfId', null);
    $this->actingAs($owner)->getJson("/api/archive-export/archive/{$slug}/panel")->assertOk()
        ->assertJsonPath('canAdd', true)->assertJsonPath('addShelfId', $shelf);
});

test('the shelf list says where each shelf opens: its public archive page, else the shelf on the user page', function () {
    $owner = $this->apiUser();
    $withArchive = shOvShelf($owner->name, []);
    $plain = shOvShelf($owner->name, []);
    $privateWithArchive = shOvShelf($owner->name, []);
    shOvDb()->table('shelves')->where('id', $privateWithArchive)->update(['visibility' => 'private']);
    $slug = 'shov-arch-' . Str::lower(Str::random(5));
    foreach ([[$withArchive, $slug], [$privateWithArchive, $slug . '-p']] as [$id, $s]) {
        shOvDb()->table('archive_sources')->insert([
            'shelf_id' => $id, 'slug' => $s, 'display_name' => null, 'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    $urls = collect($this->actingAs($owner)->getJson('/api/shelves')->assertOk()->json('shelves'))->pluck('url', 'id');
    $shelfUrl = fn ($id) => \App\Support\UsernameKey::shelfUrl($owner->name, shOvDb()->table('shelves')->where('id', $id)->value('slug'));

    expect($urls[$withArchive])->toBe(url('/a/' . $slug))
        ->and($urls[$plain])->toBe($shelfUrl($plain))
        ->and($urls[$privateWithArchive])->toBe($shelfUrl($privateWithArchive)); // its /a/ page shows nothing while private
});
