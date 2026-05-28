<?php

/**
 * Citation modal search — locks the post-PR4/5/6 contract:
 *   - hybrid local search (canonical UNION orphan library) with discriminator row_type
 *   - external lookup fires only on public scope + thin results + first page
 *   - external results write to canonical_source ONLY, never to library
 *   - repeat searches with the same query short-circuit via cache
 *   - scope validation mirrors AiBrain (locked by AiBrainScopeValidationTest)
 *   - graceful degradation when external APIs error
 *
 * Inserts use pgsql_admin to bypass RLS (the same pattern as RetrievalScopeTest).
 */

use App\Models\User;
use App\Services\CitationSearchService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

function citationDb()
{
    return DB::connection('pgsql_admin');
}

beforeEach(function () {
    // pgsql_admin isn't covered by RefreshDatabase — wipe by prefix.
    citationDb()->table('bibliography')->whereRaw("book LIKE 'book_citetest_%'")->delete();
    citationDb()->table('shelf_items')->whereRaw("book LIKE 'book_citetest_%'")->delete();
    citationDb()->table('library')->whereRaw("book LIKE 'book_citetest_%'")->delete();
    citationDb()->table('library')->whereRaw("title LIKE 'CiteTest %'")->delete();
    citationDb()->table('shelves')->whereRaw("slug LIKE 'cite-test-shelf-%'")->delete();
    citationDb()->table('users')->whereRaw("email LIKE '%@citetest.test'")->delete();
    citationDb()->table('canonical_source')->whereRaw("title LIKE 'CiteTest %'")->delete();

    // Fixture canonicals are dedup'd by openalex_id / open_library_key inside
    // CanonicalSourceMatcher, so a leftover row from a prior run would mask
    // legitimate "new ingest" assertions. Scrub them in two steps to avoid
    // any orWhereIn grouping ambiguity.
    citationDb()->table('canonical_source')->where('openalex_id', 'W_FIXTURE_OA_1')->delete();
    citationDb()->table('canonical_source')->where('open_library_key', '/works/OL_FIXTURE_MARX')->delete();

    // Don't let prior tests' external-lookup cache short-circuit a new run.
    Cache::flush();

    Http::preventStrayRequests();
});

function citationSeedLibrary(array $opts): string
{
    $book = $opts['book'] ?? ('book_citetest_' . Str::random(8));
    citationDb()->table('library')->insert([
        'book'                => $book,
        'title'               => $opts['title'] ?? 'CiteTest Library Book',
        'author'              => $opts['author'] ?? 'CiteTest Author',
        'year'                => $opts['year'] ?? '2024',
        'bibtex'              => $opts['bibtex'] ?? null,
        'creator'             => $opts['creator'] ?? null,
        'visibility'          => $opts['visibility'] ?? 'public',
        'listed'              => $opts['listed'] ?? true,
        'type'                => $opts['type'] ?? 'book',
        'has_nodes'           => $opts['has_nodes'] ?? true,
        'canonical_source_id' => $opts['canonical_source_id'] ?? null,
        'raw_json'            => '[]',
        'timestamp'           => 0,
    ]);
    return $book;
}

function citationSeedCanonical(array $opts): string
{
    $id = $opts['id'] ?? (string) Str::uuid();
    citationDb()->table('canonical_source')->insert([
        'id'                     => $id,
        'title'                  => $opts['title'] ?? 'CiteTest Canonical Work',
        'author'                 => $opts['author'] ?? 'CiteTest Author',
        'year'                   => $opts['year'] ?? 2024,
        'journal'                => $opts['journal'] ?? null,
        'publisher'              => $opts['publisher'] ?? null,
        'abstract'               => $opts['abstract'] ?? null,
        'openalex_id'            => $opts['openalex_id'] ?? null,
        'doi'                    => $opts['doi'] ?? null,
        'open_library_key'       => $opts['open_library_key'] ?? null,
        'author_version_book'    => $opts['author_version_book'] ?? null,
        'publisher_version_book' => $opts['publisher_version_book'] ?? null,
        'commons_version_book'   => $opts['commons_version_book'] ?? null,
        'auto_version_book'      => $opts['auto_version_book'] ?? null,
        'foundation_source'      => $opts['foundation_source'] ?? 'test',
        'created_at'             => now(),
        'updated_at'             => now(),
    ]);
    return $id;
}

