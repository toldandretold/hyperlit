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
 *     path needs a live embedding provider and is covered by e2e).
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

beforeEach(function () {
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

test('mode=semantic returns 503 when embeddings are unavailable', function () {
    $owner = makeUlsUser('uls_sem');
    $this->mock(EmbeddingService::class, function ($mock) {
        $mock->shouldReceive('embedSearchQuery')->andReturnNull();
    });

    $response = $this->getJson('/api/public/library/' . rawurlencode($owner->name) . '/search?q=meaningful+query&mode=semantic');
    $response->assertStatus(503);
});
