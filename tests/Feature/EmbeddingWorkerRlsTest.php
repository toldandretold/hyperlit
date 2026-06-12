<?php

/**
 * Queue workers have NO RLS session context (no app.current_token), so any job
 * reading nodes/library through the DEFAULT connection silently sees nothing
 * for PRIVATE books. GenerateNodeEmbedding + QueueBookEmbeddings did exactly
 * that — 0 of 1.5M private-book nodes ever got an embedding while public books
 * worked (found 2026-06-12 via citation:doctor). Both jobs now go through
 * pgsql_admin; these tests run the jobs in a worker-like context (RLS vars
 * cleared) against a PRIVATE book and pin the fix.
 *
 * Setup goes through pgsql_admin (RLS blocks the default role's inserts), and
 * those rows COMMIT — clean them up in afterEach, mirroring
 * tests/Feature/Security/UserTokenRlsTest.php's inline-fixture pattern.
 */

use App\Jobs\GenerateNodeEmbedding;
use App\Jobs\QueueBookEmbeddings;
use App\Services\EmbeddingService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function makePrivateBookWithNode(): array
{
    $admin = DB::connection('pgsql_admin');
    $book = 'embrls_'.Str::random(10);
    $admin->table('library')->insert([
        'book' => $book, 'title' => 'embed rls test', 'creator' => 'embrls_owner',
        'visibility' => 'private', 'raw_json' => json_encode(['book' => $book]),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $admin->table('nodes')->insert([
        'book' => $book, 'chunk_id' => 0, 'startLine' => 1,
        'node_id' => $book.'_n1',
        'content' => '<p>private text long enough to be worth embedding for search</p>',
        'plainText' => 'private text long enough to be worth embedding for search',
        'raw_json' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $nodeId = $admin->table('nodes')->where('book', $book)->value('id');

    // Worker-like context: no authenticated RLS session on the default conn.
    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', '', false)");

    return [$book, $nodeId];
}

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    $admin->table('nodes')->where('book', 'like', 'embrls\_%')->delete();
    $admin->table('library')->where('book', 'like', 'embrls\_%')->delete();
});

test('GenerateNodeEmbedding embeds a PRIVATE book node from a worker context', function () {
    config(['services.llm.api_key' => 'test-key', 'services.llm.base_url' => 'https://llm.fake/v1']);
    Http::fake([
        'llm.fake/*' => Http::response(['data' => [['index' => 0, 'embedding' => array_fill(0, 768, 0.5)]]]),
    ]);

    [$book, $nodeId] = makePrivateBookWithNode();

    (new GenerateNodeEmbedding($nodeId))->handle(app(EmbeddingService::class));

    $embedded = DB::connection('pgsql_admin')->table('nodes')
        ->where('id', $nodeId)->whereNotNull('embedding')->exists();
    expect($embedded)->toBeTrue();
});

test('QueueBookEmbeddings dispatches jobs for a PRIVATE book from a worker context', function () {
    Queue::fake();

    [$book, $nodeId] = makePrivateBookWithNode();

    (new QueueBookEmbeddings($book))->handle();

    Queue::assertPushed(GenerateNodeEmbedding::class, 1);
});
