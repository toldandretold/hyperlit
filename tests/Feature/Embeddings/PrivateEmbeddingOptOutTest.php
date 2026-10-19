<?php

/**
 * The Data panel's "Semantic search for private books" opt-out
 * (users.preferences.embed_private_books, default ON) — enforced through the
 * ONE eligibility definition, so the same preference refuses new embeddings
 * (QueueBookEmbeddings), excludes the book from backfill/reconcile dispatch,
 * and makes reconcile SCRUB existing vectors; flipping back re-embeds.
 * Public books are untouchable: their vectors power everyone's search.
 *
 * Own helper names (pemb*) — EmbeddingReconcileTest declares emb* globals and
 * Pest loads both files in a full run; redeclaration would be fatal.
 */

use App\Jobs\GenerateNodeEmbedding;
use App\Jobs\QueueBookEmbeddings;
use App\Services\EmbeddingEligibility;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function pembAdmin()
{
    return DB::connection('pgsql_admin');
}

beforeEach(function () {
    pembAdmin()->table('nodes')->whereRaw("book LIKE 'book_pembtest_%'")->delete();
    pembAdmin()->table('library')->whereRaw("book LIKE 'book_pembtest_%'")->delete();
    pembAdmin()->table('users')->whereRaw("email LIKE '%@pembtest.test'")->delete();
});

function pembSeedUser(array $prefs = []): string
{
    $name = 'pembtester_'.strtolower(Str::random(6));
    pembAdmin()->table('users')->insert([
        'name' => $name,
        'email' => $name.'@pembtest.test',
        'password' => bcrypt('password'),
        'user_token' => Str::uuid()->toString(),
        'preferences' => $prefs === [] ? null : json_encode($prefs),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $name;
}

function pembSeedBook(string $creator, string $visibility, bool $withEmbedding = false): string
{
    $book = 'book_pembtest_'.Str::random(8);
    pembAdmin()->table('library')->insert([
        'book' => $book, 'title' => 'Opt-out test', 'author' => 'T',
        'creator' => $creator, 'visibility' => $visibility, 'listed' => true,
        'type' => 'book', 'has_nodes' => true, 'raw_json' => '[]', 'timestamp' => 0,
    ]);
    pembAdmin()->table('nodes')->insert([
        'book' => $book, 'chunk_id' => 0, 'startLine' => 100,
        'node_id' => $book.'_n1',
        'content' => '<p>a paragraph with plenty of embedding-worthy text in it</p>',
        'plainText' => 'a paragraph with plenty of embedding-worthy text in it',
        'embedding' => $withEmbedding
            ? pembAdmin()->raw("'[".implode(',', array_fill(0, 768, 0.1))."]'::halfvec")
            : null,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    return $book;
}

function pembBookSqlSays(string $book): bool
{
    return (bool) pembAdmin()->selectOne(
        'SELECT EXISTS(SELECT 1 FROM library l WHERE l.book = ? AND '.EmbeddingEligibility::bookSql('l').') AS ok',
        [$book],
    )->ok;
}

test('the SQL predicate: opted-out owner makes private books ineligible, public books never', function () {
    $off = pembSeedUser(['embed_private_books' => false]);
    $on = pembSeedUser(['embed_private_books' => true]);
    $unset = pembSeedUser();

    expect(pembBookSqlSays(pembSeedBook($off, 'private')))->toBeFalse();
    expect(pembBookSqlSays(pembSeedBook($off, 'public')))->toBeTrue();
    expect(pembBookSqlSays(pembSeedBook($on, 'private')))->toBeTrue();
    expect(pembBookSqlSays(pembSeedBook($unset, 'private')))->toBeTrue(); // absent key = default ON
    // Anonymous/unknown creator: no users row to hold a preference — default ON.
    expect(pembBookSqlSays(pembSeedBook('no_such_user_'.Str::random(5), 'private')))->toBeTrue();
});

test('the PHP twin + ownerEmbedsPrivate agree with the SQL', function () {
    $off = pembSeedUser(['embed_private_books' => false]);

    expect(EmbeddingEligibility::ownerEmbedsPrivate($off))->toBeFalse();
    expect(EmbeddingEligibility::ownerEmbedsPrivate(pembSeedUser()))->toBeTrue();
    expect(EmbeddingEligibility::ownerEmbedsPrivate(null))->toBeTrue();

    $lib = (object) ['visibility' => 'private', 'type' => 'book', 'encrypted' => false, 'raw_json' => '[]'];
    expect(EmbeddingEligibility::bookEligible($lib, 'x', false))->toBeFalse();
    expect(EmbeddingEligibility::bookEligible($lib, 'x', true))->toBeTrue();
    expect(EmbeddingEligibility::bookEligible($lib, 'x'))->toBeTrue(); // omitted = weaker "could ever" question
    $pub = (object) ['visibility' => 'public', 'type' => 'book', 'encrypted' => false, 'raw_json' => '[]'];
    expect(EmbeddingEligibility::bookEligible($pub, 'x', false))->toBeTrue(); // public ignores the pref
});

test('QueueBookEmbeddings refuses an opted-out private book', function () {
    Queue::fake();
    $off = pembSeedUser(['embed_private_books' => false]);
    $book = pembSeedBook($off, 'private');

    (new QueueBookEmbeddings($book))->handle();

    Queue::assertNotPushed(GenerateNodeEmbedding::class);

    // Control: the same owner's PUBLIC book still embeds.
    (new QueueBookEmbeddings(pembSeedBook($off, 'public')))->handle();
    Queue::assertPushed(GenerateNodeEmbedding::class);
});

test('reconcile scrubs existing vectors after opt-out, and re-embeds after opt-in', function () {
    Queue::fake();
    $user = pembSeedUser(['embed_private_books' => false]);
    $book = pembSeedBook($user, 'private', withEmbedding: true);

    $this->artisan('embeddings:reconcile')->assertSuccessful();
    expect(pembAdmin()->table('nodes')->where('book', $book)->whereNotNull('embedding')->count())->toBe(0);

    // Opt back in: the next reconcile dispatches the re-embed.
    pembAdmin()->table('users')->where('name', $user)
        ->update(['preferences' => json_encode(['embed_private_books' => true])]);
    $this->artisan('embeddings:reconcile')->assertSuccessful();
    Queue::assertPushed(QueueBookEmbeddings::class, fn ($j) => $j->bookId === $book);
});

test('the preferences endpoint accepts the key', function () {
    $name = pembSeedUser();
    $user = \App\Models\User::on('pgsql_admin')->where('name', $name)->first();

    $this->actingAs($user)->postJson('/api/user/preferences', ['embed_private_books' => false])
        ->assertSuccessful();

    $stored = pembAdmin()->table('users')->where('name', $name)->value('preferences');
    expect(json_decode($stored, true)['embed_private_books'])->toBeFalse();
});
