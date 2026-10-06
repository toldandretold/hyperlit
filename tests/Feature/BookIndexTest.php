<?php

/**
 * /books — the crawlable index of the public library.
 *
 * The page exists so Googlebot can FOLLOW LINKS into the corpus; every
 * assertion here is about that job. The things that would silently break it:
 *  - a private or unlisted book leaking into a public list
 *  - the entries stopping being real <a href> (a JS feed, a button)
 *  - the prev/next pagination links disappearing, which strands every book
 *    past the first page as effectively unlinked again
 *  - an entry pointing at a non-canonical URL variant, fragmenting signals
 *
 * Rows are seeded through pgsql_admin: `library` is RLS'd, and the point of
 * several of these cases is to read as an ANONYMOUS visitor.
 */

use Illuminate\Support\Facades\DB;

function seedIndexBook(array $attrs = []): string
{
    $book = $attrs['book'] ?? 'book_bi_'.bin2hex(random_bytes(6));

    DB::connection('pgsql_admin')->table('library')->insert(array_merge([
        'book' => $book,
        'title' => 'A Seeded Title',
        'author' => 'Seeded Author',
        'visibility' => 'public',
        'listed' => true,
        'creator' => 'bookindextest',
        'timestamp' => (int) (microtime(true) * 1000),
        // library.raw_json is NOT NULL (unlike the dropped nodes.raw_json)
        'raw_json' => json_encode(['book' => $book]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $attrs, ['book' => $book]));

    return $book;
}

afterEach(function () {
    // These INSERTs commit outside RefreshDatabase — clean up by hand or they
    // accumulate across runs (see CLAUDE.md on pgsql_admin fixtures).
    DB::connection('pgsql_admin')->table('library')
        ->where('creator', 'bookindextest')->delete();
});

/**
 * Walk /books the way Googlebot does — fetch page 1, follow the rendered
 * "next" link, repeat — and return every page's HTML concatenated.
 *
 * The tests assert against the WALK rather than page 1, for two reasons: the
 * index is alphabetical over a shared test database, so a seeded title lands
 * on an arbitrary page; and "is every book reachable by following links" is
 * the actual contract this page exists to satisfy. A broken next link fails
 * these tests by stranding the rest of the corpus, which is exactly right.
 */
function crawlBookIndex(object $test): string
{
    $html = '';
    $url = '/books';
    $guard = 0;

    while ($url !== null) {
        // A runaway pager would otherwise hang the suite rather than fail it
        if (++$guard > 50) {
            throw new RuntimeException('/books paginated past 50 pages — next-link loop?');
        }

        $page = $test->get($url)->assertStatus(200)->getContent();
        $html .= $page;

        $url = preg_match('/<link\s[^>]*rel="next"\s[^>]*href="([^"]+)"/', $page, $m)
            ? html_entity_decode($m[1])
            : null;
    }

    return $html;
}

test('/books lists a public listed book as a real crawlable link', function () {
    $book = seedIndexBook([
        'title' => 'The Crawlable Title',
        'author' => 'Ada Lovelace',
        'slug' => 'the-crawlable-title',
    ]);

    $html = crawlBookIndex($this);

    // A real anchor at the book's CANONICAL url (slug preferred), not the raw id
    expect($html)->toMatch('/<a\s[^>]*href="[^"]*\/the-crawlable-title"/');
    expect($html)->toContain('The Crawlable Title');
    expect($html)->toContain('Ada Lovelace');
    expect($html)->not->toContain("/{$book}\"");
});

test('/books hides private and unlisted books from an anonymous visitor', function () {
    seedIndexBook(['title' => 'Private Draft', 'visibility' => 'private']);
    seedIndexBook(['title' => 'Unlisted Harvest', 'listed' => false]);
    seedIndexBook(['title' => 'Public And Listed']);

    $html = crawlBookIndex($this);

    expect($html)->toContain('Public And Listed');
    expect($html)->not->toContain('Private Draft');
    expect($html)->not->toContain('Unlisted Harvest');
});

test('/books excludes sub-books, which live at /based/', function () {
    seedIndexBook(['book' => 'book_bi_parent/Fn123', 'title' => 'A Footnote Sub Book']);

    $html = crawlBookIndex($this);

    expect($html)->not->toContain('A Footnote Sub Book');
});

test('/books carries the pagination links a crawl needs to walk past page 1', function () {
    // PER_PAGE is 50 — seed enough to force a second page
    for ($i = 0; $i < 55; $i++) {
        seedIndexBook(['title' => sprintf('Paged Title %02d', $i)]);
    }

    $page1 = $this->get('/books')->assertStatus(200)->getContent();

    // rel=next in the head AND a followable next link in the body
    expect($page1)->toMatch('/<link\s[^>]*rel="next"/');
    expect($page1)->toMatch('/<a\s[^>]*href="[^"]*page=2"/');
    // page 1 canonicalizes to the bare /books, never /books?page=1
    expect($page1)->toMatch('/<link\s[^>]*rel="canonical"\s[^>]*href="[^"]*\/books"/');

    $page2 = $this->get('/books?page=2')->assertStatus(200)->getContent();

    expect($page2)->toMatch('/<link\s[^>]*rel="prev"/');
    expect($page2)->toMatch('/<link\s[^>]*rel="canonical"\s[^>]*href="[^"]*page=2"/');
});

test('/books emits its own title, description and canonical', function () {
    seedIndexBook();

    $html = $this->get('/books')->assertStatus(200)->getContent();

    // NOT the layout's bare "Hyperlit" fallback
    expect($html)->toMatch('/<title>[^<]*Books on Hyperlit[^<]*<\/title>/');
    expect($html)->toMatch('/<meta\s+name="description"\s+content="[^"]{40,}"/');
    expect($html)->toMatch('/<link\s[^>]*rel="canonical"/');
});

test('/books does not shadow a book, because the segment is reserved', function () {
    expect(config('reserved-routes'))->toContain('books');
});
