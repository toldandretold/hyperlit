<?php

/**
 * AI Archivist ask endpoint — the standalone answer book contract.
 *
 * A successful ask writes:
 *   - a PRIVATE standalone library row (type 'book', NOT 'sub_book', listed
 *     false, owned by the asker, title 'AI Archivist: …')
 *   - nodes for the answer (prompt + answer + appendix)
 *   - hypercite rows on the cited SOURCE books, marked creator='AIarchivist'
 *     with the asker granted co-author, citedIN pointing at the ANSWER book
 *   - the asker's "AI Archivist" shelf (find-or-create) with the answer book
 *     appended — a second ask reuses the same shelf
 *
 * LlmService + RetrievalService are mocked (retrieval privacy is locked
 * separately by RetrievalScopeTest); the book/node/hypercite/shelf writes are
 * real and asserted through pgsql_admin, then cleaned up.
 */

use App\Models\User;
use App\Services\BillingService;
use App\Services\LlmService;
use App\Services\RetrievalService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function askBookAdminConn()
{
    return DB::connection('pgsql_admin');
}

function makeAskBookUser(string $name): User
{
    $unique = $name . '_' . Str::random(8);
    $id = askBookAdminConn()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@askbooktest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'premium',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

function seedAskSourceBook(): array
{
    $bookId = 'book_asksource_' . Str::random(8);
    $nodeId = $bookId . '_node_1';
    askBookAdminConn()->table('library')->insert([
        'book'       => $bookId,
        'creator'    => 'ask_source_creator',
        'visibility' => 'public',
        'listed'     => true,
        'title'      => 'Delinking',
        'author'     => 'Samir Amin',
        'type'       => 'book',
        'has_nodes'  => true,
        'raw_json'   => json_encode([]),
        'timestamp'  => 0,
    ]);
    askBookAdminConn()->table('nodes')->insert([
        'book'       => $bookId,
        'chunk_id'   => 0,
        'startLine'  => 1,
        'node_id'    => $nodeId,
        'content'    => '<p>Delinking is not autarky but the submission of external relations to the logic of internal development.</p>',
        'plainText'  => 'Delinking is not autarky but the submission of external relations to the logic of internal development.',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return [$bookId, $nodeId];
}

function askSourceMatch(string $bookId, string $nodeId): object
{
    $m = new \stdClass();
    $m->id = 1;
    $m->book = $bookId;
    $m->node_id = $nodeId;
    $m->plainText = 'Delinking is not autarky but the submission of external relations to the logic of internal development.';
    $m->content = '<p>Delinking is not autarky but the submission of external relations to the logic of internal development.</p>';
    $m->book_title = 'Delinking';
    $m->book_author = 'Samir Amin';
    $m->book_year = '1985';
    $m->similarity = 0.91;
    return $m;
}

function mockAskLlm(int $askCount = 1, ?string $answerHtml = null): void
{
    // Each ask makes two chatWithFallback calls: router plan, then the answer
    // (which cites [1]). Mockery returns the listed values in sequence.
    $answerHtml ??= '<p>As Amin argues, development requires delinking [1]. This reframes the question entirely.</p>';
    $returns = [];
    for ($i = 0; $i < $askCount; $i++) {
        $returns[] = [
            'content' => '<search>{"keywords":"delinking","library_keywords":"Samir Amin","embedding_query":"delinking internal development"}</search>',
            'model'   => 'accounts/fireworks/models/deepseek-v4-pro-0813',
        ];
        $returns[] = [
            'content' => $answerHtml,
            'model'   => 'accounts/fireworks/models/deepseek-v4-pro-0813',
        ];
    }
    $mock = Mockery::mock(App\Services\LlmService::class);
    $mock->shouldReceive('chatWithFallback')->andReturn(...$returns);
    $mock->shouldReceive('getUsageStats')->andReturn(['by_model' => []]);
    $mock->shouldReceive('clearTransport');
    app()->instance(App\Services\LlmService::class, $mock);
}

function extractAskResult(string $body): array
{
    expect($body)->toContain('event: result');
    preg_match('/event: result\ndata: (\{.*?\})\n\n/s', $body, $m);
    $payload = json_decode($m[1] ?? '{}', true);
    expect($payload)->toBeArray()->and($payload['success'] ?? false)->toBeTrue();
    return $payload;
}

function cleanupAskArtifacts(string $creator, array $answerBookIds, string $sourceBookId): void
{
    // ⚠️ Deliberately does NOT delete the source book's library row here:
    // ask() ran update_annotations_timestamp on the DEFAULT connection, so the
    // test's still-open transaction holds a row lock on it — an admin-connection
    // delete would self-deadlock (the sync-refresh cross-connection class).
    // Source books are pattern-cleaned in beforeEach instead, when no
    // transaction is open.
    $admin = askBookAdminConn();
    foreach ($answerBookIds as $bid) {
        $admin->table('nodes')->where('book', $bid)->delete();
        $admin->table('library')->where('book', $bid)->delete();
    }
    $admin->table('hypercites')->where('book', $sourceBookId)->delete();
    $shelfIds = $admin->table('shelves')->where('creator', $creator)->pluck('id');
    foreach ($shelfIds as $sid) {
        $admin->table('shelf_items')->where('shelf_id', $sid)->delete();
    }
    $admin->table('shelves')->where('creator', $creator)->delete();
}

beforeEach(function () {
    $admin = askBookAdminConn();
    $admin->table('users')->whereRaw("email LIKE '%@askbooktest.test'")->delete();
    // Source books seeded by prior tests/runs (safe here: no open transaction
    // holds their library row locks yet — see cleanupAskArtifacts).
    $admin->table('nodes')->whereRaw("book LIKE 'book_asksource_%'")->delete();
    $admin->table('library')->whereRaw("book LIKE 'book_asksource_%'")->delete();
});

test('a successful ask writes a private standalone book, AIarchivist hypercites and the AI Archivist shelf', function () {
    $user = makeAskBookUser('ask_book_happy');
    [$sourceBookId, $sourceNodeId] = seedAskSourceBook();

    mockAskLlm();
    $this->mock(RetrievalService::class, function ($mock) use ($sourceBookId, $sourceNodeId) {
        $mock->shouldReceive('execute')->andReturn([
            'matches'   => [askSourceMatch($sourceBookId, $sourceNodeId)],
            'queryText' => null,
            'toolsUsed' => ['embedding_search'],
            'log'       => ['Embedding search (all books): 1 results'],
        ]);
        $mock->shouldNotReceive('executeLocalContext');
    });
    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldReceive('charge')->once();
    });

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', [
        'question' => 'What does delinking actually mean?',
    ]);

    $response->assertStatus(200);
    $result = extractAskResult($response->streamedContent());
    $answerBookId = $result['bookId'];
    expect($answerBookId)->toMatch('/^book_\d+$/');

    $admin = askBookAdminConn();

    // Library row: PRIVATE standalone book owned by the asker
    $lib = $admin->table('library')->where('book', $answerBookId)->first();
    expect($lib)->not->toBeNull();
    expect($lib->visibility)->toBe('private');
    expect((bool) $lib->listed)->toBeFalse();
    expect($lib->type)->toBe('book');
    expect($lib->creator)->toBe($user->name);
    expect($lib->title)->toStartWith('AI Archivist: ');
    expect($lib->author)->toBe('AI Archivist');

    // Nodes exist (prompt + answer + appendix)
    $nodes = $admin->table('nodes')->where('book', $answerBookId)->orderBy('startLine')->get();
    expect(count($nodes))->toBeGreaterThanOrEqual(3);

    // The answer node carries the inline ↗ anchor pointing at the SOURCE book
    $answerHtml = $nodes->pluck('content')->implode('');
    expect($answerHtml)->toContain('href="/' . $sourceBookId . '#hypercite_');

    // Hypercite row on the SOURCE book: AIarchivist mark + co-author grant +
    // citedIN pointing at the ANSWER book
    $hc = $admin->table('hypercites')->where('book', $sourceBookId)->first();
    expect($hc)->not->toBeNull();
    expect($hc->creator)->toBe('AIarchivist');
    $granted = json_decode($hc->access_granted, true);
    expect($granted)->toHaveKey($user->name);
    expect($granted[$user->name])->toBe('co-author');
    $citedIn = json_decode($hc->citedIN, true);
    expect($citedIn)->toHaveCount(1);
    expect($citedIn[0])->toStartWith('/' . $answerBookId . '#hypercite_');

    // The AI Archivist shelf exists with the answer book on it, and the result
    // event reports it
    $shelf = $admin->table('shelves')->where('creator', $user->name)->where('name', 'AI Archivist')->first();
    expect($shelf)->not->toBeNull();
    expect($shelf->visibility)->toBe('private');
    expect($admin->table('shelf_items')->where('shelf_id', $shelf->id)->where('book', $answerBookId)->exists())->toBeTrue();
    expect($result['shelf']['id'])->toBe($shelf->id);
    expect($result['shelf']['name'])->toBe('AI Archivist');

    cleanupAskArtifacts($user->name, [$answerBookId], $sourceBookId);
});

