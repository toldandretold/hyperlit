<?php

/**
 * Shared helpers for home-book regression tests.
 *
 * Tests that exercise UserHomeServerController / BookDeletionService need:
 *   - a way to bypass RLS on setup/teardown (controller uses pgsql_admin)
 *   - a deterministic seed of a user + N public + M private books
 *   - cleanup keyed off a known username prefix
 */

use App\Models\PgLibrary;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

const HB_TEST_USER_PREFIX = 'hb_test_';

function hbAdmin()
{
    return DB::connection('pgsql_admin');
}

function hbCleanup(): void
{
    $users = hbAdmin()->table('users')->where('name', 'like', HB_TEST_USER_PREFIX . '%')->pluck('name');
    foreach ($users as $username) {
        $sanitized = str_replace(' ', '', $username);
        hbAdmin()->table('nodes')->where('book', 'like', $sanitized . '%')->delete();
        hbAdmin()->table('library')->where('creator', $username)->delete();
        hbAdmin()->table('library')->where('book', 'like', $sanitized . '%')->delete();
    }
    hbAdmin()->table('users')->where('name', 'like', HB_TEST_USER_PREFIX . '%')->delete();
}

/**
 * @return array{username: string, public: array<string>, private: array<string>}
 */
function hbSeedUserWithBooks(int $publicCount = 3, int $privateCount = 2): array
{
    $username = HB_TEST_USER_PREFIX . uniqid();
    hbAdmin()->table('users')->insert([
        'name' => $username,
        'email' => $username . '@test.local',
        'email_verified_at' => now(),
        'password' => Hash::make('password'),
        'user_token' => (string) Str::uuid(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $publicBooks = [];
    for ($i = 0; $i < $publicCount; $i++) {
        $bookId = $username . '_pub_' . $i;
        hbAdmin()->table('library')->insert(hbBookRow($bookId, $username, 'public', 'Public Book ' . $i));
        $publicBooks[] = $bookId;
    }

    $privateBooks = [];
    for ($i = 0; $i < $privateCount; $i++) {
        $bookId = $username . '_prv_' . $i;
        hbAdmin()->table('library')->insert(hbBookRow($bookId, $username, 'private', 'Private Book ' . $i));
        $privateBooks[] = $bookId;
    }

    $controller = app(\App\Http\Controllers\UserHomeServerController::class);
    $controller->generateUserHomeBook($username, true, 'public');
    $controller->generateUserHomeBook($username, true, 'private');
    $controller->generateAllUserHomeBook($username);

    return ['username' => $username, 'public' => $publicBooks, 'private' => $privateBooks];
}

function hbBookRow(string $bookId, string $username, string $visibility, string $title): array
{
    return [
        'book' => $bookId,
        'title' => $title,
        'author' => 'Test Author',
        'creator' => $username,
        'visibility' => $visibility,
        'listed' => true,
        'timestamp' => round(microtime(true) * 1000),
        'raw_json' => json_encode(['book' => $bookId, 'type' => 'book']),
        'created_at' => now(),
        'updated_at' => now(),
    ];
}

/**
 * Insert a library row for a brand-new book and return a fresh PgLibrary model.
 */
function hbInsertBook(string $username, string $bookId, string $visibility, string $title = 'New Book'): PgLibrary
{
    hbAdmin()->table('library')->insert(hbBookRow($bookId, $username, $visibility, $title));
    return PgLibrary::on('pgsql_admin')->where('book', $bookId)->first();
}

/**
 * @return array<string>
 */
function hbCardsIn(string $homeBookName): array
{
    return hbAdmin()->table('nodes')
        ->where('book', $homeBookName)
        ->where('node_id', '!=', $homeBookName . '_empty_card')
        ->pluck('raw_json')
        ->map(fn ($json) => json_decode($json, true)['original_book'] ?? null)
        ->filter()
        ->values()
        ->all();
}

function hbHasEmptyCard(string $homeBookName): bool
{
    return hbAdmin()->table('nodes')
        ->where('book', $homeBookName)
        ->where('node_id', $homeBookName . '_empty_card')
        ->exists();
}

function hbBookRecord(string $bookId): PgLibrary
{
    return PgLibrary::on('pgsql_admin')->where('book', $bookId)->first();
}
