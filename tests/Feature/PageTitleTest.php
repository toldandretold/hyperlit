<?php

/**
 * <title> rules for book pages (TextController::composePageTitle).
 *
 * All three rules come from live SERP output, not taste:
 *  - the brand suffix is an EM DASH, matching journal-index, archive-index,
 *    the homepage and user pages. Book titles used a hyphen, so a single
 *    result page showed the site branding itself two ways.
 *  - an author equal to the brand is dropped: /welcome and /stats are credited
 *    to "Hyperlit"/"hyperlit" and read "… by Hyperlit — Hyperlit".
 *  - the whole title is capped near Google's ~60-char display width, dropping
 *    the author BEFORE truncating the title, because the title is the part
 *    that identifies the work.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function seedTitleBook(array $attrs = []): string
{
    $book = 'book_pt_'.bin2hex(random_bytes(6));

    DB::connection('pgsql_admin')->table('library')->insert(array_merge([
        'book' => $book,
        'title' => 'Title Test',
        'author' => 'Title Author',
        'visibility' => 'public',
        'listed' => true,
        'creator' => 'pagetitletest',
        'timestamp' => (int) (microtime(true) * 1000),
        'raw_json' => json_encode(['book' => $book]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $attrs, ['book' => $book]));

    DB::connection('pgsql_admin')->table('nodes')->insert([
        'book' => $book, 'startLine' => 0, 'chunk_id' => 0,
        'node_id' => $book.'_n0', 'content' => '<p>Body</p>',
        'plainText' => 'Body', 'type' => 'p', 'footnotes' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    return $book;
}

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    foreach (['nodes', 'library'] as $table) {
        $admin->table($table)->where('book', 'like', 'book_pt_%')->delete();
    }
});

function renderedTitle(object $test, string $url): string
{
    $html = $test->get($url)->assertStatus(200)->getContent();
    preg_match('/<title>(.*?)<\/title>/s', $html, $m);

    return html_entity_decode(trim($m[1] ?? ''), ENT_QUOTES | ENT_HTML5);
}

test('book title uses the em-dash brand suffix, not a hyphen', function () {
    $book = seedTitleBook(['title' => 'Capital', 'author' => 'Marx, Karl']);

    $title = renderedTitle($this, "/{$book}");

    expect($title)->toBe('Capital by Marx, Karl — Hyperlit');
    expect($title)->not->toContain('- Hyperlit');
});

test('an author that IS the brand is dropped rather than doubled', function () {
    $book = seedTitleBook(['title' => 'Welcome to the docuverse', 'author' => 'Hyperlit']);
    $lower = seedTitleBook(['title' => 'Platform Statistics', 'author' => 'hyperlit']);

    expect(renderedTitle($this, "/{$book}"))->toBe('Welcome to the docuverse — Hyperlit');
    // case-insensitive: /stats is credited to lowercase "hyperlit"
    expect(renderedTitle($this, "/{$lower}"))->toBe('Platform Statistics — Hyperlit');
});

test('a long title drops the author before it truncates the title', function () {
    $book = seedTitleBook([
        'title' => 'Neo-colonialism: The Highest Stage of Imperialism',
        'author' => 'Nkrumah, Kwame',
    ]);

    $title = renderedTitle($this, "/{$book}");

    expect($title)->toBe('Neo-colonialism: The Highest Stage of Imperialism — Hyperlit');
    expect(mb_strlen($title))->toBeLessThanOrEqual(60);
    expect($title)->not->toContain('Nkrumah');
});

test('a title too long even alone is truncated, and still carries the brand', function () {
    $book = seedTitleBook([
        'title' => 'The '.Str::repeat('Extremely ', 12).'Long Monograph Title',
        'author' => 'Someone',
    ]);

    $title = renderedTitle($this, "/{$book}");

    expect(mb_strlen($title))->toBeLessThanOrEqual(60);
    expect($title)->toEndWith(' — Hyperlit');
    expect($title)->toContain('…');
    // the ellipsis never lands straight after a space or stray punctuation
    expect($title)->not->toMatch('/[\s.,;:—-]…/');
});

test('a slug-less book still gets a real title, not the layout fallback', function () {
    $book = seedTitleBook(['title' => 'Unslugged Work', 'author' => 'A N Other']);

    expect(renderedTitle($this, "/{$book}"))->toBe('Unslugged Work by A N Other — Hyperlit');
});
