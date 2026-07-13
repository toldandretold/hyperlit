<?php

/**
 * AI Brain — Retrieval scope / privacy tests
 *
 * Locks the contract that NO private book is ever returned by the retrieval
 * services regardless of scope, and that the `shelf` scope restricts results
 * to actual shelf members.
 *
 * Inserts go through `pgsql_admin` to bypass Row-Level Security (the default
 * `pgsql` connection enforces RLS that checks session vars set by HTTP
 * middleware, which aren't set in raw Pest tests). Reads go through the
 * default connection like real code does.
 */

use App\Models\User;
use App\Services\EmbeddingService;
use App\Services\SearchService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function adminDb()
{
    return DB::connection('pgsql_admin');
}

// pgsql_admin connection isn't covered by RefreshDatabase's transaction rollback,
// so test fixtures persist between runs. Wipe ours by prefix before each test.
beforeEach(function () {
    adminDb()->table('shelf_items')->whereRaw("book LIKE 'book_test_%'")->delete();
    adminDb()->table('nodes')->whereRaw("book LIKE 'book_test_%'")->delete();
    adminDb()->table('library')->whereRaw("book LIKE 'book_test_%'")->delete();
    adminDb()->table('shelves')->whereRaw("slug LIKE 'test-shelf-%'")->delete();
    adminDb()->table('users')->whereRaw("email LIKE '%@scopetest.test'")->delete();
});

