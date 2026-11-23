<?php

/**
 * Author identities have ONE writer per table (docs/authors.md).
 *
 * `authors` and `book_authors` are shared reference data: a second code path
 * writing either is how a book lands on the wrong person's /a/ page with
 * nothing to trace it by, and how a link is written without the author's shelf
 * being re-synced. An author shelf is DERIVED from book_authors, so a second
 * writer of its membership is drift by construction (the same reason the Likes
 * shelf has one).
 *
 *  - `authors`       ← App\Services\Authors\AuthorRegistry
 *  - `book_authors`  ← App\Services\Authors\AuthorLinker
 *  - author shelves  ← App\Services\Shelves\AuthorShelf (and ShelfKinds lists
 *                      the kind as SYSTEM, which is what refuses every hand edit)
 *
 * The database backs the first two: the app role holds SELECT only.
 */

use App\Services\Shelves\AuthorShelf;
use App\Services\Shelves\ShelfKinds;
use Illuminate\Support\Facades\DB;

/** Every .php file under app/, as path => contents. */
function authorGateSources(): array
{
    $files = [];
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(base_path('app'), FilesystemIterator::SKIP_DOTS));
    foreach ($it as $file) {
        if ($file->isFile() && $file->getExtension() === 'php') {
            $files[str_replace(base_path() . '/', '', $file->getPathname())] = file_get_contents($file->getPathname());
        }
    }
    ksort($files);

    return $files;
}

/** Files (other than $owner) that WRITE $table through the query builder or raw SQL. */
function authorGateWriters(string $table, string $owner): array
{
    $verbs = 'insert|insertOrIgnore|insertGetId|update|updateOrInsert|upsert|delete|truncate';
    $builder = "/table\\(\\s*['\"]{$table}['\"]\\s*\\)(?:(?!;).)*?->(?:{$verbs})\\(/s";
    $raw = "/\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+{$table}\\b/i";

    $offenders = [];
    foreach (authorGateSources() as $path => $code) {
        if ($path === $owner) {
            continue;
        }
        if (preg_match($builder, $code) || preg_match($raw, $code)) {
            $offenders[] = $path;
        }
    }

    return $offenders;
}

test('only AuthorLinker writes book_authors', function () {
    expect(authorGateWriters('book_authors', 'app/Services/Authors/AuthorLinker.php'))->toBe([]);
});

test('only AuthorRegistry writes authors', function () {
    expect(authorGateWriters('authors', 'app/Services/Authors/AuthorRegistry.php'))->toBe([]);
});

test('the app database role cannot write either table', function () {
    $appUser = config('database.connections.pgsql.username');
    $grants = DB::connection('pgsql_admin')->table('information_schema.role_table_grants')
        ->where('grantee', $appUser)
        ->whereIn('table_name', ['authors', 'book_authors'])
        ->pluck('privilege_type')->unique()->values()->all();

    expect($grants)->toBe(['SELECT']);
});

test('the author shelf kind is a system kind, and only AuthorShelf mints one', function () {
    expect(ShelfKinds::SYSTEM)->toContain(AuthorShelf::KIND);

    $allowed = ['app/Services/Shelves/AuthorShelf.php', 'app/Services/Shelves/ShelfKinds.php'];
    $offenders = [];
    foreach (authorGateSources() as $path => $code) {
        if (in_array($path, $allowed, true)) {
            continue;
        }
        // Naming the kind, or stamping an archive row with an author, is minting an author page.
        if (str_contains($code, 'AuthorShelf::KIND') || str_contains($code, 'AuthorShelf::ARCHIVE_KIND')
            || preg_match("/['\"]author_id['\"]\\s*=>/", $code)) {
            $offenders[] = $path;
        }
    }

    // AuthorLinker's 'author_id' => is the book_authors row it owns.
    expect(array_values(array_diff($offenders, ['app/Services/Authors/AuthorLinker.php'])))->toBe([]);
});

test('nothing writes library.author from an author record', function () {
    // The printed credit is the citation string; identity is a layer beside it, never its source.
    $offenders = [];
    foreach (authorGateSources() as $path => $code) {
        if (! str_starts_with($path, 'app/Services/Authors/') && $path !== 'app/Services/Shelves/AuthorShelf.php') {
            continue;
        }
        if (preg_match("/table\\(\\s*['\"]library['\"]\\s*\\)(?:(?!;).)*?->(?:update|insert|upsert|updateOrInsert)\\(/s", $code)) {
            $offenders[] = $path;
        }
    }

    expect($offenders)->toBe([]);
});
