<?php

/**
 * Shared seeders for the Canonical suite. Not a test file (no *Test.php
 * suffix) — require_once it from each test. Seeds use the canonv_ prefix;
 * canonvCleanup() in each file's beforeEach removes them (pgsql_admin writes
 * are not covered by RefreshDatabase's transaction).
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function canonvDb()
{
    return DB::connection('pgsql_admin');
}

function canonvCleanup(): void
{
    // Scan-created stubs get uuid book ids — they're only identifiable by the
    // CanonV title prefix, so clean by both book prefix AND title prefix.
    canonvDb()->table('library')->whereRaw("book LIKE 'book_canonv_%'")->delete();
    canonvDb()->table('library')->whereRaw("title LIKE 'CanonV %'")->delete();
    canonvDb()->table('bibliography')->whereRaw("book LIKE 'book_canonv_%'")->delete();
    canonvDb()->table('canonical_source')->whereRaw("title LIKE 'CanonV %'")->delete();
    canonvDb()->table('users')->whereRaw("email LIKE '%@canonv.test'")->delete();
}

/**
 * A full OpenAlexService::normaliseWork-shaped array — upsertLibraryStubs
 * reads most keys without null-coalescing, so they must all be present.
 */
function canonvNormalisedWork(array $overrides = []): array
{
    return array_merge([
        'title'            => 'CanonV Scan Linked Work',
        'author'           => 'Scan, Author',
        'year'             => 2021,
        'journal'          => 'Journal of CanonV',
        'publisher'        => null,
        'abstract'         => null,
        'type'             => 'journal-article',
        'language'         => 'en',
        'doi'              => '10.9999/canonv-test-doi',
        'openalex_id'      => 'W_canonv_test_1',
        'open_library_key' => null,
        'is_oa'            => true,
        'oa_status'        => 'gold',
        'oa_url'           => null,
        'pdf_url'          => 'https://example.org/canonv.pdf',
        'work_license'     => null,
        'cited_by_count'   => 3,
        'volume'           => null,
        'issue'            => null,
        'pages'            => null,
        'bibtex'           => '@article{canonv2021, title={CanonV Scan Linked Work}}',
        'source'           => 'openalex',
    ], $overrides);
}

function canonvSeedLibrary(array $opts = []): string
{
    $book = $opts['book'] ?? ('book_canonv_' . Str::random(8));
    canonvDb()->table('library')->insert([
        'book'                => $book,
        'title'               => $opts['title'] ?? 'CanonV Library',
        'author'              => $opts['author'] ?? 'CanonV Author',
        'creator'             => $opts['creator'] ?? null,
        'visibility'          => $opts['visibility'] ?? 'public',
        'listed'              => $opts['listed'] ?? true,
        'type'                => $opts['type'] ?? 'book',
        'has_nodes'           => $opts['has_nodes'] ?? true,
        'canonical_source_id' => $opts['canonical_source_id'] ?? null,
        'conversion_method'   => $opts['conversion_method'] ?? null,
        'foundation_source'   => $opts['foundation_source'] ?? null,
        'raw_json'            => '[]',
        'timestamp'           => 0,
        'created_at'          => $opts['created_at'] ?? now(),
    ]);
    return $book;
}

function canonvSeedCanonical(array $opts = []): string
{
    $id = $opts['id'] ?? (string) Str::uuid();
    canonvDb()->table('canonical_source')->insert(array_merge([
        'id'                     => $id,
        'title'                  => 'CanonV Canonical',
        'author'                 => 'CanonV Author',
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

/**
 * Read a canonical_source column via the DEFAULT connection. Eloquent saves
 * happen inside RefreshDatabase's uncommitted transaction on that connection,
 * so pgsql_admin reads would miss them.
 */
function canonvCanonicalValue(string $id, string $column)
{
    return DB::table('canonical_source')->where('id', $id)->value($column);
}

function canonvSeedUser(string $name): User
{
    $unique = $name . '_' . Str::random(6);
    $id = canonvDb()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@canonv.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}