test('citation groups mint one hypercite per member behind a SINGLE ↗ chooser anchor', function () {
    $user = makeAskBookUser('ask_book_group');
    [$sourceBookId, $sourceNodeId] = seedAskSourceBook();

    // Second source in the same book (different node) so [1, 2] has two targets
    $secondNodeId = $sourceBookId . '_node_2';
    askBookAdminConn()->table('nodes')->insert([
        'book' => $sourceBookId, 'chunk_id' => 0, 'startLine' => 2, 'node_id' => $secondNodeId,
        'content' => '<p>A second passage on the same theme.</p>',
        'plainText' => 'A second passage on the same theme.',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $second = askSourceMatch($sourceBookId, $secondNodeId);
    $second->plainText = 'A second passage on the same theme.';

    // [1] [2] adjacent run → merged into one group; trailing [1] is a dupe → burned
    mockAskLlm(1, '<p>Both works treat this at length [1] [2], and neither touches the moon [1].</p>');
    $this->mock(RetrievalService::class, function ($mock) use ($sourceBookId, $sourceNodeId, $second) {
        $mock->shouldReceive('execute')->andReturn([
            'matches'   => [askSourceMatch($sourceBookId, $sourceNodeId), $second],
            'queryText' => null,
            'toolsUsed' => ['embedding_search'],
            'log'       => [],
        ]);
    });
    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldReceive('charge')->once();
    });

    $result = extractAskResult($this->actingAs($user)
        ->postJson('/api/ai-brain/ask', ['question' => 'What do these works cover?'])
        ->streamedContent());
    $answerBookId = $result['bookId'];

    $admin = askBookAdminConn();

    // One hypercite ROW per group member; the trailing duplicate [1] is burned
    $rows = $admin->table('hypercites')->where('book', $sourceBookId)->get();
    expect($rows)->toHaveCount(2);
    expect(collect($result['hypercites'])->pluck('node_id')->map(fn($n) => json_decode($n, true)[0])->sort()->values()->all())
        ->toBe(collect([$sourceNodeId, $secondNodeId])->sort()->values()->all());

    // …but ONE visible arrow: a single flat chooser anchor carrying the
    // data-cite-group payload (never consecutive ↗↗), literal ↗ not &nearr;
    $answerHtml = $admin->table('nodes')->where('book', $answerBookId)->orderBy('startLine')->get()
        ->pluck('content')->implode('');
    expect(substr_count($answerHtml, '↗'))->toBe(1);
    expect($answerHtml)->not->toContain('nearr');
    expect($answerHtml)->not->toContain('[1]');

    // libxml may re-serialize the attribute with either quote style
    preg_match('/<a id="(hypercite_[A-Za-z0-9]+)"[^>]*data-cite-group=(["\'])(.*?)\2/s', $answerHtml, $am);
    expect($am)->not->toBeEmpty();
    $anchorId = $am[1];
    $payload = json_decode(html_entity_decode($am[3], ENT_QUOTES), true);
    expect($payload)->toHaveCount(2);
    expect($payload[0])->toHaveKeys(['t', 's', 'q']);
    expect($payload[0]['t'])->toStartWith('/' . $sourceBookId . '#hypercite_');
    expect($payload[0]['s'])->toContain('Delinking');

    // Every member's citedIN points at the SHARED chooser anchor in the answer
    foreach ($rows as $row) {
        expect(json_decode($row->citedIN, true))->toBe(["/{$answerBookId}#{$anchorId}"]);
    }
    // The chooser anchor id is its own id, not either member's hypercite id
    expect($rows->pluck('hyperciteId')->all())->not->toContain($anchorId);

    cleanupAskArtifacts($user->name, [$answerBookId], $sourceBookId);
});

