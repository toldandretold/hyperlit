<?php

/**
 * Archive panel data — GET /api/archive-export/{scopeType}/{scopeId}/panel.
 *
 * The top-right #archiveRef button's data source on /u/{username}, /j/{slug}
 * and /a/{slug}. Contract:
 *   - audience is computed server-side: visitors get public-only counts, the
 *     signed-in OWNER of a user scope (sanctum guard — route has no auth
 *     middleware) gets private books counted into export_books;
 *   - synthetic user-home rows and sub-books are never part of the corpus;
 *   - E2EE books are split out of export_books into e2ee_skipped (the server
 *     cannot render their ciphertext);
 *   - journal scope = the journal's public shelf members;
 *   - unknown scope 404s; unknown scopeType is not a route.
 *
 * Seeds via pgsql_admin with beforeEach-only cleanup (afterEach admin deletes
 * deadlock against the open RefreshDatabase transaction).
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function apanelDb()
{
    return DB::connection('pgsql_admin');
}

function apanelCleanup(): void
{
    apanelDb()->table('library')->where('author', 'APanel Author')->delete();
    $shelfIds = apanelDb()->table('shelves')->where('name', 'LIKE', 'APanel %')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        apanelDb()->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        apanelDb()->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
    apanelDb()->table('journal_sources')->where('display_name', 'LIKE', 'APanel %')->delete();
    apanelDb()->table('library')->whereRaw("creator IN (SELECT name FROM users WHERE email LIKE '%@apaneltest.test')")->delete();
    apanelDb()->table('users')->where('email', 'LIKE', '%@apaneltest.test')->delete();
}

beforeEach(fn () => apanelCleanup());

function apanelUser(): User
{
    $unique = 'apanel_' . Str::random(8);
    $id = apanelDb()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@apaneltest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'budget',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return User::on('pgsql_admin')->find($id);
}

function apanelBook(string $creator, string $book, string $visibility, array $extra = []): void
{
    apanelDb()->table('library')->insert(array_merge([
        'book'       => $book,
        'title'      => 'APanel ' . $book,
        'author'     => 'APanel Author',
        'creator'    => $creator,
        'visibility' => $visibility,
        'listed'     => false,
        'type'       => 'book',
        'raw_json'   => '[]',
        'timestamp'  => (int) round(microtime(true) * 1000),
        'created_at' => now(),
        'updated_at' => now(),
    ], $extra));
}

test('user scope: visitor sees public books only; owner export includes private', function () {
    $owner = apanelUser();
    $sanitized = str_replace(' ', '', $owner->name);
    apanelBook($owner->name, 'apanelbook_pub_' . Str::random(6), 'public');
    apanelBook($owner->name, 'apanelbook_priv_' . Str::random(6), 'private');
    // Synthetics that share creator = username must never enter the corpus.
    apanelBook($owner->name, $sanitized, 'public', ['raw_json' => json_encode(['type' => 'user_home'])]);
    apanelBook($owner->name, $sanitized . 'About', 'public', ['raw_json' => json_encode(['type' => 'user_about'])]);

    $visitor = $this->getJson('/api/archive-export/user/' . rawurlencode($owner->name) . '/panel');
    $visitor->assertOk()
        ->assertJsonPath('audience', 'public')
        ->assertJsonPath('counts.export_books', 1)
        ->assertJsonPath('counts.public_books', 1);

    $asOwner = $this->actingAs($owner)->getJson('/api/archive-export/user/' . rawurlencode($owner->name) . '/panel');
    $asOwner->assertOk()
        ->assertJsonPath('audience', 'owner')
        ->assertJsonPath('counts.export_books', 2)
        ->assertJsonPath('counts.public_books', 1);
});

test('user scope: E2EE books are split into e2ee_skipped, not export_books', function () {
    $owner = apanelUser();
    apanelBook($owner->name, 'apanelbook_plain_' . Str::random(6), 'public');
    apanelBook($owner->name, 'apanelbook_enc_' . Str::random(6), 'private', ['encrypted' => true]);

    $asOwner = $this->actingAs($owner)->getJson('/api/archive-export/user/' . rawurlencode($owner->name) . '/panel');
    $asOwner->assertOk()
        ->assertJsonPath('counts.export_books', 1)
        ->assertJsonPath('counts.e2ee_skipped', 1);
});

test('user scope: bibtex cites the page URL and archive title', function () {
    $owner = apanelUser();
    apanelBook($owner->name, 'apanelbook_' . Str::random(6), 'public');

    $res = $this->getJson('/api/archive-export/user/' . rawurlencode($owner->name) . '/panel');
    $res->assertOk();
    $bibtex = $res->json('bibtex');
    // A PERSON has a library; journals/scrape corpora are archives (noun()).
    expect($bibtex)->toContain('@misc{')
        ->toContain('Hyperlit library')
        ->toContain('/u/' . rawurlencode($owner->name));
    expect($res->json('noun'))->toBe('library');
});

test('journal scope: corpus is the public shelf members, always public audience', function () {
    $journalId = (string) Str::uuid();
    apanelDb()->table('journal_sources')->insert([
        'id'                 => $journalId,
        'openalex_source_id' => 'SAPANEL' . Str::upper(Str::random(6)),
        'display_name'       => 'APanel Journal',
        'issn_l'             => '9999-0001',
        'slug'               => 'apanel-journal-' . Str::lower(Str::random(8)),
        'is_diamond'         => true,
        'created_at'         => now(),
        'updated_at'         => now(),
    ]);
    $shelfId = (string) Str::uuid();
    apanelDb()->table('shelves')->insert([
        'id'           => $shelfId,
        'creator'      => \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR,
        'name'         => 'APanel Journal Shelf',
        'slug'         => 'apanel-' . Str::lower(Str::random(10)),
        'visibility'   => 'public',
        'default_sort' => 'recent',
        'created_at'   => now(),
        'updated_at'   => now(),
    ]);
    apanelDb()->table('journal_sources')->where('id', $journalId)->update(['shelf_id' => $shelfId]);

    $pub = 'apanelbook_art_' . Str::random(6);
    $priv = 'apanelbook_hidden_' . Str::random(6);
    apanelBook('someone', $pub, 'public');
    apanelBook('someone', $priv, 'private');
    apanelDb()->table('shelf_items')->insert([
        ['shelf_id' => $shelfId, 'book' => $pub],
        ['shelf_id' => $shelfId, 'book' => $priv],
    ]);

    $slug = apanelDb()->table('journal_sources')->where('id', $journalId)->value('slug');
    $res = $this->getJson("/api/archive-export/journal/{$slug}/panel");
    $res->assertOk()
        ->assertJsonPath('audience', 'public')
        ->assertJsonPath('counts.export_books', 1)
        ->assertJsonPath('displayName', 'APanel Journal');
});

test('unknown scopeId 404s; unknown scopeType is not a route', function () {
    $this->getJson('/api/archive-export/user/no_such_user_' . Str::random(8) . '/panel')->assertNotFound();
    $this->getJson('/api/archive-export/journal/no-such-slug-' . Str::lower(Str::random(8)) . '/panel')->assertNotFound();
    $this->getJson('/api/archive-export/bogus/whatever/panel')->assertNotFound();
});