function citationSeedUser(string $name): User
{
    $unique = $name . '_' . Str::random(6);
    $id = citationDb()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@citetest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

/**
 * Set the postgres session vars that the RLS policies on shelves/shelf_items
 * gate against. Mirrors what SetDatabaseSessionContext middleware does on real
 * HTTP requests — without this, JOINs on shelf_items silently return 0 rows.
 */
function citationActAs(User $user): void
{
    DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, true)", [$user->user_token ?? '']);
}

function citationSeedShelf(string $creator, array $books = []): string
{
    $id = (string) Str::uuid();
    $rand = Str::random(6);
    citationDb()->table('shelves')->insert([
        'id'         => $id,
        'creator'    => $creator,
        'name'       => 'CiteTest Shelf ' . $rand,
        'slug'       => 'cite-test-shelf-' . strtolower($rand),
        'visibility' => 'private',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    foreach ($books as $b) {
        citationDb()->table('shelf_items')->insert([
            'shelf_id' => $id,
            'book'     => $b,
            'added_at' => now(),
        ]);
    }
    return $id;
}

function citationFixtureOpenAlexMarxCapital(): array
{
    return json_decode(file_get_contents(base_path('tests/fixtures/citations/openalex-works-marx-capital.json')), true);
}

function citationFixtureOpenLibraryMarxCapital(): array
{
    return json_decode(file_get_contents(base_path('tests/fixtures/citations/openlibrary-marx-capital.json')), true);
}

// =============================================================================
// SearchService::searchForCitations — hybrid query
// =============================================================================

test('hybrid search returns canonical rows with row_type discriminator', function () {
    citationSeedCanonical(['title' => 'CiteTest hybrid canonical alpha', 'author' => 'Hybrid Alpha']);

    Http::fake(); // No external calls expected for this assertion

    $svc = app(CitationSearchService::class);
    $result = $svc->search('CiteTest hybrid', 15, 0, 'public');

    expect($result['results'])->not->toBeEmpty();
    $canonical = collect($result['results'])->firstWhere('row_type', 'canonical');
    expect($canonical)->not->toBeNull()
        ->and($canonical->title)->toContain('CiteTest hybrid canonical');
});

test('hybrid search includes orphan library rows when no canonical link', function () {
    $book = citationSeedLibrary([
        'title'               => 'CiteTest orphan library row',
        'author'              => 'Orphan Author',
        'canonical_source_id' => null,
        'has_nodes'           => true,
        'visibility'          => 'public',
        'listed'              => true,
    ]);

    Http::fake();

    $svc = app(CitationSearchService::class);
    $result = $svc->search('CiteTest orphan', 15, 0, 'public');

    $libraryRow = collect($result['results'])->firstWhere('row_type', 'library');
    expect($libraryRow)->not->toBeNull()
        ->and($libraryRow->id)->toBe($book);
});

// =============================================================================
// Privacy contract — private library rows must NEVER appear in citation search
// regardless of scope (mirror of RetrievalScopeTest's AiBrain contract).
// =============================================================================

test('public scope: private library books are excluded', function () {
    $public  = citationSeedLibrary(['title' => 'CiteTest privacy public', 'visibility' => 'public', 'listed' => true]);
    $private = citationSeedLibrary(['title' => 'CiteTest privacy private', 'visibility' => 'private', 'listed' => false]);

    Http::fake();
    $svc = app(CitationSearchService::class);
    $r = $svc->search('CiteTest privacy', 15, 0, 'public');

    $ids = array_column($r['results'], 'id');
    expect($ids)->toContain($public)
        ->and($ids)->not->toContain($private); // private must never appear in public scope
});

test('mine scope: includes caller’s own private books (attribution-first contract)', function () {
    $me    = citationSeedUser('cite_priv_me');
    $other = citationSeedUser('cite_priv_other');

    $myPublic  = citationSeedLibrary(['title' => 'CiteTest mine pub',  'creator' => $me->name,    'visibility' => 'public',  'listed' => true]);
    $myPrivate = citationSeedLibrary(['title' => 'CiteTest mine prv',  'creator' => $me->name,    'visibility' => 'private', 'listed' => false]);
    $foreignPub = citationSeedLibrary(['title' => 'CiteTest mine forp', 'creator' => $other->name, 'visibility' => 'public',  'listed' => true]);
    $foreignPrv = citationSeedLibrary(['title' => 'CiteTest mine forq', 'creator' => $other->name, 'visibility' => 'private', 'listed' => false]);

    // RLS requires session vars to surface the caller's own private rows
    citationActAs($me);

    Http::fake();
    $svc = app(CitationSearchService::class);
    $r = $svc->search('CiteTest mine', 15, 0, 'mine', null, $me->name);

    $ids = array_column($r['results'], 'id');
    expect($ids)->toContain($myPublic)        // user's own public book
        ->and($ids)->toContain($myPrivate)    // user's own private book — must be citable
        ->and($ids)->not->toContain($foreignPub)  // another user's public book
        ->and($ids)->not->toContain($foreignPrv); // another user's private book
});

test('is_private flag is set on caller’s private library row in mine scope', function () {
    $me = citationSeedUser('cite_lock_mine');
    $myPrivate = citationSeedLibrary([
        'title'      => 'CiteTest lockmine prv',
        'creator'    => $me->name,
        'visibility' => 'private',
        'listed'     => false,
    ]);
    $myPublic = citationSeedLibrary([
        'title'      => 'CiteTest lockmine pub',
        'creator'    => $me->name,
        'visibility' => 'public',
        'listed'     => true,
    ]);
    citationActAs($me);

    Http::fake();
    $r = app(CitationSearchService::class)->search('CiteTest lockmine', 15, 0, 'mine', null, $me->name);

    $byId = collect($r['results'])->keyBy('id');
    expect($byId[$myPrivate]->is_private)->toBeTrue('private row must carry is_private')
        ->and($byId[$myPublic]->is_private)->toBeFalse('public row must not carry is_private');
});

test('is_private flag follows canonical → best version (private when version is private)', function () {
    // Seed a canonical, link a private library version as the author_version_book
    $me = citationSeedUser('cite_lock_canonical');
    $privateVersion = citationSeedLibrary([
        'title'      => 'CiteTest lockcan private version',
        'creator'    => $me->name,
        'visibility' => 'private',
        'listed'     => false,
    ]);
    $canonicalId = citationSeedCanonical([
        'title'               => 'CiteTest lockcan canonical work',
        'author_version_book' => $privateVersion,
    ]);
    // Link the version to the canonical (matcher would do this in real life)
    citationDb()->table('library')->where('book', $privateVersion)->update(['canonical_source_id' => $canonicalId]);
    citationActAs($me);

    Http::fake();
    $r = app(CitationSearchService::class)->search('CiteTest lockcan', 15, 0, 'public');

    $canonicalRow = collect($r['results'])->firstWhere('row_type', 'canonical');
    expect($canonicalRow)->not->toBeNull()
        ->and($canonicalRow->is_private)->toBeTrue();
});

test('mine scope: caller’s deleted books are excluded', function () {
    $me = citationSeedUser('cite_priv_del');
    $live    = citationSeedLibrary(['title' => 'CiteTest live one',    'creator' => $me->name, 'visibility' => 'public']);
    $deleted = citationSeedLibrary(['title' => 'CiteTest deleted one', 'creator' => $me->name, 'visibility' => 'deleted']);

    Http::fake();
    $r = app(CitationSearchService::class)->search('CiteTest one', 15, 0, 'mine', null, $me->name);

    $ids = array_column($r['results'], 'id');
    expect($ids)->toContain($live)->and($ids)->not->toContain($deleted);
});

test('shelf scope: public + caller’s own private; excludes others’ private and out-of-shelf', function () {
    $owner   = citationSeedUser('cite_priv_shelfowner');
    $other   = citationSeedUser('cite_priv_shelfother');

    $publicInShelf       = citationSeedLibrary(['title' => 'CiteTest shelf pub',  'visibility' => 'public',  'listed' => true]);
    $myPrivateInShelf    = citationSeedLibrary(['title' => 'CiteTest shelf myp',  'visibility' => 'private', 'listed' => false, 'creator' => $owner->name]);
    $otherPrivateInShelf = citationSeedLibrary(['title' => 'CiteTest shelf orp',  'visibility' => 'private', 'listed' => false, 'creator' => $other->name]);
    $outOfShelf          = citationSeedLibrary(['title' => 'CiteTest shelf out',  'visibility' => 'public',  'listed' => true]);

    $shelfId = citationSeedShelf($owner->name, [$publicInShelf, $myPrivateInShelf, $otherPrivateInShelf]);
    citationActAs($owner);   // shelf_items has RLS — without this the JOIN returns 0 rows

    Http::fake();
    $r = app(CitationSearchService::class)->search('CiteTest shelf', 15, 0, 'shelf', $shelfId, $owner->name);

    $ids = array_column($r['results'], 'id');
    expect($ids)->toContain($publicInShelf)            // public in-shelf — citable
        ->and($ids)->toContain($myPrivateInShelf)      // owner's own private in their shelf — citable
        ->and($ids)->not->toContain($otherPrivateInShelf)  // someone else's private — never
        ->and($ids)->not->toContain($outOfShelf);      // out-of-shelf book
});

test('shelf scope with empty shelf returns nothing', function () {
    $owner = citationSeedUser('cite_priv_empty');
    citationActAs($owner);
    citationSeedLibrary(['title' => 'CiteTest empty would match', 'visibility' => 'public', 'listed' => true]);
    $shelfId = citationSeedShelf($owner->name, []);

    Http::fake();
    $r = app(CitationSearchService::class)->search('CiteTest empty', 15, 0, 'shelf', $shelfId, $owner->name);

    expect($r['results'])->toBe([]);
});

test('unlisted public books are excluded from public-scope citation search', function () {
    // The PR6 backfill cleared OpenAlex stubs, so the `has_nodes=true` guard is
    // gone — but the `listed=true` guard in the public branch still matters for
    // private-imported books the user marked public-but-unlisted.
    $listed   = citationSeedLibrary(['title' => 'CiteTest unlisted L', 'visibility' => 'public', 'listed' => true]);
    $unlisted = citationSeedLibrary(['title' => 'CiteTest unlisted U', 'visibility' => 'public', 'listed' => false]);

    Http::fake();
    $svc = app(CitationSearchService::class);
    $r = $svc->search('CiteTest unlisted', 15, 0, 'public');

    $ids = array_column($r['results'], 'id');
    expect($ids)->toContain($listed)
        ->and($ids)->not->toContain($unlisted); // unlisted public not in public scope
});

// =============================================================================
// Scope-bound canonical results — bug regression: clicking "shelf" with 2 books
// must NOT return canonicals unrelated to that shelf (the leak the user hit).
// =============================================================================

test('shelf scope: never surfaces canonicals — only the exact library versions in the shelf', function () {
    // Shelf is explicit user curation. The user picked these specific versions
    // to be citable — bypass canonical hops entirely. This locks the "I picked
    // a 2-book shelf and got 50 canonical leaks" bug.
    $owner = citationSeedUser('cite_canscope_shelf');

    // Canonicalized library row IN the shelf — must appear as a LIBRARY row,
    // not via its canonical.
    $inShelfBook = citationSeedLibrary([
        'title'      => 'CiteTest canscope inshelf version',
        'visibility' => 'public', 'listed' => true,
    ]);
    $inShelfCanonical = citationSeedCanonical([
        'title'               => 'CiteTest canscope inshelf canonical',
        'author_version_book' => $inShelfBook,
    ]);
    citationDb()->table('library')->where('book', $inShelfBook)->update(['canonical_source_id' => $inShelfCanonical]);

    // Global canonical matching the same query but with NO version in the shelf
    // — used to leak; must NOT appear now.
    $leakCanonical = citationSeedCanonical(['title' => 'CiteTest canscope GLOBAL leak canonical']);

    // Canonical with a real version, but NOT in this shelf — must NOT appear.
    $outBook = citationSeedLibrary([
        'title'      => 'CiteTest canscope outside version',
        'visibility' => 'public', 'listed' => true,
    ]);
    $outCanonical = citationSeedCanonical([
        'title'               => 'CiteTest canscope outside canonical',
        'author_version_book' => $outBook,
    ]);
    citationDb()->table('library')->where('book', $outBook)->update(['canonical_source_id' => $outCanonical]);

    $shelfId = citationSeedShelf($owner->name, [$inShelfBook]);
    citationActAs($owner);

    Http::fake();
    $r = app(CitationSearchService::class)->search('CiteTest canscope', 15, 0, 'shelf', $shelfId, $owner->name);

    $ids = array_column($r['results'], 'id');
    $rowTypes = array_column($r['results'], 'row_type');

    expect($ids)->toContain($inShelfBook)              // shelved library row by book id
        ->and($ids)->not->toContain($inShelfCanonical) // canonical id never appears in shelf
        ->and($ids)->not->toContain($leakCanonical)    // global canonical can't leak
        ->and($ids)->not->toContain($outCanonical)     // out-of-shelf canonical can't leak
        ->and($rowTypes)->not->toContain('canonical')  // no canonical row_type in shelf
        ->and(count($ids))->toBe(1);                   // exactly the 1 shelved version
});

test('mine scope canonicals: only those whose linked library version is owned by caller', function () {
    $me    = citationSeedUser('cite_canscope_mine');
    $other = citationSeedUser('cite_canscope_other');

    // Canonical I own (linked version is mine)
    $myBook = citationSeedLibrary([
        'title'      => 'CiteTest canmine mine version',
        'creator'    => $me->name, 'visibility' => 'public', 'listed' => true,
    ]);
    $myCanonical = citationSeedCanonical([
        'title'               => 'CiteTest canmine mine canonical',
        'author_version_book' => $myBook,
    ]);
    citationDb()->table('library')->where('book', $myBook)->update(['canonical_source_id' => $myCanonical]);

    // Global canonical (no version anywhere)
    citationSeedCanonical(['title' => 'CiteTest canmine GLOBAL canonical no version']);

    // Canonical with a version owned by someone else
    $otherBook = citationSeedLibrary([
        'title'      => 'CiteTest canmine other version',
        'creator'    => $other->name, 'visibility' => 'public', 'listed' => true,
    ]);
    $otherCanonical = citationSeedCanonical([
        'title'               => 'CiteTest canmine other canonical',
        'author_version_book' => $otherBook,
    ]);
    citationDb()->table('library')->where('book', $otherBook)->update(['canonical_source_id' => $otherCanonical]);

    citationActAs($me);

    Http::fake();
    $r = app(CitationSearchService::class)->search('CiteTest canmine', 15, 0, 'mine', null, $me->name);

    $ids = array_column($r['results'], 'id');
    expect($ids)->toContain($myCanonical)
        ->and($ids)->not->toContain($otherCanonical)
        ->and(count(array_filter($r['results'], fn($r) => $r->row_type === 'canonical')))->toBe(1,
            'mine scope must surface only canonicals whose version is owned by the caller');
});

test('canonical-only results are dropped from mine/shelf scope (no version → not owned/shelved)', function () {
    $owner = citationSeedUser('cite_canonly');

    // Canonical-only (no library version anywhere)
    citationSeedCanonical(['title' => 'CiteTest canonlyleak only']);

    // Also seed one with a version in the shelf so the search returns SOMETHING
    $shelvedBook = citationSeedLibrary([
        'title'      => 'CiteTest canonlyleak version',
        'visibility' => 'public', 'listed' => true,
    ]);
    $shelvedCanonical = citationSeedCanonical([
        'title'               => 'CiteTest canonlyleak canonical with version',
        'author_version_book' => $shelvedBook,
    ]);
    citationDb()->table('library')->where('book', $shelvedBook)->update(['canonical_source_id' => $shelvedCanonical]);

    $shelfId = citationSeedShelf($owner->name, [$shelvedBook]);
    citationActAs($owner);

    Http::fake();
    $shelfRes = app(CitationSearchService::class)->search('CiteTest canonlyleak', 15, 0, 'shelf', $shelfId, $owner->name);
    $mineRes  = app(CitationSearchService::class)->search('CiteTest canonlyleak', 15, 0, 'mine', null, $owner->name);

    foreach ([$shelfRes, $mineRes] as $r) {
        $sources = array_column($r['results'], 'source');
        expect($sources)->not->toContain('canonical-only',
            'canonical-only rows must never appear in scoped search — they have no version that could be owned/shelved');
    }
});

// =============================================================================
// External lookup gating
// =============================================================================

test('external APIs not called on mine scope', function () {
    Http::fake([
        '*' => Http::response(['results' => []], 200),
    ]);

    $svc = app(CitationSearchService::class);
    $svc->search('something with no library hits at all xyz', 15, 0, 'mine', null, 'someone');

    Http::assertNothingSent();
});

test('external APIs not called on shelf scope', function () {
    $user = citationSeedUser('cite_shelf');
    $shelfId = citationSeedShelf($user->name);

    Http::fake([
        '*' => Http::response(['results' => []], 200),
    ]);

    $svc = app(CitationSearchService::class);
    $svc->search('something with no library hits at all xyz', 15, 0, 'shelf', $shelfId, $user->name);

    Http::assertNothingSent();
});

test('external APIs not called on subsequent page (offset > 0)', function () {
    Http::fake([
        '*' => Http::response(['results' => []], 200),
    ]);

    $svc = app(CitationSearchService::class);
    $svc->search('zzzpaginationtest', 15, 15, 'public');

    Http::assertNothingSent();
});

test('external APIs fire on public scope + offset=0 + thin local results', function () {
    Http::fake([
        'api.openalex.org/*'   => Http::response(citationFixtureOpenAlexMarxCapital(), 200),
        'openlibrary.org/*'    => Http::response(citationFixtureOpenLibraryMarxCapital(), 200),
    ]);

    $svc = app(CitationSearchService::class);
    $r = $svc->search('CiteTest_unique_query_marx_' . Str::random(6), 15, 0, 'public');

    Http::assertSent(fn ($req) => str_contains($req->url(), 'api.openalex.org/works'));
    Http::assertSent(fn ($req) => str_contains($req->url(), 'openlibrary.org/search.json'));
});

// =============================================================================
// Canonical-only ingest — must NOT write to library
// =============================================================================

test('external results are ingested into canonical_source only, never library', function () {
    Http::fake([
        'api.openalex.org/*'   => Http::response(citationFixtureOpenAlexMarxCapital(), 200),
        'openlibrary.org/*'    => Http::response(citationFixtureOpenLibraryMarxCapital(), 200),
    ]);

    // Reads must use the SAME connection the writes go through (default `pgsql`),
    // not pgsql_admin — RefreshDatabase wraps pgsql in a per-test transaction,
    // and a separate connection won't see in-flight uncommitted inserts.
    $libBefore = DB::table('library')->count();
    $canBefore = DB::table('canonical_source')->count();

    $svc = app(CitationSearchService::class);
    $svc->search('CiteTest_uniqstring_' . Str::random(6), 15, 0, 'public');

    expect(DB::table('library')->count())->toBe($libBefore, 'library row count must not change')
        ->and(DB::table('canonical_source')->count())->toBeGreaterThan($canBefore, 'canonical_source count must grow');
});

test('canonical ingest is idempotent across repeat searches', function () {
    Http::fake([
        'api.openalex.org/*'   => Http::response(citationFixtureOpenAlexMarxCapital(), 200),
        'openlibrary.org/*'    => Http::response(citationFixtureOpenLibraryMarxCapital(), 200),
    ]);

    $query = 'CiteTest_idem_' . Str::random(6);
    $svc = app(CitationSearchService::class);

    $svc->search($query, 15, 0, 'public');
    $countAfterFirst = DB::table('canonical_source')->count();

    // Bust the in-memory cache so a second call definitely fires external.
    Cache::flush();
    $svc->search($query, 15, 0, 'public');
    $countAfterSecond = DB::table('canonical_source')->count();

    expect($countAfterSecond)->toBe($countAfterFirst, 'repeat ingest must not create duplicate canonicals');
});

test('cached query short-circuits external lookup within TTL', function () {
    Http::fake([
        'api.openalex.org/*'   => Http::response(citationFixtureOpenAlexMarxCapital(), 200),
        'openlibrary.org/*'    => Http::response(citationFixtureOpenLibraryMarxCapital(), 200),
    ]);

    $query = 'CiteTest_cache_' . Str::random(6);
    $svc = app(CitationSearchService::class);

    $svc->search($query, 15, 0, 'public');
    $svc->search($query, 15, 0, 'public');

    // First call hit both APIs once; second call hit zero.
    Http::assertSentCount(2); // OpenAlex + Open Library, once each
});

// =============================================================================
// Controller validation contract (mirrors AiBrainScopeValidationTest)
// =============================================================================

test('controller rejects sourceScope=all with 422', function () {
    $this->getJson('/api/search/combined?q=anything&sourceScope=all')
        ->assertStatus(422)
        ->assertJsonPath('success', false);
});

test('controller rejects shelf without shelfId with 422', function () {
    $this->getJson('/api/search/combined?q=anything&sourceScope=shelf')
        ->assertStatus(422);
});

test('controller rejects non-uuid shelfId with 422', function () {
    $this->getJson('/api/search/combined?q=anything&sourceScope=shelf&shelfId=not-a-uuid')
        ->assertStatus(422);
});

test('controller rejects shelf belonging to another user with 404', function () {
    $owner = citationSeedUser('cite_shelf_owner');
    $shelfId = citationSeedShelf($owner->name);

    $caller = citationSeedUser('cite_shelf_thief');
    $this->actingAs($caller)
        ->getJson('/api/search/combined?q=anything&sourceScope=shelf&shelfId=' . $shelfId)
        ->assertStatus(404);
});

// =============================================================================
// Graceful degradation
// =============================================================================

test('OpenAlex 429 does not break local search', function () {
    citationSeedCanonical(['title' => 'CiteTest local fallback alpha']);

    Http::fake([
        'api.openalex.org/*' => Http::response(['error' => 'rate limited'], 429),
        'openlibrary.org/*'  => Http::response(['docs' => []], 200),
    ]);

    $svc = app(CitationSearchService::class);
    $r = $svc->search('CiteTest local fallback', 15, 0, 'public');

    $canonical = collect($r['results'])->firstWhere('row_type', 'canonical');
    expect($canonical)->not->toBeNull('local canonical result should still appear despite external failures');
});

test('Open Library 500 does not break local search', function () {
    citationSeedCanonical(['title' => 'CiteTest local survive alpha']);

    Http::fake([
        'api.openalex.org/*' => Http::response(['results' => []], 200),
        'openlibrary.org/*'  => Http::response(['error' => 'server error'], 500),
    ]);

    $svc = app(CitationSearchService::class);
    $r = $svc->search('CiteTest local survive', 15, 0, 'public');

    $canonical = collect($r['results'])->firstWhere('row_type', 'canonical');
    expect($canonical)->not->toBeNull();
});