test('a second ask reuses the same AI Archivist shelf', function () {
    $user = makeAskBookUser('ask_book_reuse');
    [$sourceBookId, $sourceNodeId] = seedAskSourceBook();

    mockAskLlm(2);
    $this->mock(RetrievalService::class, function ($mock) use ($sourceBookId, $sourceNodeId) {
        $mock->shouldReceive('execute')->andReturn([
            'matches'   => [askSourceMatch($sourceBookId, $sourceNodeId)],
            'queryText' => null,
            'toolsUsed' => ['embedding_search'],
            'log'       => [],
        ]);
    });
    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldReceive('charge')->twice();
    });

    $first = extractAskResult($this->actingAs($user)
        ->postJson('/api/ai-brain/ask', ['question' => 'What does delinking mean?'])
        ->streamedContent());
    $second = extractAskResult($this->actingAs($user)
        ->postJson('/api/ai-brain/ask', ['question' => 'And what does it mean today?'])
        ->streamedContent());

    $admin = askBookAdminConn();
    $shelves = $admin->table('shelves')->where('creator', $user->name)->where('name', 'AI Archivist')->get();
    expect($shelves)->toHaveCount(1);
    expect($first['shelf']['id'])->toBe($shelves[0]->id);
    expect($second['shelf']['id'])->toBe($shelves[0]->id);
    expect($admin->table('shelf_items')->where('shelf_id', $shelves[0]->id)->count())->toBe(2);
    expect($first['bookId'])->not->toBe($second['bookId']);

    cleanupAskArtifacts($user->name, [$first['bookId'], $second['bookId']], $sourceBookId);
});
