<?php

/**
 * Owner-minted archives: a user's own PUBLIC shelf at a global /a/{slug}
 * (ShelfController::archiveStatus/createArchive → ShelfArchiveMinter).
 *
 * Invariants pinned here:
 *  - The suggestion is the shelf's slug, then {slug}-{username} when another
 *    archive holds it; the live check reports free/taken/invalid.
 *  - The slug is SET ONCE (like a book slug): a second POST with a different
 *    slug returns the original unchanged, one row.
 *  - Owner-only (404 otherwise), public-only (422), taken slug → 422 + a fresh
 *    suggestion.
 *  - The page borrows the shelf's LIVE name (a rename shows up, the URL holds).
 *  - An owner-minted archive is never certified → never on the homepage list.
 *  - Deleting the shelf deletes its archive row (no FK).
 *  - The archive panel corpus is the shelf's public books, cited to its owner.
 *
 * Shelves/library/committed archives seeded via pgsql_admin with beforeEach
 * cleanup (afterEach admin deletes deadlock against RefreshDatabase); rows the
 * ENDPOINT mints ride the test transaction and roll back.
 */

use App\Services\Archives\CertifiedArchivesQuery;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function shArchDb()
{
    return DB::connection('pgsql_admin');
}

function shArchCleanup(): void
{
    shArchDb()->table('archive_sources')->where('slug', 'LIKE', 'sharch-%')->delete();
    $shelfIds = shArchDb()->table('shelves')->where('name', 'LIKE', 'ShArch %')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        shArchDb()->table('archive_sources')->whereIn('shelf_id', $shelfIds)->delete();
        shArchDb()->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        shArchDb()->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
    shArchDb()->table('library')->where('book', 'LIKE', 'sharch\_%')->delete();
    if ($shelfIds->isNotEmpty()) {
        $aboutBooks = $shelfIds->map(fn ($id) => \App\Services\Archives\ArchiveAboutBook::bookId($id))->all();
        shArchDb()->table('nodes')->whereIn('book', $aboutBooks)->delete();
        shArchDb()->table('book_images')->whereIn('book', $aboutBooks)->delete();
        shArchDb()->table('library')->whereIn('book', $aboutBooks)->delete();
    }
}

beforeEach(fn () => shArchCleanup());
afterEach(fn () => $this->cleanupApiFixtures());

/** @return object{id: string, slug: string, name: string} */
function shArchShelf(string $creator, string $visibility = 'public', int $books = 1): object
{
    $id = (string) Str::uuid();
    $suffix = Str::lower(Str::random(6));
    $row = (object) ['id' => $id, 'slug' => 'sharch-shelf-' . $suffix, 'name' => 'ShArch Shelf ' . $suffix];
    shArchDb()->table('shelves')->insert([
        'id' => $id, 'creator' => $creator, 'name' => $row->name, 'slug' => $row->slug,
        'description' => 'ShArch about this shelf.', 'visibility' => $visibility,
        'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now(),
    ]);
    for ($i = 0; $i < $books; $i++) {
        $book = 'sharch_' . Str::lower(Str::random(10));
        shArchDb()->table('library')->insert([
            'book' => $book, 'title' => "ShArch Doc {$i}", 'visibility' => 'public',
            'has_nodes' => true, 'creator' => $creator,
            'timestamp' => round(microtime(true) * 1000), 'raw_json' => '{}',
        ]);
        shArchDb()->table('shelf_items')->insert(['shelf_id' => $id, 'book' => $book, 'added_at' => now()]);
    }

    return $row;
}

test('status suggests the shelf slug and live-checks availability', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);

    $this->getJson("/api/shelves/{$shelf->id}/archive")
        ->assertOk()
        ->assertJson(['exists' => false, 'suggestion' => $shelf->slug]);

    $this->getJson("/api/shelves/{$shelf->id}/archive?slug=sharch-free-" . Str::lower(Str::random(5)))
        ->assertOk()->assertJson(['valid' => true, 'available' => true]);

    $this->getJson("/api/shelves/{$shelf->id}/archive?slug=Not--Valid")
        ->assertOk()->assertJson(['valid' => false, 'available' => false]);
});

