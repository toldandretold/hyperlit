<?php

/**
 * Embedding lifecycle — the 2026-08 audit fixes.
 *
 * Locks three behaviours:
 *   1. embeddings:reconcile dispatches QueueBookEmbeddings for eligible books
 *      with missing embeddings, and NOT for generated/synthetic books.
 *   2. embeddings:reconcile scrubs stray vectors from ineligible books while
 *      leaving eligible books' vectors alone.
 *   3. The editor bulk upsert NULLs a node's embedding when its content
 *      changes (so the book-level job re-embeds it) and keeps it when the
 *      content is unchanged — the "edited nodes keep pre-edit vectors
 *      forever" staleness bug.
 *
 * Inserts go through pgsql_admin (RLS bypass — see RetrievalScopeTest note);
 * fixtures use the 'book_embtest_' prefix and are wiped per-test since the
 * admin connection isn't covered by the test transaction.
 */

use App\Jobs\QueueBookEmbeddings;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function embAdminDb()
{
    return DB::connection('pgsql_admin');
}

beforeEach(function () {
    embAdminDb()->table('nodes')->whereRaw("book LIKE 'book_embtest_%'")->delete();
    embAdminDb()->table('library')->whereRaw("book LIKE 'book_embtest_%'")->delete();
    embAdminDb()->table('users')->whereRaw("email LIKE '%@embtest.test'")->delete();
});

function embSeedBook(array $opts): string
{
    $book = $opts['book'] ?? ('book_embtest_' . Str::random(8));
    embAdminDb()->table('library')->insert([
        'book' => $book,
        'title' => $opts['title'] ?? 'Embedding test book',
        'author' => 'Tester',
        'creator' => $opts['creator'] ?? 'embtester',
        'visibility' => $opts['visibility'] ?? 'public',
        'listed' => true,
        'type' => $opts['type'] ?? 'book',
        'has_nodes' => true,
        'raw_json' => $opts['raw_json'] ?? '[]',
        'timestamp' => 0,
    ]);

    embAdminDb()->table('nodes')->insert([
        'book' => $book,
        'chunk_id' => 0,
        'startLine' => 100,
        'node_id' => $book . '_node_1',
        'content' => '<p>' . ($opts['text'] ?? 'a paragraph with plenty of embedding-worthy text in it') . '</p>',
        'plainText' => $opts['text'] ?? 'a paragraph with plenty of embedding-worthy text in it',
        'embedding' => ($opts['withEmbedding'] ?? false)
            ? embAdminDb()->raw("'[" . implode(',', array_fill(0, 768, 0.1)) . "]'::halfvec")
            : null,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $book;
}

it('reconcile dispatches for eligible books with missing embeddings, not for synthetic books', function () {
    Queue::fake();

    $eligible = embSeedBook([]);
    $private = embSeedBook(['visibility' => 'private']);
    $shelf = embSeedBook(['raw_json' => json_encode(['type' => 'shelf', 'shelf_id' => 'x', 'sort' => 'recent'])]);
    $userHome = embSeedBook(['raw_json' => json_encode(['type' => 'user_home', 'username' => 'embtester'])]);
    $report = embSeedBook(['type' => 'report']);
    $covered = embSeedBook(['withEmbedding' => true]);

    $this->artisan('embeddings:reconcile')->assertSuccessful();

    Queue::assertPushed(QueueBookEmbeddings::class, function ($job) use ($eligible) {
        return (new ReflectionProperty($job, 'bookId'))->getValue($job) === $eligible;
    });
    Queue::assertPushed(QueueBookEmbeddings::class, function ($job) use ($private) {
        return (new ReflectionProperty($job, 'bookId'))->getValue($job) === $private;
    });
    foreach ([$shelf, $userHome, $report, $covered] as $notExpected) {
        Queue::assertNotPushed(QueueBookEmbeddings::class, function ($job) use ($notExpected) {
            return (new ReflectionProperty($job, 'bookId'))->getValue($job) === $notExpected;
        });
    }
});

it('reconcile scrubs stray embeddings on ineligible books and keeps eligible ones', function () {
    Queue::fake();

    $eligible = embSeedBook(['withEmbedding' => true]);
    $shelf = embSeedBook(['withEmbedding' => true, 'raw_json' => json_encode(['type' => 'shelf'])]);
    $report = embSeedBook(['withEmbedding' => true, 'type' => 'report']);

    $this->artisan('embeddings:reconcile')->assertSuccessful();

    expect(embAdminDb()->table('nodes')->where('book', $eligible)->whereNotNull('embedding')->count())->toBe(1)
        ->and(embAdminDb()->table('nodes')->where('book', $shelf)->whereNotNull('embedding')->count())->toBe(0)
        ->and(embAdminDb()->table('nodes')->where('book', $report)->whereNotNull('embedding')->count())->toBe(0);
});

it('bulk upsert NULLs the embedding when content changes and keeps it when unchanged', function () {
    Queue::fake();

    // Seed via admin — the default connection's RLS blocks raw user inserts
    // in tests (no HTTP middleware to set the session vars)
    $name = 'embtester_' . Str::random(6);
    $userId = embAdminDb()->table('users')->insertGetId([
        'name' => $name,
        'email' => Str::random(8) . '@embtest.test',
        'password' => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    $user = User::on('pgsql_admin')->find($userId);
    $book = embSeedBook(['creator' => $user->name, 'withEmbedding' => true]);
    $nodeId = $book . '_node_1';

    $payload = fn (string $content) => [
        'book' => $book,
        'data' => [[
            'book' => $book,
            'node_id' => $nodeId,
            'startLine' => 100,
            'chunk_id' => 0,
            'content' => $content,
            'footnotes' => [],
            'type' => 'p',
        ]],
    ];

    // Assert via the DEFAULT connection: the endpoint writes inside this
    // test's uncommitted transaction, which the admin connection can't see
    // (same gotcha as EncryptionTransitionTest).

    // Unchanged content → vector survives. NB the content string must match
    // the stored one byte-for-byte (it round-trips the sanitizer).
    $stored = embAdminDb()->table('nodes')->where('node_id', $nodeId)->value('content');
    $this->actingAs($user)->postJson('/api/db/nodes/bulk-create', $payload($stored))->assertOk();
    expect(DB::table('nodes')->where('node_id', $nodeId)->whereNotNull('embedding')->count())->toBe(1);

    // Changed content → vector NULLed (the book-level job then re-embeds)
    $this->actingAs($user)->postJson('/api/db/nodes/bulk-create', $payload('<p>a completely different paragraph of text</p>'))->assertOk();
    expect(DB::table('nodes')->where('node_id', $nodeId)->whereNotNull('embedding')->count())->toBe(0);

    // And the path still dispatches the re-embed job
    Queue::assertPushed(QueueBookEmbeddings::class);
});
