<?php

/**
 * /sitemap.xml — the URL inventory handed to search engines.
 *
 * What it used to omit is the point of these tests: it listed the homepage and
 * books only, so every HUB that groups them — /books, the /j and /a indexes,
 * each certified journal and archive, each user profile — was invisible to
 * discovery. A sitemap is only a suggestion list, but omitting the hubs meant
 * Google had neither a link path (see BookIndexController) nor a hint.
 *
 * Also locked here: a listed URL must be the book's CANONICAL URL. Offering a
 * raw /book_<id> for a book whose own page canonicalizes to /slug submits a
 * URL that points away from itself, which is how ranking signals fragment.
 */

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function seedSitemapBook(array $attrs = []): string
{
    $book = $attrs['book'] ?? 'book_sm_'.bin2hex(random_bytes(6));

    DB::connection('pgsql_admin')->table('library')->insert(array_merge([
        'book' => $book,
        'title' => 'Sitemap Seeded',
        'author' => 'Sitemap Author',
        'visibility' => 'public',
        'listed' => true,
        'creator' => 'sitemaptest',
        'timestamp' => (int) (microtime(true) * 1000),
        'raw_json' => json_encode(['book' => $book]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $attrs, ['book' => $book]));

    return $book;
}

beforeEach(function () {
    // The XML is cached for an hour — a stale entry would make every
    // assertion below a test of the previous run.
    Cache::forget('sitemap_xml');
});

afterEach(function () {
    DB::connection('pgsql_admin')->table('library')
        ->where('creator', 'sitemaptest')->delete();
    Cache::forget('sitemap_xml');
});

test('sitemap lists the crawl hubs, not just books', function () {
    $xml = $this->get('/sitemap.xml')->assertStatus(200)->getContent();

    expect($xml)->toContain('<loc>'.url('/').'</loc>');
    expect($xml)->toContain('<loc>'.url('/books').'</loc>');
    expect($xml)->toContain('<loc>'.url('/j').'</loc>');
    expect($xml)->toContain('<loc>'.url('/a').'</loc>');
});

test('sitemap lists a book at its canonical slug URL, never the raw id', function () {
    $slug = 'sitemap-canon-'.strtolower(Str::random(6));
    $book = seedSitemapBook(['slug' => $slug]);

    $xml = $this->get('/sitemap.xml')->assertStatus(200)->getContent();

    expect($xml)->toContain('<loc>'.url('/'.$slug).'</loc>');
    expect($xml)->not->toContain('<loc>'.url('/'.$book).'</loc>');
});

test('sitemap lists the profile of a creator holding public books', function () {
    seedSitemapBook();

    $xml = $this->get('/sitemap.xml')->assertStatus(200)->getContent();

    expect($xml)->toContain('<loc>'.url('/u/sitemaptest').'</loc>');
});

test('sitemap omits private and unlisted books and their creators', function () {
    seedSitemapBook([
        'book' => 'book_sm_hidden_'.bin2hex(random_bytes(4)),
        'visibility' => 'private',
        'creator' => 'sitemaptest',
        'slug' => 'sitemap-private-'.strtolower(Str::random(6)),
    ]);

    $xml = $this->get('/sitemap.xml')->assertStatus(200)->getContent();

    expect($xml)->not->toContain('sitemap-private-');
    // creator had ONLY a private book, so its profile is not a public hub
    expect($xml)->not->toContain('<loc>'.url('/u/sitemaptest').'</loc>');
});

test('sitemap omits the harvester system account, which is not a person', function () {
    // canonicalizer_v1 owns the whole harvested corpus, so its profile is the
    // biggest library on the site — and the one that is not a person. Offering
    // it for crawl submits a bot account as a ProfilePage/Person.
    $system = App\Services\CanonicalVersions\AutoVersionResolver::CREATOR;

    seedSitemapBook(['creator' => $system, 'slug' => 'system-owned-'.strtolower(Str::random(6))]);

    $xml = $this->get('/sitemap.xml')->assertStatus(200)->getContent();

    expect($xml)->not->toContain('<loc>'.url('/u/'.$system).'</loc>');
    // its BOOKS are still listed — only the profile is withheld
    expect($xml)->toContain('system-owned-');

    DB::connection('pgsql_admin')->table('library')->where('creator', $system)
        ->where('book', 'like', 'book_sm_%')->delete();
});

test('sitemap paginates /books to cover every page a crawler must reach', function () {
    $xml = $this->get('/sitemap.xml')->assertStatus(200)->getContent();

    // However many books exist, page 1 is the bare /books (matching the
    // canonical that page emits) and any further page is explicit.
    expect($xml)->toContain('<loc>'.url('/books').'</loc>');
    expect($xml)->not->toContain('<loc>'.url('/books?page=1').'</loc>');

    $bookPageCount = (int) ceil(
        DB::connection('pgsql_admin')->table('library')
            ->where('visibility', 'public')->where('listed', true)
            ->where('book', 'not like', '%/%')->count() / 50
    );

    if ($bookPageCount > 1) {
        expect($xml)->toContain('<loc>'.url('/books?page=2').'</loc>');
    }
});

test('sitemap is well-formed XML', function () {
    $xml = $this->get('/sitemap.xml')
        ->assertStatus(200)
        ->assertHeader('Content-Type', 'application/xml')
        ->getContent();

    $prev = libxml_use_internal_errors(true);
    $doc = simplexml_load_string($xml);
    libxml_use_internal_errors($prev);

    expect($doc)->not->toBeFalse();
    expect($doc->getName())->toBe('urlset');
});
