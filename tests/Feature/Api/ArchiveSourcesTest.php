<?php

/**
 * Archives: the archive_sources registry (a public /a/{slug} page over a
 * curated public shelf — docs/web-scrape-import.md).
 *
 * Invariants pinned here:
 *  - /a/{slug} renders the hero page (display name + about copy + shelf feed
 *    tabs) for a public shelf; a private shelf renders "Not yet public" with
 *    no feed buttons; an unknown slug 404s.
 *  - /a lists ONLY certified archives with at least one readable document.
 *  - The homepage lists the same slice (certified AND readable > 0) — the
 *    readable floor self-heals, so neither surface can link an empty archive.
 *  - The console endpoints (GET/POST /api/maintainer/shelf-import/{id}/archive)
 *    are admin-only (403), upsert one record per shelf, refuse a slug that
 *    names another archive, and refuse a shelf that is not public.
 *
 * Seeding via pgsql_admin with beforeEach-only cleanup (afterEach admin deletes
 * deadlock against the open RefreshDatabase transaction).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function archDb()
{
    return DB::connection('pgsql_admin');
}

function archCleanup(): void
{
    archDb()->table('archive_sources')->where('display_name', 'LIKE', 'ArchTest %')->delete();
    $shelfIds = archDb()->table('shelves')->where('name', 'LIKE', 'ArchTest %')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        archDb()->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        archDb()->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
    archDb()->table('library')->where('book', 'LIKE', 'archtest\_%')->delete();
}

beforeEach(fn () => archCleanup());

/** A committed public (or private) shelf with $readable readable public books. */
function archSeedShelf(int $readable = 1, string $visibility = 'public'): string
{
    $shelfId = (string) Str::uuid();
    archDb()->table('shelves')->insert([
        'id' => $shelfId, 'creator' => 'archtest_creator', 'name' => 'ArchTest shelf ' . Str::random(6),
        'slug' => 'archtest-shelf-' . Str::lower(Str::random(6)), 'visibility' => $visibility,
        'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now(),
    ]);

    for ($i = 0; $i < $readable; $i++) {
        $book = 'archtest_' . Str::lower(Str::random(10));
        archDb()->table('library')->insert([
            'book' => $book, 'title' => "ArchTest Doc {$i}", 'visibility' => 'public',
            'has_nodes' => true, 'creator' => 'archtest_creator',
            'timestamp' => round(microtime(true) * 1000), 'raw_json' => '{}',
        ]);
        archDb()->table('shelf_items')->insert([
            'shelf_id' => $shelfId, 'book' => $book, 'added_at' => now(),
        ]);
    }

    return $shelfId;
}

function archSeedArchive(string $shelfId, array $opts = []): object
{
    $row = array_merge([
        'id'           => (string) Str::uuid(),
        'shelf_id'     => $shelfId,
        'slug'         => 'archtest-' . Str::lower(Str::random(8)),
        'display_name' => 'ArchTest Archive',
        'about'        => "ArchTest first paragraph.\n\nArchTest second paragraph.",
        'certified_at' => now(),
        'created_at'   => now(),
        'updated_at'   => now(),
    ], $opts);
    archDb()->table('archive_sources')->insert($row);

    return (object) $row;
}

/* ----------------  /a/{slug}  ---------------- */

test('archive page renders name, about copy and shelf feed tabs for a public shelf', function () {
    $shelfId = archSeedShelf(2);
    $archive = archSeedArchive($shelfId, [
        'about' => "ArchTest first paragraph.\n\nArchTest imported from <a href=\"https://example.org/src\">the source</a>.",
    ]);

    $resp = $this->get('/a/' . $archive->slug);
    $resp->assertStatus(200)
        ->assertSee('ArchTest Archive')
        ->assertSee('ArchTest first paragraph.')
        // About copy renders UNESCAPED — links to the scraped source are the point.
        ->assertSee('<a href="https://example.org/src">the source</a>', false)
        ->assertSee('data-shelf-id="' . $shelfId . '"', false)
        ->assertSee('2 documents readable');

    // Auto-load deferral contract, same as home/journal pages.
    $resp->assertDontSee('arranger-button active', false);
});

test('about copy is sanitized: links survive the save and render, scripts do not', function () {
    $shelfId = archSeedShelf(1);
    $this->loginUser(['is_admin' => true]);

    $this->postJson("/api/maintainer/shelf-import/{$shelfId}/archive", [
        'slug' => 'archtest-xss', 'display_name' => 'ArchTest XSS',
        'about' => 'Docs from <a href="https://example.org/x">here</a>.<script>alert(1)</script>',
    ])->assertStatus(200);

    $stored = (string) DB::table('archive_sources')->where('shelf_id', $shelfId)->value('about');
    expect($stored)->toContain('<a href="https://example.org/x">')
        ->and($stored)->not->toContain('<script');
});

test('archive page over a private shelf says not yet public and offers no feeds', function () {
    $shelfId = archSeedShelf(1, 'private');
    $archive = archSeedArchive($shelfId);

    $this->get('/a/' . $archive->slug)
        ->assertStatus(200)
        ->assertSee('Not yet public')
        ->assertDontSee('data-shelf-id', false);
});

