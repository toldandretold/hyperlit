<?php

/**
 * App\Support\SlugRules + library:backfill-slugs.
 *
 * A slug is reachable at /{slug} through the `/{identifier}` catch-all, so it
 * shares a namespace with every root route and every username — slug
 * validation is a shadowing and impersonation guard, not formatting. These
 * tests exist because that gauntlet now has TWO callers (setSlug and the bulk
 * backfill), and the whole point of extracting SlugRules was that two copies
 * of an impersonation check drift apart silently.
 *
 * See CLAUDE.md, "Root routes are book names" and "Usernames are one identity,
 * one URL".
 */

use App\Support\SlugRules;
use Illuminate\Support\Facades\DB;

function seedSlugBook(array $attrs = []): string
{
    $book = $attrs['book'] ?? 'book_sb_'.bin2hex(random_bytes(6));

    DB::connection('pgsql_admin')->table('library')->insert(array_merge([
        'book' => $book,
        'title' => 'Slug Test Title',
        'author' => null,
        'slug' => null,
        'visibility' => 'public',
        'listed' => true,
        'creator' => 'slugbackfilltest',
        'timestamp' => (int) (microtime(true) * 1000),
        'raw_json' => json_encode(['book' => $book]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $attrs, ['book' => $book]));

    return $book;
}

afterEach(function () {
    DB::connection('pgsql_admin')->table('library')
        ->where('creator', 'slugbackfilltest')->delete();
});

// ---------------------------------------------------------------- SlugRules

test('a reserved root segment is refused — it would shadow the book entirely', function () {
    foreach (['books', 'login', 'maintainer', 'sitemap', 'api', 'based'] as $reserved) {
        expect(SlugRules::isAvailable($reserved))->toBeFalse();
    }
});

test('a malformed slug is refused', function () {
    foreach ([
        'ab',                 // under the 3-char minimum
        '-leading',           // leading hyphen
        'trailing-',          // trailing hyphen
        'Has Capitals',       // uppercase + space
        'under_score',        // underscore
        'sym£bol',            // non-alphanumeric
        str_repeat('a', 61),  // over the 60-char maximum
    ] as $bad) {
        expect(SlugRules::isAvailable($bad))->toBeFalse();
    }
});

test('a slug colliding with an existing book id is refused', function () {
    $book = seedSlugBook();

    // The book id itself is a live URL; a different book claiming it as a slug
    // would make one of the two unreachable.
    expect(SlugRules::isAvailable($book))->toBeFalse();
});

test('a slug already used by ANOTHER book is refused, but its own is not', function () {
    $book = seedSlugBook(['slug' => 'taken-by-me']);

    expect(SlugRules::isAvailable('taken-by-me'))->toBeFalse();
    // re-asserting its own slug is not a collision with itself
    expect(SlugRules::isAvailable('taken-by-me', $book))->toBeTrue();
});

test('candidateFrom builds a readable slug and appends a year when it fits', function () {
    // Under the 20-char threshold, so the surname is added too — "Capital:
    // Volume III" alone would collide across every edition and translation.
    expect(SlugRules::candidateFrom('Capital: Volume III', 'Marx, Karl', 1894))
        ->toBe('capital-volume-iii-marx-1894');

    // A title long enough to identify the work takes the year and no surname.
    expect(SlugRules::candidateFrom('The Wretched of the Earth and After', 'Fanon, Frantz', 1961))
        ->toBe('the-wretched-of-the-earth-and-after-1961');
});

test('candidateFrom adds a surname only to rescue a short title', function () {
    // short title → surname disambiguates editions of the same work
    expect(SlugRules::candidateFrom('Capital', 'Marx, Karl'))->toBe('capital-marx');
    // "Karl Marx" order resolves to the same surname
    expect(SlugRules::candidateFrom('Capital', 'Karl Marx'))->toBe('capital-marx');
    // multiple authors → first only, or the slug stops being a slug
    expect(SlugRules::candidateFrom('Capital', 'Marx, Karl; Engels, Friedrich'))
        ->toBe('capital-marx');
    // a long title already identifies the work
    expect(SlugRules::candidateFrom('Neo-colonialism: The Highest Stage of Imperialism', 'Nkrumah'))
        ->not->toContain('nkrumah');
});

test('candidateFrom never exceeds the max length or ends on a stopword', function () {
    $slug = SlugRules::candidateFrom(
        'Peer Review 2027: Scenarios for Academic Publishing in the Age of AI'
    );

    expect(strlen($slug))->toBeLessThanOrEqual(SlugRules::MAX_LENGTH);
    expect($slug)->toBe('peer-review-2027-scenarios-for-academic-publishing');
    // a dangling preposition reads as a broken URL and adds no keyword
    expect($slug)->not->toEndWith('-in');
    expect($slug)->not->toEndWith('-the');
});

test('candidateFrom returns null when nothing usable survives', function () {
    expect(SlugRules::candidateFrom('—'))->toBeNull();
    expect(SlugRules::candidateFrom('!!!'))->toBeNull();
    expect(SlugRules::candidateFrom('ab'))->toBeNull();
});

test('uniqueFrom suffixes a taken slug and keeps the result valid', function () {
    seedSlugBook(['slug' => 'contested-slug']);

    $slug = SlugRules::uniqueFrom('contested-slug');

    expect($slug)->toBe('contested-slug-2');
    expect(SlugRules::isAvailable($slug))->toBeTrue();
});

test('uniqueFrom routes around a reserved word instead of failing', function () {
    // "books" shadows a root route, but "books-2" does not — only the EXACT
    // segment is reserved, so suffixing is a legitimate escape rather than a
    // near-miss that hides the problem. A book titled "Books" still gets a
    // working URL.
    $slug = SlugRules::uniqueFrom('books');

    expect($slug)->toBe('books-2');
    expect(SlugRules::isAvailable($slug))->toBeTrue();
    expect(in_array($slug, config('reserved-routes'), true))->toBeFalse();
});

// ------------------------------------------------------- the artisan command

test('the backfill is a dry run by default and writes nothing', function () {
    $book = seedSlugBook(['title' => 'A Dry Run Subject']);

    $this->artisan('library:backfill-slugs', ['--book' => $book])
        ->expectsOutputToContain('DRY RUN')
        ->assertSuccessful();

    expect(DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('slug'))
        ->toBeNull();
});

test('--apply writes a readable slug the book then resolves at', function () {
    $book = seedSlugBook(['title' => 'An Applied Subject', 'author' => null]);

    $this->artisan('library:backfill-slugs', ['--book' => $book, '--apply' => true])
        ->assertSuccessful();

    $slug = DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('slug');

    expect($slug)->toBe('an-applied-subject');
    // the OLD url still resolves — nothing breaks when a slug appears
    expect(App\Helpers\BookSlugHelper::resolve($book))->toBe($book);
    expect(App\Helpers\BookSlugHelper::resolve($slug))->toBe($book);
    // and the canonical now PREFERS the slug, which is what consolidates them
    expect(App\Helpers\BookSlugHelper::canonicalUrl($book))->toBe(url('/'.$slug));
});

test('the backfill skips a book that already has a slug', function () {
    $book = seedSlugBook(['slug' => 'hand-set-vanity-slug', 'title' => 'Something Else']);

    $this->artisan('library:backfill-slugs', ['--book' => $book, '--apply' => true])
        ->expectsOutputToContain('No eligible books')
        ->assertSuccessful();

    expect(DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('slug'))
        ->toBe('hand-set-vanity-slug');
});

test('the backfill leaves private and unlisted books alone', function () {
    $private = seedSlugBook(['title' => 'Private Subject', 'visibility' => 'private']);
    $unlisted = seedSlugBook(['title' => 'Unlisted Subject', 'listed' => false]);

    $this->artisan('library:backfill-slugs', [
        '--creator' => 'slugbackfilltest', '--apply' => true,
    ])->assertSuccessful();

    $admin = DB::connection('pgsql_admin');
    expect($admin->table('library')->where('book', $private)->value('slug'))->toBeNull();
    expect($admin->table('library')->where('book', $unlisted)->value('slug'))->toBeNull();
});

test('two books with the same title get distinct slugs in ONE run', function () {
    // The second slug is not in the database yet when the first is minted, so
    // in-run collisions have to be tracked by the command itself.
    $a = seedSlugBook(['title' => 'Identical Twin Title']);
    $b = seedSlugBook(['title' => 'Identical Twin Title']);

    $this->artisan('library:backfill-slugs', [
        '--creator' => 'slugbackfilltest', '--apply' => true,
    ])->assertSuccessful();

    $admin = DB::connection('pgsql_admin');
    $slugA = $admin->table('library')->where('book', $a)->value('slug');
    $slugB = $admin->table('library')->where('book', $b)->value('slug');

    expect($slugA)->not->toBeNull();
    expect($slugB)->not->toBeNull();
    expect($slugA)->not->toBe($slugB);
});

test('the backfill never mints a slug SlugRules would refuse', function () {
    seedSlugBook(['title' => 'Books']);          // reserved root segment
    seedSlugBook(['title' => 'Login']);          // reserved root segment
    seedSlugBook(['title' => '!!!']);            // yields nothing usable

    $this->artisan('library:backfill-slugs', [
        '--creator' => 'slugbackfilltest', '--apply' => true,
    ])->assertSuccessful();

    $slugs = DB::connection('pgsql_admin')->table('library')
        ->where('creator', 'slugbackfilltest')
        ->whereNotNull('slug')
        ->pluck('slug');

    foreach ($slugs as $slug) {
        expect(in_array($slug, config('reserved-routes'), true))->toBeFalse();
        expect(in_array($slug, config('reserved-usernames'), true))->toBeFalse();
        expect($slug)->toMatch(SlugRules::FORMAT);
    }
});

test('--undo refuses to run without a specific book', function () {
    $this->artisan('library:backfill-slugs', ['--undo' => true, '--apply' => true])
        ->assertFailed();
});

test('--undo clears one book\'s slug', function () {
    $book = seedSlugBook(['slug' => 'to-be-undone']);

    $this->artisan('library:backfill-slugs', [
        '--undo' => true, '--book' => $book, '--apply' => true,
    ])->assertSuccessful();

    expect(DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('slug'))
        ->toBeNull();
});
