<?php

/**
 * /u/{username} hero-page invariants (server side) — the user-page analogue of
 * HomeSeoTest, guarding the deferred-load design user.blade.php adopted from
 * the homepage:
 *  - lava scaffolding intact (#app-container.lava-lamp-background +
 *    #lava-lamp-mount sibling, data-page="user")
 *  - plain /u/{name}: NO server-side .main-content and NO pre-activated
 *    arranger tab (either re-enables homepageDisplayUnit's auto-load; the
 *    hero boots instead, client-side restore handles returning users)
 *  - a shelf deep link (/u/{name}/shelf/{slug}) is the exception: its tab
 *    renders active so the feed loads
 *  - the crawlable body is the .welcome-copy user-about section
 *  - the hero search box + archivist wiring exist (user-* ids,
 *    #hyperlit-container for answer renders)
 *  - visitors never get the owner chrome (pencil, data-library-record)
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function upseoAdminConn()
{
    return DB::connection('pgsql_admin');
}

function makeUpseoUser(): User
{
    $unique = 'upseo_' . Str::random(8);
    $id = upseoAdminConn()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@upseotest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'budget',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

beforeEach(function () {
    upseoAdminConn()->table('shelves')->whereRaw("creator IN (SELECT name FROM users WHERE email LIKE '%@upseotest.test')")->delete();
    upseoAdminConn()->table('nodes')->whereRaw("book IN (SELECT book FROM library WHERE creator IN (SELECT name FROM users WHERE email LIKE '%@upseotest.test'))")->delete();
    upseoAdminConn()->table('library')->whereRaw("creator IN (SELECT name FROM users WHERE email LIKE '%@upseotest.test')")->delete();
    upseoAdminConn()->table('users')->whereRaw("email LIKE '%@upseotest.test'")->delete();
});

test('user page renders the deferred lava hero with no server-side main-content', function () {
    $user = makeUpseoUser();

    $html = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();

    expect($html)->toContain('data-page="user"');
    expect($html)->toContain('id="app-container" class="lava-lamp-background"');
    expect($html)->toContain('id="lava-lamp-mount"');

    // THE deferred-load guard (mirrors HomeSeoTest)
    expect($html)->not->toContain('class="main-content');
    expect($html)->not->toContain('arranger-button active');

    // crawlable about copy with a non-empty h1
    expect($html)->toContain('welcome-copy user-about');
    expect($html)->toMatch('/<h1[^>]*>\s*\S.*?<\/h1>/s');

    // hero search + archivist wiring
    expect($html)->toContain('id="user-search-container"');
    expect($html)->toContain('id="archivist-brain-button"');
    expect($html)->toContain('id="hyperlit-container"');
    expect($html)->toContain('id="copy-feed-close"');

    // Reader-parity chrome: the top-right archive button (visitor AND owner —
    // the archive panel is the public citation/download surface) with its
    // scope stamped, its panel divs, and New inside the logo flyout (the +
    // left the top-right; hero import links / file-drop still click it).
    expect($html)->toContain('id="archiveRef"');
    expect($html)->toContain('data-scope-type="user"');
    expect($html)->toContain('data-scope-id="' . e($user->name) . '"');
    expect($html)->toContain('id="archive-container"');
    expect($html)->toContain('id="newBookButton"');
    expect($html)->toContain('id="logoNavMenu"');
});

test('visitors never get the owner chrome', function () {
    $user = makeUpseoUser();

    $html = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();

    expect($html)->not->toContain('id="editButton"');
    expect($html)->not->toContain('id="bottom-right-buttons"');
    expect($html)->not->toContain('data-library-record');
    expect($html)->not->toContain('shelf-picker-trigger');
});

test('the owner gets the pencil and the shelf picker — no Account pill (Money overlay owns billing), no active tab', function () {
    $user = makeUpseoUser();

    $html = $this->actingAs($user)->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();

    expect($html)->toContain('id="editButton"');
    expect($html)->not->toContain('data-filter="account"');
    expect($html)->toContain('id="shelf-picker-trigger"');
    expect($html)->not->toContain('arranger-button active');
    expect($html)->not->toContain('class="main-content');
});

test('a public shelf deep link renders its tab active', function () {
    $user = makeUpseoUser();
    $shelfId = (string) Str::uuid();
    upseoAdminConn()->table('shelves')->insert([
        'id'         => $shelfId,
        'creator'    => $user->name,
        'name'       => 'Deep Shelf',
        'slug'       => 'deep-shelf-' . Str::random(6),
        'visibility' => 'public',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    $slug = upseoAdminConn()->table('shelves')->where('id', $shelfId)->value('slug');

    $html = $this->get('/u/' . rawurlencode($user->name) . '/shelf/' . $slug)->assertStatus(200)->getContent();

    expect($html)->toContain('visitor-shelf-tab active');
});

test('page_settings render: about + background reach the page; css vars are NEVER emitted', function () {
    // Color/font theming is a READER preference — even stored css_vars (old
    // rows) must not render. Only the background image emits a style block.
    $user = makeUpseoUser();
    $book = str_replace(' ', '', $user->name);
    upseoAdminConn()->table('library')->insert([
        'book'       => $book,
        'title'      => $user->name . "'s library",
        'creator'    => $user->name,
        'visibility' => 'public',
        'listed'     => false,
        'raw_json'   => json_encode(['type' => 'user_home']),
        'page_settings' => json_encode([
            'css_vars'   => ['--up-accent' => '#123abc', '--up-title-font' => 'serif'],
            'about_html' => '<h1>Curated shelves of wonder</h1>',
        ]),
        'timestamp'  => (int) round(microtime(true) * 1000),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $html = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();

    expect($html)->not->toContain('id="user-page-settings-css"'); // no bg image set
    expect($html)->not->toContain('--up-accent');
    expect($html)->toContain('Curated shelves of wonder');
});

test('pill_shelves curates the visitor shelf pills', function () {
    $user = makeUpseoUser();
    $book = str_replace(' ', '', $user->name);
    $mkShelf = function (string $name) use ($user): string {
        $id = (string) Str::uuid();
        upseoAdminConn()->table('shelves')->insert([
            'id' => $id, 'creator' => $user->name, 'name' => $name,
            'slug' => Str::slug($name) . '-' . Str::random(4), 'visibility' => 'public',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        return $id;
    };
    $keep = $mkShelf('Curated Keeper');
    $mkShelf('Hidden From Pills');
    upseoAdminConn()->table('library')->insert([
        'book' => $book, 'title' => $user->name . "'s library", 'creator' => $user->name,
        'visibility' => 'public', 'listed' => false,
        'raw_json' => json_encode(['type' => 'user_home']),
        'page_settings' => json_encode(['pill_shelves' => [$keep]]),
        'timestamp' => (int) round(microtime(true) * 1000),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $html = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();

    // Assert on the PILL markup: shelf names also ride window.publicShelves
    // (the owner's curation UI needs the full public list — they're public).
    expect($html)->toContain('data-shelf-name="Curated Keeper"');
    expect($html)->not->toContain('data-shelf-name="Hidden From Pills"');
});

test('owner visit mints the About BOOK and migrates the legacy about_html blob', function () {
    $user = makeUpseoUser();
    $book = str_replace(' ', '', $user->name);
    upseoAdminConn()->table('library')->insert([
        'book' => $book, 'title' => $user->name . "'s library", 'creator' => $user->name,
        'visibility' => 'public', 'listed' => false,
        'raw_json' => json_encode(['type' => 'user_home']),
        'page_settings' => json_encode(['about_html' => '<h1 class="mega">Dope library</h1><h2>Only the dopest.</h2>']),
        'timestamp' => (int) round(microtime(true) * 1000),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $html = $this->actingAs($user)->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();

    // The About book exists, one node per top-level block, blob removed
    $aboutId = $book . 'About';
    $row = upseoAdminConn()->table('library')->where('book', $aboutId)->first();
    expect($row)->not->toBeNull();
    expect(json_decode($row->raw_json, true)['type'])->toBe('user_about');
    $nodes = upseoAdminConn()->table('nodes')->where('book', $aboutId)->orderBy('startLine')->get();
    expect($nodes)->toHaveCount(2);
    expect($nodes[0]->content)->toContain('Dope library');
    $settings = json_decode(upseoAdminConn()->table('library')->where('book', $book)->value('page_settings') ?? 'null', true);
    expect($settings['about_html'] ?? null)->toBeNull();

    // ...and the page renders the BOOK (editor DOM contract), not the blob
    expect($html)->toContain('id="user-about-book"');
    expect($html)->toContain('data-book-id="' . $aboutId . '"');
    expect($html)->toContain('data-chunk-id="0"');
    expect($html)->toContain('Dope library');
    // toolbar partial present for the inline editor
    expect($html)->toContain('id="edit-toolbar"');

    // VISITOR sees the same book content (public visibility)
    auth()->logout();
    $visitorHtml = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();
    expect($visitorHtml)->toContain('Dope library');
});

test('the About book never appears in user-library search', function () {
    $user = makeUpseoUser();
    $book = str_replace(' ', '', $user->name);
    upseoAdminConn()->table('library')->insert([
        'book' => $book, 'title' => $user->name . "'s library", 'creator' => $user->name,
        'visibility' => 'public', 'listed' => false, 'raw_json' => json_encode(['type' => 'user_home']),
        'page_settings' => json_encode(['about_html' => '<p>zanzibar wombat prose</p>']),
        'timestamp' => (int) round(microtime(true) * 1000), 'created_at' => now(), 'updated_at' => now(),
    ]);
    $this->actingAs($user)->get('/u/' . rawurlencode($user->name))->assertStatus(200); // mints About

    $resp = $this->getJson('/api/public/library/' . rawurlencode($user->name) . '/search?q=wombat');
    $resp->assertStatus(200);
    $books = array_column($resp->json('results'), 'book');
    expect($books)->not->toContain($book . 'About');
});

test('the hypercite network SVG renders BY DEFAULT; an explicit false renders nothing', function () {
    $user = makeUpseoUser();
    $book = str_replace(' ', '', $user->name);
    // one real public book with nodes so the corpus is non-empty.
    // NO page_settings: show_map defaults ON, so the map must render anyway.
    upseoAdminConn()->table('library')->insert([
        'book' => $book, 'title' => $user->name . "'s library", 'creator' => $user->name,
        'visibility' => 'public', 'listed' => false, 'raw_json' => json_encode(['type' => 'user_home']),
        'page_settings' => null,
        'timestamp' => (int) round(microtime(true) * 1000), 'created_at' => now(), 'updated_at' => now(),
    ]);
    upseoAdminConn()->table('library')->insert([
        'book' => 'upseo_map_real_' . Str::random(6), 'title' => 'Real Mapped Book', 'creator' => $user->name,
        'visibility' => 'public', 'listed' => false, 'has_nodes' => true, 'type' => 'book',
        'raw_json' => json_encode([]),
        'timestamp' => (int) round(microtime(true) * 1000), 'created_at' => now(), 'updated_at' => now(),
    ]);

    $html = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();
    expect($html)->toContain('journal-hypercite-map');
    expect($html)->toContain('data-map-node');
    expect($html)->toContain('id="journal-map-expand"');

    // toggle off → the stored opt-out (false), the ONLY value that hides it
    upseoAdminConn()->table('library')->where('book', $book)
        ->update(['page_settings' => json_encode(['show_map' => false])]);
    \Illuminate\Support\Facades\Cache::forget("user-hypercite-map:{$book}:v1");
    $html2 = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();
    expect($html2)->not->toContain('journal-hypercite-map');

    // a legacy row from when it was opt-in (stored `true`) still shows it
    upseoAdminConn()->table('library')->where('book', $book)
        ->update(['page_settings' => json_encode(['show_map' => true])]);
    \Illuminate\Support\Facades\Cache::forget("user-hypercite-map:{$book}:v1");
    $html3 = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();
    expect($html3)->toContain('journal-hypercite-map');
});

test('background_art none stamps the bg-art class; junk art never renders', function () {
    $user = makeUpseoUser();
    $book = str_replace(' ', '', $user->name);
    upseoAdminConn()->table('library')->insert([
        'book' => $book, 'title' => $user->name . "'s library", 'creator' => $user->name,
        'visibility' => 'public', 'listed' => false,
        'raw_json' => json_encode(['type' => 'user_home']),
        'page_settings' => json_encode(['background_art' => 'none']),
        'timestamp' => (int) round(microtime(true) * 1000),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $html = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();
    expect($html)->toContain('lava-lamp-background bg-art-none');

    // Tampered value → class never rendered (registry re-check at render)
    upseoAdminConn()->table('library')->where('book', $book)
        ->update(['page_settings' => json_encode(['background_art' => 'evil"onload'])]);
    $html2 = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();
    expect($html2)->not->toContain('bg-art-');
});

test('an EMPTY pill_shelves list means no visitor pills (checked = shown)', function () {
    $user = makeUpseoUser();
    $book = str_replace(' ', '', $user->name);
    upseoAdminConn()->table('shelves')->insert([
        'id' => (string) Str::uuid(), 'creator' => $user->name, 'name' => 'Unticked Shelf',
        'slug' => 'unticked-' . Str::random(4), 'visibility' => 'public',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    upseoAdminConn()->table('library')->insert([
        'book' => $book, 'title' => $user->name . "'s library", 'creator' => $user->name,
        'visibility' => 'public', 'listed' => false,
        'raw_json' => json_encode(['type' => 'user_home']),
        'page_settings' => json_encode(['pill_shelves' => []]),
        'timestamp' => (int) round(microtime(true) * 1000),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $html = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();

    expect($html)->not->toContain('data-shelf-name="Unticked Shelf"');
});

test('tampered page_settings values never reach the rendered page', function () {
    // Defense in depth: even if a bad value lands in the DB (bug, old write
    // path), the render-time emittable() re-validation drops it.
    $user = makeUpseoUser();
    $book = str_replace(' ', '', $user->name);
    upseoAdminConn()->table('library')->insert([
        'book'       => $book,
        'title'      => $user->name . "'s library",
        'creator'    => $user->name,
        'visibility' => 'public',
        'listed'     => false,
        'raw_json'   => json_encode(['type' => 'user_home']),
        'page_settings' => json_encode([
            'css_vars'   => ['--up-accent' => '#fff}body{display:none}'],
            'about_html' => '<h1>ok</h1><script>alert(1)</script>',
        ]),
        'timestamp'  => (int) round(microtime(true) * 1000),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $html = $this->get('/u/' . rawurlencode($user->name))->assertStatus(200)->getContent();

    // Specific needle: the edit-toolbar partial legitimately contains
    // `display:none` inline styles — assert the INJECTED rule never lands.
    expect($html)->not->toContain('body{display:none}');
    expect($html)->not->toContain('<script>alert');
});