test('a taken shelf slug suggests {slug}-{username}', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);
    $other = shArchShelf('sharch_someone_else');
    shArchDb()->table('archive_sources')->insert([
        'shelf_id' => $other->id, 'slug' => $shelf->slug, 'display_name' => null,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $expected = $shelf->slug . '-' . Str::slug(\App\Support\UsernameKey::for($user->name));
    $this->getJson("/api/shelves/{$shelf->id}/archive")
        ->assertOk()->assertJson(['exists' => false, 'suggestion' => $expected]);

    $this->getJson("/api/shelves/{$shelf->id}/archive?slug={$shelf->slug}")
        ->assertOk()->assertJson(['available' => false]);

    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $shelf->slug])
        ->assertStatus(422)->assertJson(['suggestion' => $expected]);
});

test('mint is set-once: a second POST with another slug returns the original', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);
    $slug = 'sharch-mine-' . Str::lower(Str::random(5));

    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $slug])
        ->assertOk()->assertJson(['slug' => $slug, 'url' => "/a/{$slug}", 'created' => true]);

    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $slug . '-changed'])
        ->assertOk()->assertJson(['slug' => $slug, 'created' => false]);

    $this->getJson("/api/shelves/{$shelf->id}/archive")
        ->assertOk()->assertJson(['exists' => true, 'slug' => $slug]);

    expect(DB::table('archive_sources')->where('shelf_id', $shelf->id)->count())->toBe(1);
    $row = DB::table('archive_sources')->where('shelf_id', $shelf->id)->first();
    expect($row->display_name)->toBeNull()
        ->and($row->certified_at)->toBeNull();
});

test('only the owner of a PUBLIC shelf can make an archive', function () {
    $owner = $this->apiUser();
    $public = shArchShelf($owner->name);
    $private = shArchShelf($owner->name, 'private');

    // Someone else → 404 (no existence leak)
    $this->loginUser();
    $this->assertApiError($this->getJson("/api/shelves/{$public->id}/archive"), 404);
    $this->assertApiError($this->postJson("/api/shelves/{$public->id}/archive", ['slug' => 'sharch-x']), 404);

    // Owner, private shelf → 422
    $this->actingAs($owner);
    $this->assertApiError($this->getJson("/api/shelves/{$private->id}/archive"), 422);
    $this->assertApiError($this->postJson("/api/shelves/{$private->id}/archive", ['slug' => 'sharch-y']), 422);
});

test('an invalid slug is refused with a suggestion', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);

    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => 'Bad Slug!'])
        ->assertStatus(422)->assertJson(['suggestion' => $shelf->slug]);
});

test('the archive page shows the shelf\'s live name and description', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);
    $slug = 'sharch-page-' . Str::lower(Str::random(5));
    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $slug])->assertOk();

    $this->get("/a/{$slug}")
        ->assertOk()
        ->assertSee($shelf->name)
        ->assertSee('ShArch about this shelf.')
        ->assertSee('data-shelf-id="' . $shelf->id . '"', false);

    shArchDb()->table('shelves')->where('id', $shelf->id)->update(['name' => 'ShArch Renamed Shelf']);

    $this->get("/a/{$slug}")->assertOk()->assertSee('ShArch Renamed Shelf');
});

test('an owner-minted archive is never listed on the homepage', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name, 'public', 2);
    $slug = 'sharch-uncert-' . Str::lower(Str::random(5));
    // Committed (admin) so the cached homepage query can see it if it were eligible.
    shArchDb()->table('archive_sources')->insert([
        'shelf_id' => $shelf->id, 'slug' => $slug, 'display_name' => null,
        'certified_at' => null, 'created_at' => now(), 'updated_at' => now(),
    ]);
    Cache::forget(CertifiedArchivesQuery::CACHE_KEY);

    $slugs = array_column(app(CertifiedArchivesQuery::class)->forHomepage(), 'slug');
    expect($slugs)->not->toContain($slug);

    // …and once a maintainer certifies it, it lists under the shelf's name.
    shArchDb()->table('archive_sources')->where('slug', $slug)->update(['certified_at' => now()]);
    Cache::forget(CertifiedArchivesQuery::CACHE_KEY);
    $listed = collect(app(CertifiedArchivesQuery::class)->forHomepage())->firstWhere('slug', $slug);
    expect($listed['display_name'] ?? null)->toBe($shelf->name);
    Cache::forget(CertifiedArchivesQuery::CACHE_KEY);
});

