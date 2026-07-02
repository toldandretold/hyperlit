<?php

/**
 * Canonical URL unification — every URL variant of a book (raw id, slug, /edit,
 * HL deep link) must emit ONE canonical URL (the slug route when a slug exists,
 * else /book_<id>), or ranking signals fragment across duplicates. Wired in
 * TextController::buildSeoData() via BookSlugHelper::canonicalUrl(); the layout
 * reads $canonicalUrl / $ogUrl.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    foreach ($this->canonBooks ?? [] as $book) {
        foreach (['nodes', 'library'] as $table) {
            try { $admin->table($table)->where('book', $book)->delete(); } catch (\Throwable $e) {}
        }
    }
});

function seedCanonicalBook(object $test, ?string $slug = null): string
{
    $book = 'apitest_' . Str::random(12);
    $test->canonBooks = array_merge($test->canonBooks ?? [], [$book]);

    $admin = DB::connection('pgsql_admin');
    $admin->table('library')->insert([
        'book' => $book, 'title' => 'Canonical Test', 'author' => 'Test Author',
        'slug' => $slug, 'visibility' => 'public',
        'creator' => null, 'creator_token' => null, 'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ]);
    $admin->table('nodes')->insert([
        'book' => $book, 'startLine' => 0, 'chunk_id' => 0, 'node_id' => $book . '_n0',
        'content' => '<p>Canonical body</p>', 'plainText' => 'Canonical body', 'type' => 'p',
        'footnotes' => json_encode([]), 'raw_json' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    return $book;
}

test('slugged book: raw id, slug, /edit and HL deep link ALL canonicalize to the slug URL', function () {
    $slug = 'canonical-test-' . strtolower(Str::random(6));
    $book = seedCanonicalBook($this, $slug);

    $canonical = url('/' . $slug);
    $canonicalTag = '<link rel="canonical" href="' . $canonical . '">';
    $ogTag = '<meta property="og:url" content="' . $canonical . '">';

    foreach (["/{$book}", "/{$slug}", "/{$slug}/edit", "/{$book}/HL_zz1"] as $variant) {
        $html = $this->get($variant)->assertStatus(200)->getContent();
        expect($html)->toContain($canonicalTag);
        expect($html)->toContain($ogTag);
    }
});

test('slug-less book canonicalizes to its raw /book_<id> URL (deep links included)', function () {
    $book = seedCanonicalBook($this, null);

    $canonicalTag = '<link rel="canonical" href="' . url('/' . $book) . '">';

    foreach (["/{$book}", "/{$book}/edit", "/{$book}/HL_zz1"] as $variant) {
        $html = $this->get($variant)->assertStatus(200)->getContent();
        expect($html)->toContain($canonicalTag);
    }
});

test('JSON-LD url uses the canonical URL, not the requested variant', function () {
    $slug = 'canonical-ld-' . strtolower(Str::random(6));
    $book = seedCanonicalBook($this, $slug);

    $html = $this->get("/{$book}/HL_zz1")->assertStatus(200)->getContent();

    expect($html)->toContain('"url":"' . url('/' . $slug) . '"');
});
