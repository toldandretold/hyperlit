<?php

/**
 * Authors as identities (docs/authors.md): the `authors` / `book_authors`
 * tables, the system-maintained author shelf behind /a/{slug}, linking from a
 * VERIFIED canonical, auto-creation from Wikidata when both sides agree, and
 * the admin-only `authors` field of a scrape manifest.
 *
 * Fixtures are written on pgsql_admin (they escape RefreshDatabase), so every
 * name carries the `authtest` prefix and cleanup runs in beforeEach.
 * canonical_source is wiped per test by tests/Pest.php. No test touches the
 * network: Http is faked, and stray requests fail.
 */

use App\Jobs\ResolveBookAuthorsJob;
use App\Services\Archives\ShelfArchiveMinter;
use App\Services\Authors\AuthorLinker;
use App\Services\Authors\AuthorRegistry;
use App\Services\Authors\AuthorResolver;
use App\Services\Shelves\AuthorShelf;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function authDb()
{
    return DB::connection('pgsql_admin');
}

function authCleanup(): void
{
    $authorIds = authDb()->table('authors')
        ->where('slug', 'LIKE', 'authtest-%')->orWhere('display_name', 'LIKE', 'Authtest %')->pluck('id');
    $shelfIds = authDb()->table('archive_sources')->whereIn('author_id', $authorIds)->pluck('shelf_id')
        ->merge(authDb()->table('shelves')->where('slug', 'LIKE', 'author-authtest-%')->pluck('id'))
        ->merge(authDb()->table('shelves')->where('name', 'LIKE', 'Authtest %')->pluck('id'))
        ->unique();
    if ($shelfIds->isNotEmpty()) {
        authDb()->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        authDb()->table('nodes')->where(function ($q) use ($shelfIds) {
            foreach ($shelfIds as $id) {
                $q->orWhere('book', 'LIKE', "shelf_{$id}_%");
            }
        })->delete();
        authDb()->table('library')->where(function ($q) use ($shelfIds) {
            foreach ($shelfIds as $id) {
                $q->orWhere('book', 'LIKE', "shelf_{$id}_%");
            }
        })->delete();
        authDb()->table('archive_sources')->whereIn('shelf_id', $shelfIds)->delete();
        authDb()->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
    authDb()->table('archive_sources')->where('slug', 'LIKE', 'authtest-%')->delete();
    authDb()->table('book_authors')->where('book', 'LIKE', 'authtest\_%')->delete();
    authDb()->table('authors')->whereIn('id', $authorIds)->delete();
    authDb()->table('library')->where('book', 'LIKE', 'authtest\_%')->delete();

    foreach (glob(resource_path('markdown/authtest_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
}

beforeEach(function () {
    authCleanup();
    Http::preventStrayRequests();
});
afterEach(function () {
    $this->cleanupApiFixtures();
    foreach (glob(resource_path('markdown/authtest_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
});

/** An author with no Wikidata id (so creating one never calls out). */
function authAuthor(string $name, array $aliases = [], array $ids = []): object
{
    $slug = 'authtest-' . Str::lower(Str::random(8));
    $author = app(AuthorRegistry::class)->ensure($slug, $name, null, $aliases);
    if ($ids) {
        authDb()->table('authors')->where('id', $author->id)->update(array_map(
            fn ($v) => is_array($v) ? json_encode($v) : $v,
            $ids
        ));
    }

    return authDb()->table('authors')->where('id', $author->id)->first();
}

function authBook(array $attrs = []): string
{
    $book = 'authtest_' . Str::lower(Str::random(10));
    authDb()->table('library')->insert($attrs + [
        'book' => $book, 'title' => 'Authtest Book', 'author' => 'As Printed', 'visibility' => 'public',
        'has_nodes' => true, 'type' => 'book', 'creator' => 'authtest_creator',
        'timestamp' => round(microtime(true) * 1000), 'raw_json' => '{}',
    ]);

    return $book;
}

/** A book linked to a canonical naming these authors; returns the book id. */
function authVerifiedBook(string $method, ?string $authorString, ?array $authorships = null, array $bookAttrs = []): string
{
    $canonicalId = (string) Str::uuid();
    authDb()->table('canonical_source')->insert([
        'id' => $canonicalId, 'title' => 'Authtest Canonical ' . Str::random(6), 'author' => $authorString,
        'authorships' => $authorships === null ? null : json_encode($authorships),
        'foundation_source' => 'test', 'created_at' => now(), 'updated_at' => now(),
    ]);

    return authBook($bookAttrs + ['canonical_source_id' => $canonicalId, 'canonical_match_method' => $method]);
}

function authShelfBooks(object $author): array
{
    $shelfId = AuthorShelf::shelfIdFor($author->id);

    return $shelfId ? authDb()->table('shelf_items')->where('shelf_id', $shelfId)->pluck('book')->all() : [];
}

/** A Wikidata wbgetentities body for one person. */
function authWikidataEntity(string $qid, string $label, array $claims, bool $human = true): array
{
    $claim = fn (mixed $v) => ['rank' => 'normal', 'mainsnak' => ['datavalue' => ['value' => $v]]];
    $built = ['P31' => [$claim(['id' => $human ? 'Q5' : 'Q43229'])]];
    foreach ($claims as $property => $value) {
        $built[$property] = [$claim($value)];
    }

    return ['entities' => [$qid => [
        'labels' => ['en' => ['value' => $label]],
        'aliases' => ['en' => [['value' => $label . ' Alias']]],
        'descriptions' => ['en' => ['value' => 'authtest person']],
        'claims' => $built,
    ]]];
}

/* ── names ───────────────────────────────────────────────────────────────── */

test('a name finds its author only by an exact, unambiguous, more-than-surname spelling', function () {
    $registry = app(AuthorRegistry::class);
    $marx = authAuthor('Authtest Karl Marxx', ['Marxx', 'Authtest K. Marxx']);

    expect($registry->findByName('Marxx, Authtest Karl')->id)->toBe($marx->id)
        ->and($registry->findByName('authtest k marxx')->id)->toBe($marx->id)
        ->and($registry->findByName('Marxx'))->toBeNull()                 // a bare surname, even though recorded
        ->and($registry->findByName('Authtest Carl Marxx'))->toBeNull();  // close is not exact

    // Two people recording one spelling: the name alone no longer identifies either.
    authAuthor('Authtest Karl Marxx Jr', ['Authtest Karl Marxx']);
    expect($registry->findByName('Authtest Karl Marxx'))->toBeNull();
});

/* ── linking from a verified canonical ───────────────────────────────────── */

test('a trusted canonical links its known authors and never rewrites the printed credit', function () {
    Queue::fake();
    $author = authAuthor('Authtest Rosa Luxx');
    $book = authVerifiedBook('user_verified', 'Luxx, Authtest Rosa; Authtest Nobody Known');

    $report = app(AuthorLinker::class)->linkFromCanonical($book);

    expect($report['status'])->toBe('linked')
        ->and($report['linked'][0])->toMatchArray(['slug' => $author->slug, 'via' => 'name'])
        ->and($report['unmatched'])->toBe(['Authtest Nobody Known']);

    $link = authDb()->table('book_authors')->where('book', $book)->first();
    expect($link->author_id)->toBe($author->id)
        ->and($link->role)->toBe('author')
        ->and($link->source)->toBe('canonical')
        ->and(authDb()->table('library')->where('book', $book)->value('author'))->toBe('As Printed');

    // A name with no id never asks Wikidata to invent anyone.
    Queue::assertNothingPushed();
});

test('an automated title match is not trusted to carry an author identity', function () {
    Queue::fake();
    authAuthor('Authtest Rosa Luxx');
    $book = authVerifiedBook('openalex_title_short', 'Authtest Rosa Luxx');

    $report = app(AuthorLinker::class)->linkFromCanonical($book);

    expect($report['status'])->toBe('untrusted_method')
        ->and(authDb()->table('book_authors')->where('book', $book)->exists())->toBeFalse();
});

test('an author id beats the name, and an id we hold nobody for is queued, never looked up inline', function () {
    Queue::fake();
    $byId = authAuthor('Authtest Vladimir Lenn', [], ['open_library_ids' => ['OLAUTHTEST1A']]);
    authAuthor('Authtest Wrong Spelling');
    $book = authVerifiedBook('user_verified', 'whatever', [
        // The NAME says someone else; the id is the identity.
        ['name' => 'Authtest Wrong Spelling', 'open_library_author_key' => 'OLAUTHTEST1A'],
        ['name' => 'Authtest Stranger', 'openalex_author_id' => 'A0000000009', 'orcid' => null],
    ]);

    // Stray requests fail the test, so a pass proves no network call was made here.
    $report = app(AuthorLinker::class)->linkFromCanonical($book);

    expect($report['linked'])->toHaveCount(1)
        ->and($report['linked'][0])->toMatchArray(['slug' => $byId->slug, 'via' => 'open_library_id'])
        ->and($report['unknown'])->toHaveCount(1);

    Queue::assertPushed(ResolveBookAuthorsJob::class, fn ($job) => $job->book === $book
        && $job->candidates[0]['ids'] === ['openalex' => 'A0000000009']);
});

test('a dry run reports the same thing and writes nothing', function () {
    Queue::fake();
    authAuthor('Authtest Rosa Luxx');
    $book = authVerifiedBook('auto_version_creation', 'Authtest Rosa Luxx', [
        ['name' => 'Authtest Rosa Luxx', 'openalex_author_id' => null],
        ['name' => 'Authtest Stranger', 'openalex_author_id' => 'A0000000009'],
    ]);

    $report = app(AuthorLinker::class)->linkFromCanonical($book, apply: false, dispatchUnknown: false);

    expect($report['linked'])->toHaveCount(1)
        ->and($report['unknown'])->toHaveCount(1)
        ->and(authDb()->table('book_authors')->where('book', $book)->exists())->toBeFalse();
    Queue::assertNothingPushed();
});

/* ── the author shelf and its /a/ page ───────────────────────────────────── */

test('an author page holds exactly the public, content-bearing books they are the AUTHOR of', function () {
    $linker = app(AuthorLinker::class);
    $author = authAuthor('Authtest Rosa Luxx');
    $translator = authAuthor('Authtest Agnes Schwarz');

    $public = authBook();
    $private = authBook(['visibility' => 'private']);
    $empty = authBook(['has_nodes' => false]);
    foreach ([$public, $private, $empty] as $book) {
        $linker->link($book, $author->id);
    }
    $linker->link($public, $translator->id, 'translator');

    expect(authShelfBooks($author))->toBe([$public])
        // A translator is credited, not listed: no page is minted for a translation alone.
        ->and(AuthorShelf::shelfIdFor($translator->id))->toBeNull();

    // Published → on the page; hidden → off it. The hook is syncBook.
    authDb()->table('library')->where('book', $private)->update(['visibility' => 'public']);
    AuthorShelf::syncBook($private);
    expect(authShelfBooks($author))->toEqualCanonicalizing([$public, $private]);

    authDb()->table('library')->where('book', $public)->update(['visibility' => 'private']);
    AuthorShelf::syncBook($public);
    expect(authShelfBooks($author))->toBe([$private]);

    // Unlinking takes it off too, and reconcile repairs a hand-broken shelf.
    $linker->unlink($private, $author->id);
    expect(authShelfBooks($author))->toBe([]);

    $linker->link($private, $author->id);
    authDb()->table('shelf_items')->where('shelf_id', AuthorShelf::shelfIdFor($author->id))->delete();
    AuthorShelf::reconcile();
    expect(authShelfBooks($author))->toBe([$private]);
});

test('/a/{slug} renders the author, and its search reaches only their books', function () {
    $author = authAuthor('Authtest Rosa Luxx');
    $theirs = authBook(['title' => 'Authtest zebraquartz accumulation']);
    authBook(['title' => 'Authtest zebraquartz by someone else']);
    app(AuthorLinker::class)->link($theirs, $author->id);

    $this->get("/a/{$author->slug}")->assertOk()->assertSee('Authtest Rosa Luxx');

    $archive = authDb()->table('archive_sources')->where('slug', $author->slug)->first();
    expect($archive->kind)->toBe('author')->and($archive->author_id)->toBe($author->id);

    $hits = $this->getJson("/api/public/shelves/{$archive->shelf_id}/search?q=zebraquartz&mode=library")
        ->assertOk()->json('results');
    expect(collect($hits)->pluck('book')->all())->toBe([$theirs]);
});

test('nobody curates an author shelf by hand — not its system owner\'s admin, not an import', function () {
    $author = authAuthor('Authtest Rosa Luxx');
    $shelfId = AuthorShelf::ensureFor($author);
    $other = authBook();

    $admin = $this->loginUser(['is_admin' => true]);
    $this->postJson("/api/shelves/{$shelfId}/items", ['book' => $other])->assertStatus(422);

    // A scrape drop may not target it either.
    $this->postJson('/api/import-batches', [
        'label' => 'Authtest drop', 'source' => 'folder', 'shelf_id' => $shelfId,
        'items' => [['book' => 'authtest_x', 'title' => 'X', 'filename' => 'x.md']],
    ])->assertStatus(422);

    expect(authShelfBooks($author))->toBe([]);
});

test('authors and archives share one /a/ namespace', function () {
    $author = authAuthor('Authtest Rosa Luxx');

    // The author's page row is minted lazily, but the slug is already spoken for.
    expect(AuthorShelf::shelfIdFor($author->id))->toBeNull()
        ->and(app(ShelfArchiveMinter::class)->isAvailable($author->slug))->toBeFalse();

    // And an existing collection archive's slug can never become an author.
    authDb()->table('archive_sources')->insert([
        'id' => (string) Str::uuid(), 'shelf_id' => (string) Str::uuid(), 'slug' => 'authtest-collection',
        'display_name' => 'Authtest Collection', 'created_at' => now(), 'updated_at' => now(),
    ]);
    expect(fn () => app(AuthorRegistry::class)->ensure('authtest-collection', 'Authtest Someone'))
        ->toThrow(\DomainException::class);
});

/* ── auto-creation from Wikidata ─────────────────────────────────────────── */

test('an Open Library author key becomes an author only when Wikidata lists the same key', function () {
    Http::fake([
        'openlibrary.org/authors/OLAUTHTEST7A.json' => Http::response(['remote_ids' => ['wikidata' => 'Q990000001']]),
        'openlibrary.org/authors/OLAUTHTEST8A.json' => Http::response(['remote_ids' => ['wikidata' => 'Q990000002']]),
        'openlibrary.org/authors/OLAUTHTEST9A.json' => Http::response(['remote_ids' => ['wikidata' => 'Q990000003']]),
        'www.wikidata.org/*' => function ($request) {
            return match ($request['ids'] ?? null) {
                'Q990000001' => Http::response(authWikidataEntity('Q990000001', 'Authtest Clara Zett', ['P648' => 'OLAUTHTEST7A', 'P569' => ['time' => '+1857-07-05T00:00:00Z']])),
                // Wikidata's entity names a DIFFERENT Open Library key: the two sides disagree.
                'Q990000002' => Http::response(authWikidataEntity('Q990000002', 'Authtest Mismatch', ['P648' => 'OLSOMEONEELSE'])),
                // Agrees on the key, but is a publishing house, not a person.
                'Q990000003' => Http::response(authWikidataEntity('Q990000003', 'Authtest Press', ['P648' => 'OLAUTHTEST9A'], human: false)),
                default => Http::response(['entities' => []]),
            };
        },
    ]);

    $book = authBook();
    (new ResolveBookAuthorsJob($book, [
        ['name' => 'Zett, Clara', 'position' => 0, 'ids' => ['open_library' => 'OLAUTHTEST7A']],
        ['name' => 'Authtest Mismatch', 'position' => 1, 'ids' => ['open_library' => 'OLAUTHTEST8A']],
        ['name' => 'Authtest Press', 'position' => 2, 'ids' => ['open_library' => 'OLAUTHTEST9A']],
    ]))->handle(app(AuthorResolver::class), app(AuthorLinker::class));

    $created = authDb()->table('authors')->where('wikidata_qid', 'Q990000001')->first();
    expect($created)->not->toBeNull()
        ->and($created->slug)->toBe('authtest-clara-zett')
        ->and($created->born)->toBe(1857)
        ->and(json_decode($created->open_library_ids, true))->toBe(['OLAUTHTEST7A'])
        ->and(authDb()->table('authors')->whereIn('wikidata_qid', ['Q990000002', 'Q990000003'])->exists())->toBeFalse();

    // Linked, and — the book being public with content — on a freshly minted page.
    expect(authDb()->table('book_authors')->where('book', $book)->pluck('author_id')->all())->toBe([$created->id])
        ->and(authShelfBooks($created))->toBe([$book]);
    $this->get('/a/authtest-clara-zett')->assertOk();

    // A second book by the same key finds the author we now hold — no new row, no lookup.
    Http::fake(fn () => Http::response('should not be called', 500));
    $second = app(AuthorResolver::class)->resolve(['name' => null, 'ids' => ['open_library' => 'OLAUTHTEST7A']]);
    expect($second['status'])->toBe('existing')->and($second['author']->id)->toBe($created->id);
});

test('an auto-created author whose slug is taken gets the birth year, and a failed lookup creates nothing', function () {
    authAuthor('Authtest Placeholder');
    authDb()->table('authors')->where('display_name', 'Authtest Placeholder')->update(['slug' => 'authtest-john-smith']);

    Http::fake([
        'www.wikidata.org/*' => function ($request) {
            if (($request['list'] ?? null) === 'search') {
                return str_contains((string) $request['srsearch'], 'A0000000042')
                    ? Http::response(['query' => ['search' => [['title' => 'Q990000010']]]])
                    : Http::response('upstream down', 503);
            }

            return Http::response(authWikidataEntity('Q990000010', 'Authtest John Smith', ['P10283' => 'A0000000042', 'P569' => ['time' => '+1950-01-01T00:00:00Z']]));
        },
    ]);

    $resolver = app(AuthorResolver::class);

    $dry = $resolver->resolve(['name' => 'J. Smith', 'ids' => ['openalex' => 'A0000000042']], create: false);
    expect($dry['status'])->toBe('would_create')
        ->and(authDb()->table('authors')->where('wikidata_qid', 'Q990000010')->exists())->toBeFalse();

    $made = $resolver->resolve(['name' => 'J. Smith', 'ids' => ['openalex' => 'A0000000042']]);
    expect($made['status'])->toBe('created')->and($made['author']->slug)->toBe('authtest-john-smith-1950');
    // The work's own spelling is not taught to the author record.
    expect(json_decode($made['author']->aliases, true))->not->toContain('J. Smith');

    $failed = $resolver->resolve(['name' => 'Nobody', 'ids' => ['orcid' => '0000-0000-0000-0001']]);
    expect($failed['status'])->toBe('lookup_failed')->and($failed['author'])->toBeNull();
});

/* ── the scrape manifest's authors field ─────────────────────────────────── */

test('an admin\'s manifest authors link the book at import; anyone else\'s are ignored', function () {
    Queue::fake();
    $author = authAuthor('Authtest Vladimir Lenn');
    $payload = fn (string $book) => [
        'book' => $book, 'title' => 'Authtest Imperialism', 'author' => 'V. I. Lenn',
        'authors_json' => json_encode([
            ['name' => 'Authtest Vladimir Lenn', 'role' => 'author', 'slug' => $author->slug],
            // Created on the spot: a scrape carries its own author map (no QID → no network).
            ['name' => 'Authtest Tim Delaney', 'role' => 'translator', 'slug' => 'authtest-delaney'],
            ['name' => 'Authtest Nameless', 'role' => 'author'],                 // identifies nobody
            ['name' => 'Authtest Bad Role', 'role' => 'owner', 'slug' => 'authtest-bad'],
        ]),
        'markdown_file' => [UploadedFile::fake()->createWithContent('n.md', "# Hello\n\nBody.")],
    ];

    $this->loginUser(['is_admin' => true]);
    $adminBook = 'authtest_' . Str::lower(Str::random(10));
    $imported = $this->post('/import-file', $payload($adminBook), ['Accept' => 'application/json'])
        ->assertStatus(200)->json('library');

    $links = authDb()->table('book_authors')->join('authors', 'authors.id', '=', 'book_authors.author_id')
        ->where('book', $adminBook)->orderBy('position')->get(['authors.slug', 'role', 'source']);
    expect($links->map(fn ($l) => [$l->slug, $l->role, $l->source])->all())->toBe([
        [$author->slug, 'author', 'manifest'],
        ['authtest-delaney', 'translator', 'manifest'],
    ])->and(authDb()->table('authors')->whereIn('slug', ['authtest-bad'])->exists())->toBeFalse();

    // Born private, so not on the page yet; the printed credit is what was sent.
    expect(authShelfBooks($author))->toBe([])
        ->and($imported['author'])->toBe('V. I. Lenn')
        ->and($imported['visibility'])->toBe('private');

    $this->loginUser(['is_admin' => false]);
    $userBook = 'authtest_' . Str::lower(Str::random(10));
    $this->post('/import-file', $payload($userBook), ['Accept' => 'application/json'])->assertStatus(200);
    expect(authDb()->table('book_authors')->where('book', $userBook)->exists())->toBeFalse();
});

/* ── reviewing what we already hold ──────────────────────────────────────── */

test('the canonical-id backfill writes Open Library author keys only on --apply', function () {
    $id = (string) Str::uuid();
    authDb()->table('canonical_source')->insert([
        'id' => $id, 'title' => 'Authtest Capital', 'author' => 'Authtest Karl Marxx',
        'open_library_key' => '/works/OLAUTHTEST1W', 'foundation_source' => 'open_library_ingest',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    Http::fake(['openlibrary.org/search.json*' => Http::response(['docs' => [[
        'key' => '/works/OLAUTHTEST1W', 'author_name' => ['Authtest Karl Marxx'], 'author_key' => ['OLAUTHTEST5A'],
    ]]])]);

    $this->artisan('authors:backfill-canonical-ids')->assertExitCode(0);
    expect(authDb()->table('canonical_source')->where('id', $id)->value('authorships'))->toBeNull();

    $this->artisan('authors:backfill-canonical-ids', ['--apply' => true])->assertExitCode(0);
    $stored = json_decode(authDb()->table('canonical_source')->where('id', $id)->value('authorships'), true);
    expect($stored)->toBe([['name' => 'Authtest Karl Marxx', 'open_library_author_key' => 'OLAUTHTEST5A']])
        // The author STRING is not this command's to change.
        ->and(authDb()->table('canonical_source')->where('id', $id)->value('author'))->toBe('Authtest Karl Marxx');
});

test('the backfill stops instead of marching on against a dead source', function () {
    for ($i = 0; $i < 7; $i++) {
        authDb()->table('canonical_source')->insert([
            'id' => (string) Str::uuid(), 'title' => "Authtest Work {$i}", 'author' => 'Authtest Someone',
            'open_library_key' => "/works/OLAUTHTEST{$i}W", 'foundation_source' => 'open_library_ingest',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
    Http::fake(['openlibrary.org/*' => Http::response('down', 503)]);

    $this->artisan('authors:backfill-canonical-ids', ['--apply' => true])->assertExitCode(2);
    Http::assertSentCount(5);
    expect(authDb()->table('canonical_source')->whereNotNull('authorships')->exists())->toBeFalse();
});

test('authors:link-verified is a dry run by default and says why a book stayed unlinked', function () {
    Queue::fake();
    $author = authAuthor('Authtest Rosa Luxx');
    $linked = authVerifiedBook('user_verified', 'Authtest Rosa Luxx');
    authVerifiedBook('user_verified', 'Authtest Unheard Of');
    authVerifiedBook('openalex_title_full', 'Authtest Rosa Luxx');

    $this->artisan('authors:link-verified')
        ->expectsOutputToContain('by an automated match (left alone)')
        ->expectsOutputToContain("→  {$author->slug}  (by name)")
        ->expectsOutputToContain('Authtest Unheard Of')
        ->assertExitCode(0);
    expect(authDb()->table('book_authors')->where('book', $linked)->exists())->toBeFalse();

    $this->artisan('authors:link-verified', ['--apply' => true])->assertExitCode(0);
    expect(authDb()->table('book_authors')->where('book', $linked)->value('author_id'))->toBe($author->id)
        ->and(authShelfBooks($author))->toBe([$linked]);
});

test('verifying a source links its authors, with the Wikidata lookup queued rather than run in the request', function () {
    Queue::fake();
    $author = authAuthor('Authtest Rosa Luxx');
    $book = authBook(['visibility' => 'private']);
    $library = \App\Models\PgLibrary::on('pgsql_admin')->where('book', $book)->first();

    app(\App\Services\CanonicalSourceMatcher::class)->verifyAndLink($library, [
        'title' => 'Authtest Accumulation', 'author' => 'Authtest Rosa Luxx; Authtest Stranger', 'source' => 'openlibrary',
        'open_library_key' => '/works/OLAUTHTEST3W', 'year' => 1913,
        'authorships' => [
            ['name' => 'Authtest Rosa Luxx', 'open_library_author_key' => 'OLAUTHTESTRL'],
            ['name' => 'Authtest Stranger', 'open_library_author_key' => 'OLAUTHTESTST'],
        ],
    ], 'authtest_user');

    // Known by spelling → linked now; both ids are unknown to us → one queued lookup for the stranger.
    expect(authDb()->table('book_authors')->where('book', $book)->pluck('author_id')->all())->toBe([$author->id]);
    Queue::assertPushed(ResolveBookAuthorsJob::class, fn ($job) => $job->book === $book
        && count($job->candidates) === 1
        && $job->candidates[0]['ids'] === ['open_library' => 'OLAUTHTESTST']);
});

/* ── the page's credit line ──────────────────────────────────────────────── */

test('an author page credits the archives its texts came from and the users who brought them in', function () {
    $author = authAuthor('Authtest Rosa Luxx');
    authDb()->table('authors')->where('id', $author->id)->update(['description' => 'authtest economist (1871–1919)', 'born' => 1871, 'died' => 1919]);
    $author = authDb()->table('authors')->where('id', $author->id)->first();
    $linker = app(AuthorLinker::class);

    $scraped = fn () => authBook(['creator' => 'authtest_dropper', 'url' => 'https://www.marxists.org/archive/x/index.htm',
        'raw_json' => json_encode(['scrape_site' => 'marxists.org'])]);
    foreach ([$scraped(), $scraped(), authBook(['creator' => 'authtest_reader', 'url' => 'https://www.gutenberg.org/ebooks/61'])] as $book) {
        $linker->link($book, $author->id);
    }
    // A system version (no human contributor; a DOI is an identifier, not a place) and a
    // PRIVATE upload (its owner is not named for a text they did not publish).
    $linker->link(authBook(['creator' => \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR, 'url' => 'https://doi.org/10.1/x']), $author->id);
    $linker->link(authBook(['creator' => 'authtest_private_person', 'visibility' => 'private']), $author->id);

    $sources = app(\App\Services\Authors\AuthorPageSources::class)->forShelf(AuthorShelf::shelfIdFor($author->id));
    expect(array_map(fn ($l) => [$l['label'], $l['count']], $sources['locations']))->toBe([['marxists.org', 2], ['Project Gutenberg', 1]])
        ->and(array_map(fn ($c) => [$c['name'], $c['count']], $sources['contributors']))->toBe([['authtest_dropper', 2], ['authtest_reader', 1]]);

    $html = $this->get("/a/{$author->slug}")->assertOk()
        ->assertSee('Texts from')->assertSee('Project Gutenberg')
        ->assertSee('/u/authtest_dropper', false)
        ->assertDontSee('authtest_private_person')
        ->getContent();

    // The hero line is the author's name and dates — the HEADING's own text, with no <p>
    // inside it (a nested <p> takes body-paragraph colour: white on the hero in dark mode) —
    // and never Wikidata's one-line description, which is somebody's contestable summary.
    expect($html)->toContain('<h1 class="mega">Authtest Rosa Luxx (1871–1919)</h1>')
        ->not->toContain('authtest economist')
        // Hyperlit writes no biography and points at none: name, dates, sources.
        ->not->toContain('Wikipedia')
        ->not->toContain('Wikidata');

    // A page still carrying an EARLIER generated blurb is brought up to date; copy a
    // maintainer wrote is not touched.
    authDb()->table('archive_sources')->where('slug', $author->slug)->update(['about' => '<p>Authtest economist (1871–1919)</p>']);
    AuthorShelf::refreshAbout();
    expect(authDb()->table('archive_sources')->where('slug', $author->slug)->value('about'))->toBe('Authtest Rosa Luxx (1871–1919)');

    authDb()->table('archive_sources')->where('slug', $author->slug)->update(['about' => 'Authtest hand-written blurb.']);
    AuthorShelf::refreshAbout();
    expect(authDb()->table('archive_sources')->where('slug', $author->slug)->value('about'))->toBe('Authtest hand-written blurb.');
});