test('the archive panel corpus is the shelf\'s public books, cited to the owner', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name, 'public', 2);
    $slug = 'sharch-panel-' . Str::lower(Str::random(5));
    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $slug])->assertOk();

    $corpus = app(\App\Services\Export\ArchiveCorpusResolver::class)->resolve('archive', $slug, false);
    expect($corpus)->not->toBeNull()
        ->and($corpus->displayName)->toBe($shelf->name)
        ->and(count($corpus->books))->toBe(2)
        ->and($corpus->citeAuthor)->toBe($user->name);
});

test('deleting the shelf deletes its archive', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);
    $slug = 'sharch-del-' . Str::lower(Str::random(5));
    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $slug])->assertOk();

    $this->deleteJson("/api/shelves/{$shelf->id}")->assertOk();

    expect(DB::table('archive_sources')->where('slug', $slug)->exists())->toBeFalse();
    $this->get("/a/{$slug}")->assertNotFound();
});

test('the licence-review shelf can never become an archive, even if made public', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);
    shArchDb()->table('shelves')->where('id', $shelf->id)->update(['kind' => 'licence_review']);

    $this->assertApiError($this->getJson("/api/shelves/{$shelf->id}/archive"), 422);
    $this->assertApiError($this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => 'sharch-lr']), 422);
});

test('only the shelf owner gets the archive page edit button', function () {
    $owner = $this->apiUser();
    $shelf = shArchShelf($owner->name);
    $slug = 'sharch-edit-' . Str::lower(Str::random(5));
    shArchDb()->table('archive_sources')->insert([
        'shelf_id' => $shelf->id, 'slug' => $slug, 'display_name' => null,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->actingAs($owner);
    $this->get("/a/{$slug}")->assertOk()
        ->assertSee('data-archive-edit=', false)
        ->assertSee('id="editButton"', false);

    $this->loginUser();
    $this->get("/a/{$slug}")->assertOk()->assertDontSee('data-archive-edit=', false);

    auth()->logout();
    $this->get("/a/{$slug}")->assertOk()->assertDontSee('data-archive-edit=', false);
});

test('a maintainer archive never shows the owner edit button', function () {
    $owner = $this->loginUser();
    $shelf = shArchShelf($owner->name);
    $slug = 'sharch-maint-' . Str::lower(Str::random(5));
    shArchDb()->table('archive_sources')->insert([
        'shelf_id' => $shelf->id, 'slug' => $slug, 'display_name' => 'ShArch Maintained',
        'about' => '<a href="https://example.org">Source</a>', 'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->get("/a/{$slug}")->assertOk()
        ->assertDontSee('data-archive-edit=', false)
        ->assertSee('<a href="https://example.org">Source</a>', false); // maintainer copy keeps its links
});

test('an owner-minted about is plain text: escaped, and paragraphs split on blank lines', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);
    shArchDb()->table('shelves')->where('id', $shelf->id)
        ->update(['description' => "First <b>bold?</b> para.\n\nSecond para."]);
    $slug = 'sharch-plain-' . Str::lower(Str::random(5));
    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $slug])->assertOk();

    // Owner visit mints the About book from the description: escaped paragraphs.
    $this->get("/a/{$slug}")->assertOk()
        ->assertSee('First &lt;b&gt;bold?&lt;/b&gt; para.', false)
        ->assertDontSee('<b>bold?</b>', false)
        ->assertSee('>Second para.</p>', false);
});

