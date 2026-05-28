<?php

/**
 * GET /api/canonical/{id}/best-version — locks the resolver contract used by
 * the citation click handler (resolveBibliographyTarget).
 *
 * Precedence:
 *   author_version_book > publisher_version_book > commons_version_book >
 *   auto_version_book > any visible linked version > book=null (citation-only)
 *
 * Privacy: only library versions visible to the caller are surfaced.
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function bestVerDb()
{
    return DB::connection('pgsql_admin');
}

beforeEach(function () {
    bestVerDb()->table('library')->whereRaw("book LIKE 'book_bestver_%'")->delete();
    bestVerDb()->table('users')->whereRaw("email LIKE '%@bestver.test'")->delete();
    bestVerDb()->table('canonical_source')->whereRaw("title LIKE 'BestVer %'")->delete();
});

function bestVerSeedLibrary(array $opts): string
{
    $book = $opts['book'] ?? ('book_bestver_' . Str::random(6));
    bestVerDb()->table('library')->insert([
        'book'                => $book,
        'title'               => $opts['title'] ?? 'BestVer Library',
        'author'              => $opts['author'] ?? 'BestVer Author',
        'creator'             => $opts['creator'] ?? null,
        'visibility'          => $opts['visibility'] ?? 'public',
        'listed'              => $opts['listed'] ?? true,
        'type'                => 'book',
        'has_nodes'           => true,
        'canonical_source_id' => $opts['canonical_source_id'] ?? null,
        'raw_json'            => '[]',
        'timestamp'           => 0,
    ]);
    return $book;
}

function bestVerSeedCanonical(array $opts = []): string
{
    $id = $opts['id'] ?? (string) Str::uuid();
    bestVerDb()->table('canonical_source')->insert(array_merge([
        'id'                     => $id,
        'title'                  => 'BestVer Canonical',
        'author'                 => 'BestVer Author',
        'year'                   => 2024,
        'author_version_book'    => null,
        'publisher_version_book' => null,
        'commons_version_book'   => null,
        'auto_version_book'      => null,
        'foundation_source'      => 'test',
        'created_at'             => now(),
        'updated_at'             => now(),
    ], $opts));
    return $id;
}

function bestVerSeedUser(string $name): User
{
    $unique = $name . '_' . Str::random(6);
    $id = bestVerDb()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@bestver.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

test('returns 404 when canonical does not exist', function () {
    $this->getJson('/api/canonical/' . Str::uuid() . '/best-version')
        ->assertStatus(404);
});

test('returns canonical-only response when no library versions linked', function () {
    $id = bestVerSeedCanonical(['title' => 'BestVer No Versions', 'abstract' => 'abc']);

    $this->getJson("/api/canonical/{$id}/best-version")
        ->assertOk()
        ->assertJsonPath('book', null)
        ->assertJsonPath('has_version', false)
        ->assertJsonPath('metadata.title', 'BestVer No Versions')
        ->assertJsonPath('metadata.abstract', 'abc');
});

test('author_version_book wins over publisher_version_book', function () {
    $authorBook    = bestVerSeedLibrary(['title' => 'BestVer Author Edition']);
    $publisherBook = bestVerSeedLibrary(['title' => 'BestVer Publisher Edition']);

    $id = bestVerSeedCanonical([
        'author_version_book'    => $authorBook,
        'publisher_version_book' => $publisherBook,
    ]);

    $this->getJson("/api/canonical/{$id}/best-version")
        ->assertOk()
        ->assertJsonPath('book', $authorBook)
        ->assertJsonPath('has_version', true);
});

test('publisher wins over commons when no author version', function () {
    $publisherBook = bestVerSeedLibrary(['title' => 'BestVer Publisher Edition']);
    $commonsBook   = bestVerSeedLibrary(['title' => 'BestVer Commons Edition']);

    $id = bestVerSeedCanonical([
        'publisher_version_book' => $publisherBook,
        'commons_version_book'   => $commonsBook,
    ]);

    $this->getJson("/api/canonical/{$id}/best-version")
        ->assertOk()
        ->assertJsonPath('book', $publisherBook);
});

test('commons wins over auto when no author or publisher', function () {
    $commonsBook = bestVerSeedLibrary(['title' => 'BestVer Commons Edition']);
    $autoBook    = bestVerSeedLibrary(['title' => 'BestVer Auto Edition']);

    $id = bestVerSeedCanonical([
        'commons_version_book' => $commonsBook,
        'auto_version_book'    => $autoBook,
    ]);

    $this->getJson("/api/canonical/{$id}/best-version")
        ->assertOk()
        ->assertJsonPath('book', $commonsBook);
});

test('falls back to any visible linked version when no precedence pointer set', function () {
    $id = bestVerSeedCanonical();
    $linked = bestVerSeedLibrary([
        'title'               => 'BestVer Linked Version',
        'canonical_source_id' => $id,
    ]);

    $this->getJson("/api/canonical/{$id}/best-version")
        ->assertOk()
        ->assertJsonPath('book', $linked)
        ->assertJsonPath('has_version', true);
});

test('skips precedence pointer when that library row is private and caller is not owner', function () {
    $owner = bestVerSeedUser('best_owner');
    $publicBook  = bestVerSeedLibrary(['title' => 'BestVer Public Fallback']);
    $privateBook = bestVerSeedLibrary([
        'title'      => 'BestVer Private Author Edition',
        'creator'    => $owner->name,
        'visibility' => 'private',
        'listed'     => false,
    ]);

    $id = bestVerSeedCanonical([
        'author_version_book' => $privateBook,
    ]);
    // Link the public version so fallback can find it
    bestVerDb()->table('library')->where('book', $publicBook)->update(['canonical_source_id' => $id]);

    // No auth = no access to private; should fall through to public version.
    $this->getJson("/api/canonical/{$id}/best-version")
        ->assertOk()
        ->assertJsonPath('book', $publicBook);
});

test('returns private version when caller owns it', function () {
    $owner = bestVerSeedUser('best_owner_2');
    $privateBook = bestVerSeedLibrary([
        'title'      => 'BestVer Owned Private',
        'creator'    => $owner->name,
        'visibility' => 'private',
        'listed'     => false,
    ]);

    $id = bestVerSeedCanonical([
        'author_version_book' => $privateBook,
    ]);

    $this->actingAs($owner)
        ->getJson("/api/canonical/{$id}/best-version")
        ->assertOk()
        ->assertJsonPath('book', $privateBook);
});

test('rejects non-uuid id with 404 (route constraint)', function () {
    $this->getJson('/api/canonical/not-a-uuid/best-version')
        ->assertStatus(404);
});