test('unknown archive slug 404s', function () {
    $this->get('/a/archtest-nope')->assertStatus(404);
});

/* ----------------  /a index + homepage list  ---------------- */

test('/a and the homepage list only certified archives holding readable documents', function () {
    $listed = archSeedArchive(archSeedShelf(3), ['display_name' => 'ArchTest Listed']);
    archSeedArchive(archSeedShelf(0), ['display_name' => 'ArchTest Empty']);
    archSeedArchive(archSeedShelf(2), ['display_name' => 'ArchTest Uncertified', 'certified_at' => null]);

    $this->get('/a')->assertStatus(200)
        ->assertSee('ArchTest Listed')
        ->assertDontSee('ArchTest Empty')
        ->assertDontSee('ArchTest Uncertified');

    $this->get('/')->assertStatus(200)
        ->assertSee('/a/' . $listed->slug)
        ->assertSee('ArchTest Listed')
        ->assertDontSee('ArchTest Empty')
        ->assertDontSee('ArchTest Uncertified');
});

/* ----------------  console slug convenience  ---------------- */

test('the console resolves archive and shelf slugs to the shelf uuid, public shelves only', function () {
    $shelfId = archSeedShelf(1);
    $archive = archSeedArchive($shelfId);
    $shelfSlug = archDb()->table('shelves')->where('id', $shelfId)->value('slug');
    $this->loginUser(['is_admin' => true]);

    // Archive slug → redirect to the uuid page.
    $this->get('/maintainer/shelf-import/' . $archive->slug)
        ->assertRedirect("/maintainer/shelf-import/{$shelfId}");

    // The shelf's own slug works too (unique among public shelves here).
    $this->get('/maintainer/shelf-import/' . $shelfSlug)
        ->assertRedirect("/maintainer/shelf-import/{$shelfId}");

    // A private shelf's slug resolves nothing — the console is public-only.
    $privateId = archSeedShelf(0, 'private');
    $privateSlug = archDb()->table('shelves')->where('id', $privateId)->value('slug');
    $this->get('/maintainer/shelf-import/' . $privateSlug)->assertStatus(404);
});

/* ----------------  console endpoints  ---------------- */

test('archive record endpoints are admin-only', function () {
    $shelfId = archSeedShelf(1);
    $this->loginUser();

    $this->getJson("/api/maintainer/shelf-import/{$shelfId}/archive")->assertStatus(403);
    $this->postJson("/api/maintainer/shelf-import/{$shelfId}/archive", [
        'slug' => 'archtest-x', 'display_name' => 'ArchTest X',
    ])->assertStatus(403);
});

test('admin can create, read back and certify an archive record', function () {
    $shelfId = archSeedShelf(1);
    $this->loginUser(['is_admin' => true]);

    $this->getJson("/api/maintainer/shelf-import/{$shelfId}/archive")
        ->assertStatus(200)->assertJson(['archive' => null]);

    $resp = $this->postJson("/api/maintainer/shelf-import/{$shelfId}/archive", [
        'slug' => 'archtest-nam', 'display_name' => 'ArchTest NAM',
        'about' => 'ArchTest copy.', 'certified' => true,
    ]);
    $resp->assertStatus(200)
        ->assertJsonPath('archive.slug', 'archtest-nam')
        ->assertJsonPath('archive.certified', true)
        ->assertJsonPath('archive.public_page', '/a/archtest-nam');

    // Upsert: a second save updates the same record (one per shelf) and
    // un-certifying clears the timestamp.
    $this->postJson("/api/maintainer/shelf-import/{$shelfId}/archive", [
        'slug' => 'archtest-nam', 'display_name' => 'ArchTest NAM 2', 'certified' => false,
    ])->assertStatus(200)->assertJsonPath('archive.certified', false);

    // Default connection: the POST wrote inside the test transaction, which
    // pgsql_admin (a separate connection) cannot see. archive_sources has no
    // RLS, so the plain read works.
    expect(DB::table('archive_sources')->where('shelf_id', $shelfId)->count())->toBe(1)
        ->and(DB::table('archive_sources')->where('shelf_id', $shelfId)->value('display_name'))->toBe('ArchTest NAM 2');
});

test('a slug naming another archive is refused, as is a non-public shelf', function () {
    $taken = archSeedArchive(archSeedShelf(1));
    $shelfId = archSeedShelf(1);
    $privateShelf = archSeedShelf(1, 'private');
    $this->loginUser(['is_admin' => true]);

    $this->postJson("/api/maintainer/shelf-import/{$shelfId}/archive", [
        'slug' => $taken->slug, 'display_name' => 'ArchTest Dup',
    ])->assertStatus(422);

    $this->postJson("/api/maintainer/shelf-import/{$privateShelf}/archive", [
        'slug' => 'archtest-priv', 'display_name' => 'ArchTest Priv',
    ])->assertStatus(404);

    $this->postJson("/api/maintainer/shelf-import/{$shelfId}/archive", [
        'slug' => 'Bad Slug!', 'display_name' => 'ArchTest Bad',
    ])->assertStatus(422);
});