function seedBook(array $opts): string
{
    $book = $opts['book'] ?? ('book_test_' . Str::random(8));
    adminDb()->table('library')->insert([
        'book'       => $book,
        'title'      => $opts['title'] ?? 'Test book',
        'author'     => $opts['author'] ?? 'Test author',
        'creator'    => $opts['creator'] ?? null,
        'visibility' => $opts['visibility'] ?? 'public',
        'listed'     => $opts['listed'] ?? true,
        'type'       => 'book',
        'has_nodes'  => true,
        'raw_json'   => '[]',
        'timestamp'  => 0,
    ]);

    $vector = '[' . implode(',', array_fill(0, 768, 0.1)) . ']';

    adminDb()->table('nodes')->insert([
        'book'      => $book,
        'chunk_id'  => 0,
        'startLine' => 1,
        'node_id'   => $book . '_node_1',
        'content'   => '<p>' . ($opts['text'] ?? 'monetarism inflation') . '</p>',
        'plainText' => $opts['text'] ?? 'monetarism inflation',
        'embedding' =>($opts['withEmbedding'] ?? true) ? adminDb()->raw("'{$vector}'::vector") : null,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $book;
}

function seedShelf(string $creator, array $books = []): string
{
    $shelfId = (string) Str::uuid();
    $rand    = Str::random(6);
    adminDb()->table('shelves')->insert([
        'id'         => $shelfId,
        'creator'    => $creator,
        'name'       => 'Test shelf ' . $rand,
        'slug'       => 'test-shelf-' . strtolower($rand),
        'visibility' => 'private',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    foreach ($books as $book) {
        adminDb()->table('shelf_items')->insert([
            'shelf_id' => $shelfId,
            'book'     => $book,
            'added_at' => now(),
        ]);
    }
    return $shelfId;
}

function seedUser(string $name): User
{
    // Suffix with random so re-runs don't collide on the unique constraint
    // (pgsql_admin connection isn't covered by RefreshDatabase's rollback)
    $unique = $name . '_' . Str::random(8);
    $id = adminDb()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@scopetest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

function queryEmbedding(): array
{
    return array_fill(0, 768, 0.1);
}

/**
 * Activate a user in the default Postgres session so RLS policies that gate
 * `shelf_items.SELECT` and similar tables let our reads through. Mirrors what
 * SetDatabaseSessionContext middleware does on real HTTP requests.
 */
function actAsPgUser(User $user): void
{
    DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, true)", [$user->user_token ?? '']);
}

// =============================================================================
// SearchService::searchNodesByKeyword
// =============================================================================

test('searchNodesByKeyword: public scope excludes private books', function () {
    $publicBook = seedBook(['visibility' => 'public', 'text' => 'monetarism inflation theory']);
    $privateBook = seedBook(['visibility' => 'private', 'text' => 'monetarism inflation theory']);

    $rows = app(SearchService::class)->searchNodesByKeyword('monetarism', 50, null, 'public');
    $returnedBooks = array_column($rows, 'book');

    expect($returnedBooks)->toContain($publicBook)
        ->and($returnedBooks)->not->toContain($privateBook);
});

test('searchNodesByKeyword: mine scope returns only callers own PUBLIC books', function () {
    $user = seedUser('scope_test_user_a');
    $other = seedUser('scope_test_user_b');

    $myPublic  = seedBook(['creator' => $user->name,  'visibility' => 'public',  'text' => 'monetarism inflation']);
    $myPrivate = seedBook(['creator' => $user->name,  'visibility' => 'private', 'text' => 'monetarism inflation']);
    $foreign   = seedBook(['creator' => $other->name, 'visibility' => 'public',  'text' => 'monetarism inflation']);

    $rows = app(SearchService::class)->searchNodesByKeyword('monetarism', 50, null, 'mine', $user->name);
    $returnedBooks = array_column($rows, 'book');

    expect($returnedBooks)->toContain($myPublic)
        ->and($returnedBooks)->not->toContain($myPrivate, "private book leaked through 'mine' scope")
        ->and($returnedBooks)->not->toContain($foreign, "other user's book leaked through 'mine' scope");
});

test('searchNodesByKeyword: shelf scope restricts to shelf members', function () {
    $user = seedUser('scope_test_shelf_user');
    actAsPgUser($user);

    $inShelf  = seedBook(['visibility' => 'public', 'text' => 'monetarism inflation']);
    $outShelf = seedBook(['visibility' => 'public', 'text' => 'monetarism inflation']);

    $shelfId = seedShelf($user->name, [$inShelf]);

    $rows = app(SearchService::class)->searchNodesByKeyword('monetarism', 50, null, 'shelf', $user->name, '&', $shelfId);
    $returnedBooks = array_column($rows, 'book');

    expect($returnedBooks)->toContain($inShelf)
        ->and($returnedBooks)->not->toContain($outShelf, 'book outside the shelf leaked through');
});

test('searchNodesByKeyword: shelf scope excludes private books even when they are in the shelf', function () {
    $user = seedUser('scope_test_shelf_priv');
    actAsPgUser($user);

    $publicInShelf  = seedBook(['visibility' => 'public',  'text' => 'monetarism inflation']);
    $privateInShelf = seedBook(['visibility' => 'private', 'text' => 'monetarism inflation', 'creator' => $user->name]);

    $shelfId = seedShelf($user->name, [$publicInShelf, $privateInShelf]);

    $rows = app(SearchService::class)->searchNodesByKeyword('monetarism', 50, null, 'shelf', $user->name, '&', $shelfId);
    $returnedBooks = array_column($rows, 'book');

    expect($returnedBooks)->toContain($publicInShelf)
        ->and($returnedBooks)->not->toContain($privateInShelf,
            'private book leaked through shelf scope — privacy contract broken');
});

test('searchNodesByKeyword: shelf scope with empty shelf returns nothing', function () {
    $user = seedUser('scope_test_empty_shelf');
    actAsPgUser($user);

    // Seed a public book that would otherwise match
    seedBook(['visibility' => 'public', 'text' => 'monetarism inflation']);
    $shelfId = seedShelf($user->name, []);

    $rows = app(SearchService::class)->searchNodesByKeyword('monetarism', 50, null, 'shelf', $user->name, '&', $shelfId);

    expect($rows)->toBe([]);
});

// =============================================================================
// SearchService::searchLibraryByKeyword
// =============================================================================

test('searchLibraryByKeyword: public scope excludes private books', function () {
    seedBook(['visibility' => 'public', 'title' => 'Monetarism and Inflation']);
    $privateBook = seedBook(['visibility' => 'private', 'title' => 'Monetarism and Inflation']);

    $rows = app(SearchService::class)->searchLibraryByKeyword('monetarism', 50, 'public');
    $books = array_column($rows, 'book');

    expect($books)->not->toContain($privateBook);
});

test('searchLibraryByKeyword: mine scope excludes private and other users books', function () {
    $user  = seedUser('lib_scope_user_a');
    $other = seedUser('lib_scope_user_b');

    $myPublic  = seedBook(['creator' => $user->name,  'visibility' => 'public',  'title' => 'Monetarism A']);
    $myPrivate = seedBook(['creator' => $user->name,  'visibility' => 'private', 'title' => 'Monetarism B']);
    $foreign   = seedBook(['creator' => $other->name, 'visibility' => 'public',  'title' => 'Monetarism C']);

    $rows = app(SearchService::class)->searchLibraryByKeyword('monetarism', 50, 'mine', $user->name);
    $books = array_column($rows, 'book');

    expect($books)->toContain($myPublic)
        ->and($books)->not->toContain($myPrivate)
        ->and($books)->not->toContain($foreign);
});

test('searchLibraryByKeyword: shelf scope is constrained to public books in shelf', function () {
    $user = seedUser('lib_shelf_user');
    actAsPgUser($user);

    $inShelfPublic  = seedBook(['visibility' => 'public',  'title' => 'Monetarism public']);
    $inShelfPrivate = seedBook(['visibility' => 'private', 'creator' => $user->name, 'title' => 'Monetarism private']);
    $outShelf       = seedBook(['visibility' => 'public',  'title' => 'Monetarism outside']);

    $shelfId = seedShelf($user->name, [$inShelfPublic, $inShelfPrivate]);

    $rows = app(SearchService::class)->searchLibraryByKeyword('monetarism', 50, 'shelf', $user->name, $shelfId);
    $books = array_column($rows, 'book');

    expect($books)->toContain($inShelfPublic)
        ->and($books)->not->toContain($inShelfPrivate, 'private shelf member leaked')
        ->and($books)->not->toContain($outShelf, 'book outside shelf leaked');
});

// =============================================================================
// EmbeddingService::searchSimilar
// =============================================================================

test('searchSimilar: public scope excludes private books', function () {
    $public  = seedBook(['visibility' => 'public']);
    $private = seedBook(['visibility' => 'private']);

    $rows = app(EmbeddingService::class)->searchSimilar(queryEmbedding(), 50, null, 'public');
    $books = array_map(fn($r) => $r->book, $rows);

    expect($books)->toContain($public)
        ->and($books)->not->toContain($private);
});

test('searchSimilar: mine scope excludes the callers own private books', function () {
    $user = seedUser('emb_scope_mine');

    $myPublic  = seedBook(['creator' => $user->name, 'visibility' => 'public']);
    $myPrivate = seedBook(['creator' => $user->name, 'visibility' => 'private']);

    $rows = app(EmbeddingService::class)->searchSimilar(queryEmbedding(), 50, null, 'mine', $user->name);
    $books = array_map(fn($r) => $r->book, $rows);

    expect($books)->toContain($myPublic)
        ->and($books)->not->toContain($myPrivate);
});

test('searchSimilar: shelf scope restricts to public shelf members only', function () {
    $user = seedUser('emb_scope_shelf');
    actAsPgUser($user);

    $publicInShelf  = seedBook(['visibility' => 'public']);
    $privateInShelf = seedBook(['visibility' => 'private', 'creator' => $user->name]);
    $outShelf       = seedBook(['visibility' => 'public']);

    $shelfId = seedShelf($user->name, [$publicInShelf, $privateInShelf]);

    $rows = app(EmbeddingService::class)->searchSimilar(queryEmbedding(), 50, null, 'shelf', $user->name, $shelfId);
    $books = array_map(fn($r) => $r->book, $rows);

    expect($books)->toContain($publicInShelf)
        ->and($books)->not->toContain($privateInShelf)
        ->and($books)->not->toContain($outShelf);
});

test('searchSimilar: shelf scope with empty shelf returns nothing', function () {
    $user = seedUser('emb_scope_empty_shelf');
    actAsPgUser($user);

    seedBook(['visibility' => 'public']);
    $shelfId = seedShelf($user->name, []);

    $rows = app(EmbeddingService::class)->searchSimilar(queryEmbedding(), 50, null, 'shelf', $user->name, $shelfId);

    expect($rows)->toBe([]);
});