test('the owner can rename the shelf and clear its description', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);
    $slug = 'sharch-ren-' . Str::lower(Str::random(5));
    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $slug])->assertOk();

    $this->patchJson("/api/shelves/{$shelf->id}", ['name' => 'ShArch Edited Title', 'description' => ''])->assertOk();

    $row = shArchDb()->table('shelves')->where('id', $shelf->id)->first();
    expect($row->name)->toBe('ShArch Edited Title')->and($row->description)->toBeNull();

    $this->get("/a/{$slug}")->assertOk()->assertSee('ShArch Edited Title');

    // A PATCH that doesn't mention description leaves it alone.
    shArchDb()->table('shelves')->where('id', $shelf->id)->update(['description' => 'ShArch kept.']);
    $this->patchJson("/api/shelves/{$shelf->id}", ['name' => 'ShArch Edited Again'])->assertOk();
    expect(shArchDb()->table('shelves')->where('id', $shelf->id)->value('description'))->toBe('ShArch kept.');
});

test('the owner\'s visit mints a real About book seeded from the description', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);
    $slug = 'sharch-book-' . Str::lower(Str::random(5));
    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $slug])->assertOk();
    $bookId = \App\Services\Archives\ArchiveAboutBook::bookId($shelf->id);

    $this->get("/a/{$slug}")->assertOk()
        ->assertSee('id="archive-about-book"', false)
        ->assertSee('data-book-id="' . $bookId . '"', false)
        ->assertSee('id="edit-toolbar"', false)
        ->assertSee('ShArch about this shelf.');

    $lib = shArchDb()->table('library')->where('book', $bookId)->first();
    expect($lib)->not->toBeNull()
        ->and($lib->creator)->toBe($user->name)
        ->and($lib->visibility)->toBe('public')
        ->and((bool) $lib->listed)->toBeFalse();
    $nodes = shArchDb()->table('nodes')->where('book', $bookId)->get();
    expect($nodes)->toHaveCount(1)
        ->and($nodes[0]->content)->toBe('<p>ShArch about this shelf.</p>');

    // Idempotent: a second visit doesn't re-seed.
    $this->get("/a/{$slug}")->assertOk();
    expect(shArchDb()->table('nodes')->where('book', $bookId)->count())->toBe(1);

    // Not a work: stays out of the archive corpus (and every shelf_% exclusion).
    $corpus = app(\App\Services\Export\ArchiveCorpusResolver::class)->resolve('archive', $slug, false);
    expect(collect($corpus->books)->pluck('book')->all())->not->toContain($bookId);
});

test('visitors see the About book only once it says something', function () {
    $owner = $this->apiUser();
    $shelf = shArchShelf($owner->name);
    shArchDb()->table('shelves')->where('id', $shelf->id)->update(['description' => null]);
    $slug = 'sharch-vis-' . Str::lower(Str::random(5));
    shArchDb()->table('archive_sources')->insert([
        'shelf_id' => $shelf->id, 'slug' => $slug, 'display_name' => null,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $this->actingAs($owner);
    $this->get("/a/{$slug}")->assertOk()->assertSee('id="archive-about-book"', false); // minted, empty
    $bookId = \App\Services\Archives\ArchiveAboutBook::bookId($shelf->id);

    auth()->logout();
    $this->get("/a/{$slug}")->assertOk()
        ->assertDontSee('id="archive-about-book"', false)
        ->assertSee('a hypertext archive on Hyperlit');

    shArchDb()->table('nodes')->where('book', $bookId)->update(['content' => '<h1>ShArch Rich About</h1>']);
    $this->get("/a/{$slug}")->assertOk()
        ->assertSee('id="archive-about-book"', false)
        ->assertSee('ShArch Rich About')
        ->assertDontSee('id="edit-toolbar"', false);
});

test('a private shelf\'s archive never mints an About book', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name, 'private');
    $slug = 'sharch-priv-' . Str::lower(Str::random(5));
    shArchDb()->table('archive_sources')->insert([
        'shelf_id' => $shelf->id, 'slug' => $slug, 'display_name' => null,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $this->get("/a/{$slug}")->assertOk()->assertDontSee('id="archive-about-book"', false);
    expect(shArchDb()->table('library')->where('book', \App\Services\Archives\ArchiveAboutBook::bookId($shelf->id))->exists())->toBeFalse();
});

test('deleting the shelf deletes its About book', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);
    $slug = 'sharch-delbook-' . Str::lower(Str::random(5));
    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $slug])->assertOk();
    $this->get("/a/{$slug}")->assertOk();
    $bookId = \App\Services\Archives\ArchiveAboutBook::bookId($shelf->id);
    expect(shArchDb()->table('library')->where('book', $bookId)->exists())->toBeTrue();

    $this->deleteJson("/api/shelves/{$shelf->id}")->assertOk();
    expect(shArchDb()->table('library')->where('book', $bookId)->exists())->toBeFalse()
        ->and(shArchDb()->table('nodes')->where('book', $bookId)->exists())->toBeFalse();
});

