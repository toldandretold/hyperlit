<?php

/**
 * Legacy book URLs 301 to the slug.
 *
 * WHY: after the 2026-10-05 slug backfill, every pre-slug URL form — the raw
 * /book_<id> and the old human-readable book ids (/trotsky1936revolution) —
 * kept serving 200 with only a canonical tag pointing at the slug. Google held
 * both URLs live per work and elected its own canonical among them (GSC
 * "Alternative page with proper canonical tag"). A 301 consolidates the
 * signals and retires the legacy form.
 *
 * The redirect lives in TextController::show behind four clauses, and the
 * PRIVACY one is load-bearing: BookSlugHelper::getSlug reads pgsql_admin, so
 * without the RLS-subject buildSeoData gate an anonymous GET of a private
 * book's raw id would 301 to its title-derived slug — leaking the title of a
 * book the visitor may not see. That case is pinned here.
 *
 * Seeding follows BookCanonicalTest: admin-connection inserts, afterEach
 * cleanup by prefix (RefreshDatabase cannot roll back admin commits).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    foreach ($this->legacyBooks ?? [] as $book) {
        foreach (['nodes', 'library'] as $table) {
            try { $admin->table($table)->where('book', $book)->delete(); } catch (\Throwable $e) {}
        }
    }
    $admin->table('users')->where('email', 'like', '%@legacyredirecttest.test')->delete();
});

function seedLegacyBook(object $test, ?string $slug = null, array $attrs = []): string
{
    // An old-style human-readable id by default — the exact shape the GSC
    // report surfaced (weber2004successd, trotsky1936revolution).
    $book = $attrs['book'] ?? 'legacyredir' . strtolower(Str::random(10));
    unset($attrs['book']);
    $test->legacyBooks = array_merge($test->legacyBooks ?? [], [$book]);

    $admin = DB::connection('pgsql_admin');
    $admin->table('library')->insert(array_merge([
        'book' => $book, 'title' => 'Legacy Redirect Test', 'author' => 'Test Author',
        'slug' => $slug, 'visibility' => 'public',
        'creator' => null, 'creator_token' => null, 'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ], $attrs));
    $admin->table('nodes')->insert([
        'book' => $book, 'startLine' => 0, 'chunk_id' => 0, 'node_id' => $book . '_n0',
        'content' => '<p>Legacy body</p>', 'plainText' => 'Legacy body', 'type' => 'p',
        'footnotes' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    return $book;
}

test('a slugged book\'s raw id 301s to the slug, and following it lands on the canonical page', function () {
    $slug = 'legacy-redirect-' . strtolower(Str::random(6));
    $book = seedLegacyBook($this, $slug);

    $this->get("/{$book}")
        ->assertStatus(301)
        ->assertRedirect("/{$slug}");

    $html = $this->followingRedirects()->get("/{$book}")->assertStatus(200)->getContent();
    expect($html)->toContain('<link rel="canonical" href="' . url('/' . $slug) . '">');
});

test('a raw /book_<id> form 301s the same way', function () {
    $slug = 'legacy-opaque-' . strtolower(Str::random(6));
    $book = seedLegacyBook($this, $slug, ['book' => 'book_' . random_int(1_700_000_000_000, 1_799_999_999_999)]);

    $this->get("/{$book}")->assertStatus(301)->assertRedirect("/{$slug}");
});

test('the query string survives the redirect (?target= is the SPA prerender hint)', function () {
    $slug = 'legacy-query-' . strtolower(Str::random(6));
    $book = seedLegacyBook($this, $slug);

    $this->get("/{$book}?target=HL_1")
        ->assertStatus(301)
        ->assertRedirect("/{$slug}?target=HL_1");
});

test('deep-link suffixes ride along: /edit, /HL_…, /…Fn…', function () {
    $slug = 'legacy-deep-' . strtolower(Str::random(6));
    $book = seedLegacyBook($this, $slug);

    $this->get("/{$book}/edit")->assertStatus(301)->assertRedirect("/{$slug}/edit");
    $this->get("/{$book}/HL_zz1")->assertStatus(301)->assertRedirect("/{$slug}/HL_zz1");
    $this->get("/{$book}/xxFn123")->assertStatus(301)->assertRedirect("/{$slug}/xxFn123");
});

test('the slug URL itself never redirects (no loop)', function () {
    $slug = 'legacy-noloop-' . strtolower(Str::random(6));
    seedLegacyBook($this, $slug);

    $this->get("/{$slug}")->assertStatus(200);
});

test('a slugless book keeps serving 200 at its raw id — that IS its canonical', function () {
    $book = seedLegacyBook($this, null);

    $html = $this->get("/{$book}")->assertStatus(200)->getContent();
    expect($html)->toContain('<link rel="canonical" href="' . url('/' . $book) . '">');
});

test('PRIVACY: a private book\'s raw id serves the noindex shell, never a 301 that leaks its slug', function () {
    $slug = 'legacy-private-' . strtolower(Str::random(6));
    $book = seedLegacyBook($this, $slug, ['visibility' => 'private']);

    $res = $this->get("/{$book}")->assertStatus(200);
    $html = $res->getContent();

    expect($html)->toContain('<meta name="robots" content="noindex, follow">');
    expect($html)->not->toContain($slug); // the slug must not appear anywhere in the response
});

test('a bare username still 301s to its /u/ page (non-regression against the identifier closure)', function () {
    $unique = 'legacyuser' . strtolower(Str::random(8));
    DB::connection('pgsql_admin')->table('users')->insert([
        'name' => $unique,
        'email' => $unique . '@legacyredirecttest.test',
        'password' => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status' => 'budget',
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->get("/{$unique}")->assertStatus(301)->assertRedirect("/u/{$unique}");
});
