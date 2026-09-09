<?php

/**
 * User-library search — GET /api/public/library/{username}/search.
 *
 * The /u/{username} hero search box endpoint. Contract:
 *   - mode=library (titles/authors) and default full-text over node content;
 *   - visitors see PUBLIC books only; the page's OWNER (session, resolved via
 *     the sanctum guard — the route has no auth middleware) also searches
 *     their private books;
 *   - synthetic rows are NEVER searched: the four user-home books, sorted
 *     variants, shelf renders — else searching a library also hits the
 *     library-card lists themselves;
 *   - mode=semantic 503s cleanly when embeddings are unavailable (the happy
 *     path needs a live embedding provider and is covered by e2e);
 *   - ?shelf={uuid} narrows the corpus to that shelf (the page's open shelf
 *     tab): the shelf must belong to the page's user, PRIVATE shelves are
 *     allowed for the owner only, and member visibility is re-checked per
 *     book so a public shelf never exposes a private member.
 */

use App\Models\User;
use App\Services\EmbeddingService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function ulsAdminConn()
{
    return DB::connection('pgsql_admin');
}

function makeUlsUser(string $prefix): User
{
    $unique = $prefix . '_' . Str::random(8);
    $id = ulsAdminConn()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@ulstest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'budget',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

function makeUlsBook(User $user, string $book, string $title, string $visibility, string $nodeText, ?string $rawType = null): void
{
    ulsAdminConn()->table('library')->insert([
        'book'       => $book,
        'title'      => $title,
        'author'     => 'Uls Author',
        'creator'    => $user->name,
        'visibility' => $visibility,
        'listed'     => false,
        'type'       => 'book',
        'raw_json'   => json_encode($rawType ? ['type' => $rawType] : []),
        'timestamp'  => (int) round(microtime(true) * 1000),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    ulsAdminConn()->table('nodes')->insert([
        'book'       => $book,
        'node_id'    => $book . '_n1',
        'chunk_id'   => 0,
        'startLine'  => 100,
        'content'    => '<p>' . e($nodeText) . '</p>',
        'plainText'  => $nodeText,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

function makeUlsShelf(User $user, string $visibility): string
{
    $shelfId = (string) Str::uuid();
    ulsAdminConn()->table('shelves')->insert([
        'id'         => $shelfId,
        'creator'    => $user->name,
        'name'       => 'Uls shelf ' . Str::random(4),
        'slug'       => 'ulsshelf-' . Str::random(6),
        'visibility' => $visibility,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return $shelfId;
}

function addUlsShelfItem(string $shelfId, string $book): void
{
    ulsAdminConn()->table('shelf_items')->insert([
        'shelf_id' => $shelfId,
        'book'     => $book,
        'added_at' => now(),
    ]);
}

beforeEach(function () {
    ulsAdminConn()->table('shelves')->whereRaw("slug LIKE 'ulsshelf-%'")->delete();
    ulsAdminConn()->table('nodes')->whereRaw("book LIKE 'ulsbook_%'")->delete();
    ulsAdminConn()->table('library')->whereRaw("creator IN (SELECT name FROM users WHERE email LIKE '%@ulstest.test')")->delete();
    ulsAdminConn()->table('users')->whereRaw("email LIKE '%@ulstest.test'")->delete();
});

test('404s for an unknown username', function () {
    $response = $this->getJson('/api/public/library/no_such_user_' . Str::random(10) . '/search?q=anything');
    $response->assertStatus(404);
});

test('mode=library: visitor sees public books only, owner sees private too', function () {
    $owner = makeUlsUser('uls_lib');
    $suffix = Str::random(6);
    makeUlsBook($owner, 'ulsbook_pub_' . $suffix, 'Zanzibar Public Chronicle', 'public', 'public words');
    makeUlsBook($owner, 'ulsbook_priv_' . $suffix, 'Zanzibar Private Chronicle', 'private', 'private words');

    $visitor = $this->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=Zanzibar&mode=library');
    $visitor->assertStatus(200);
    $titles = array_column($visitor->json('results'), 'title');
    expect($titles)->toContain('Zanzibar Public Chronicle');
    expect($titles)->not->toContain('Zanzibar Private Chronicle');

    $asOwner = $this->actingAs($owner)->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=Zanzibar&mode=library');
    $asOwner->assertStatus(200);
    $ownerTitles = array_column($asOwner->json('results'), 'title');
    expect($ownerTitles)->toContain('Zanzibar Public Chronicle');
    expect($ownerTitles)->toContain('Zanzibar Private Chronicle');
});

test('full-text: visitor matches public node content only, owner matches private too', function () {
    $owner = makeUlsUser('uls_ft');
    $suffix = Str::random(6);
    makeUlsBook($owner, 'ulsbook_ftpub_' . $suffix, 'FT Public', 'public', 'the quokka sings at dawn');
    makeUlsBook($owner, 'ulsbook_ftpriv_' . $suffix, 'FT Private', 'private', 'the quokka sings at midnight');

    $visitor = $this->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=quokka');
    $visitor->assertStatus(200);
    $books = array_column($visitor->json('results'), 'book');
    expect($books)->toContain('ulsbook_ftpub_' . $suffix);
    expect($books)->not->toContain('ulsbook_ftpriv_' . $suffix);

    $asOwner = $this->actingAs($owner)->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=quokka');
    $asOwner->assertStatus(200);
    $ownerBooks = array_column($asOwner->json('results'), 'book');
    expect($ownerBooks)->toContain('ulsbook_ftpub_' . $suffix);
    expect($ownerBooks)->toContain('ulsbook_ftpriv_' . $suffix);
});

test('synthetic user-home books are never searched', function () {
    $owner = makeUlsUser('uls_syn');
    $sanitized = str_replace(' ', '', $owner->name);
    // The user-home display book: creator = user, visibility public — without
    // the exclusion it would match its own library-card text.
    makeUlsBook($owner, $sanitized, 'Home Book', 'public', 'wombat card list text', 'user_home');
    makeUlsBook($owner, $sanitized . '_public_recent', 'Sorted Render', 'public', 'wombat sorted render', 'user_home_sorted');
    makeUlsBook($owner, 'ulsbook_real_' . Str::random(6), 'Real Wombat Study', 'public', 'wombat field notes');

    $response = $this->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=wombat');
    $response->assertStatus(200);
    $books = array_column($response->json('results'), 'book');
    expect($books)->toHaveCount(1);
    expect($books[0])->toStartWith('ulsbook_real_');

    $lib = $this->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=Home&mode=library');
    expect(array_column($lib->json('results'), 'book'))->not->toContain($sanitized);
});

test('shelf scope narrows both mode=library and full-text to the shelf members', function () {
    $owner = makeUlsUser('uls_shelfnarrow');
    $suffix = Str::random(6);
    $inShelf = 'ulsbook_in_' . $suffix;
    $outShelf = 'ulsbook_out_' . $suffix;
    makeUlsBook($owner, $inShelf, 'Numbat In Shelf', 'public', 'the numbat forages at noon');
    makeUlsBook($owner, $outShelf, 'Numbat Out Of Shelf', 'public', 'the numbat forages at dusk');
    $shelfId = makeUlsShelf($owner, 'public');
    addUlsShelfItem($shelfId, $inShelf);

    $base = '/api/public/library/' . rawurlencode($owner->name) . '/search';

    // Un-narrowed: both books.
    $wide = $this->getJson($base . '?q=Numbat&mode=library');
    expect(array_column($wide->json('results'), 'book'))->toContain($inShelf, $outShelf);

    // Narrowed: only the member.
    $narrow = $this->getJson($base . '?q=Numbat&mode=library&shelf=' . $shelfId);
    $narrow->assertStatus(200);
    $books = array_column($narrow->json('results'), 'book');
    expect($books)->toContain($inShelf);
    expect($books)->not->toContain($outShelf);

    // Same narrowing on the default full-text mode.
    $ft = $this->getJson($base . '?q=numbat&shelf=' . $shelfId);
    $ft->assertStatus(200);
    $ftBooks = array_column($ft->json('results'), 'book');
    expect($ftBooks)->toContain($inShelf);
    expect($ftBooks)->not->toContain($outShelf);
});

test('a PUBLIC shelf is searchable by a visitor but its private members are not', function () {
    $owner = makeUlsUser('uls_shelfpub');
    $suffix = Str::random(6);
    $pub = 'ulsbook_spub_' . $suffix;
    $priv = 'ulsbook_spriv_' . $suffix;
    makeUlsBook($owner, $pub, 'Bilby Public', 'public', 'the bilby digs deep');
    makeUlsBook($owner, $priv, 'Bilby Private', 'private', 'the bilby digs deeper');
    $shelfId = makeUlsShelf($owner, 'public');
    addUlsShelfItem($shelfId, $pub);
    addUlsShelfItem($shelfId, $priv);

    $base = '/api/public/library/' . rawurlencode($owner->name) . '/search';

    $visitor = $this->getJson($base . '?q=bilby&shelf=' . $shelfId);
    $visitor->assertStatus(200);
    $visitorBooks = array_column($visitor->json('results'), 'book');
    expect($visitorBooks)->toContain($pub);
    expect($visitorBooks)->not->toContain($priv);

    // The owner's own private member IS in their scope — parity with the
    // un-narrowed owner search.
    $asOwner = $this->actingAs($owner)->getJson($base . '?q=bilby&shelf=' . $shelfId);
    $asOwner->assertStatus(200);
    expect(array_column($asOwner->json('results'), 'book'))->toContain($pub, $priv);
});

// One actor per test: the resolved sanctum user is cached for the whole test,
// so a second request under a different (or no) session would still be the first.
test('a PRIVATE shelf is searchable by its owner', function () {
    $owner = makeUlsUser('uls_shelfpriv');
    $book = 'ulsbook_privshelf_' . Str::random(6);
    makeUlsBook($owner, $book, 'Potoroo Notes', 'public', 'the potoroo hides well');
    $shelfId = makeUlsShelf($owner, 'private');
    addUlsShelfItem($shelfId, $book);

    $response = $this->actingAs($owner)
        ->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=potoroo&shelf=' . $shelfId);

    $response->assertStatus(200);
    expect(array_column($response->json('results'), 'book'))->toContain($book);
});

test('a PRIVATE shelf 404s for a guest', function () {
    $owner = makeUlsUser('uls_shelfprivguest');
    $shelfId = makeUlsShelf($owner, 'private');

    $this->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=potoroo&shelf=' . $shelfId)
        ->assertStatus(404);
});

test("a PRIVATE shelf 404s for another signed-in user", function () {
    $owner = makeUlsUser('uls_shelfprivowner');
    $visitor = makeUlsUser('uls_shelfvisitor');
    $shelfId = makeUlsShelf($owner, 'private');

    $this->actingAs($visitor)
        ->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=potoroo&shelf=' . $shelfId)
        ->assertStatus(404);
});

test('404s for a shelf belonging to another user, and for a malformed shelf id', function () {
    $pageOwner = makeUlsUser('uls_shelfpage');
    $other = makeUlsUser('uls_shelfother');
    // A PUBLIC shelf of someone else's: still 404 on this user's page, so the
    // endpoint can't be used to proxy-search a shelf that isn't the page's.
    $foreignShelf = makeUlsShelf($other, 'public');

    $base = '/api/public/library/' . rawurlencode($pageOwner->name) . '/search';

    $this->getJson($base . '?q=anything&shelf=' . $foreignShelf)->assertStatus(404);
    // Junk id must 404, not blow up on the uuid cast.
    $this->getJson($base . '?q=anything&shelf=not-a-uuid')->assertStatus(404);
});

test('mode=semantic returns 503 when embeddings are unavailable', function () {
    $owner = makeUlsUser('uls_sem');
    $this->mock(EmbeddingService::class, function ($mock) {
        $mock->shouldReceive('embedSearchQuery')->andReturnNull();
    });

    $response = $this->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=meaningful+query&mode=semantic');
    $response->assertStatus(503);
});