test('the archive page is customized like a user page: logo, background, art — stored on the About book', function () {
    $user = $this->loginUser();
    $shelf = shArchShelf($user->name);
    $slug = 'sharch-cust-' . Str::lower(Str::random(5));
    $this->postJson("/api/shelves/{$shelf->id}/archive", ['slug' => $slug])->assertOk();
    $this->get("/a/{$slug}")->assertOk()->assertSee('archive-hero', false); // mints the About book
    $bookId = \App\Services\Archives\ArchiveAboutBook::bookId($shelf->id);
    shArchDb()->table('book_images')->insert([
        ['book' => $bookId, 'filename' => 'logo.png', 'mime' => 'image/png', 'bytes' => 10],
        ['book' => $bookId, 'filename' => 'bg.png', 'mime' => 'image/png', 'bytes' => 10],
    ]);

    $this->putJson("/api/shelves/{$shelf->id}/archive/page-settings", [
        'logo_image' => 'logo.png', 'background_image' => 'bg.png', 'background_art' => 'none',
        'show_map' => false, 'pill_shelves' => [],
    ])->assertOk()->assertJsonPath('page_settings.logo_image', 'logo.png');

    $stored = json_decode(shArchDb()->table('library')->where('book', $bookId)->value('page_settings'), true);
    expect($stored)->toMatchArray(['logo_image' => 'logo.png', 'background_image' => 'bg.png', 'background_art' => 'none', 'show_map' => false])
        ->and($stored)->not->toHaveKey('pill_shelves');

    // Visitor view (the API request left Sanctum's guard active — reset all).
    $this->app['auth']->forgetGuards();
    $this->get("/a/{$slug}")->assertOk()
        ->assertSee('<img class="journal-colon user-page-logo" src="/' . $bookId . '/media/logo.png"', false)
        ->assertSee("/{$bookId}/media/bg.png", false)
        ->assertSee('bg-art-none', false)
        ->assertDontSee('class="journal-hypercite-map"', false);
});

test('archive page settings: owner only, images must belong to the archive, maintainer archives refused', function () {
    $owner = $this->apiUser();
    $shelf = shArchShelf($owner->name);
    $slug = 'sharch-cust2-' . Str::lower(Str::random(5));
    shArchDb()->table('archive_sources')->insert([
        'shelf_id' => $shelf->id, 'slug' => $slug, 'display_name' => null,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->loginUser();
    $this->assertApiError($this->putJson("/api/shelves/{$shelf->id}/archive/page-settings", ['background_art' => 'none']), 404);

    $this->actingAs($owner);
    $this->putJson("/api/shelves/{$shelf->id}/archive/page-settings", ['logo_image' => 'not-mine.png'])->assertStatus(422);
    $this->putJson("/api/shelves/{$shelf->id}/archive/page-settings", ['background_art' => 'none'])->assertOk();

    // A maintainer archive's look is the console's business, not this endpoint's.
    $other = shArchShelf($owner->name);
    shArchDb()->table('archive_sources')->insert([
        'shelf_id' => $other->id, 'slug' => 'sharch-maint2-' . Str::lower(Str::random(5)), 'display_name' => 'ShArch Maintained 2',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $this->assertApiError($this->putJson("/api/shelves/{$other->id}/archive/page-settings", ['background_art' => 'none']), 404);
});
