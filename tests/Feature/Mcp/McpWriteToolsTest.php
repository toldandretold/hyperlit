<?php

use App\Mcp\TokenAbilities;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

/**
 * The book WRITE tools (update_node / append_nodes / cite_passage) over the
 * real /mcp endpoint. Same harness rules as McpServerTest: bearer-only
 * minting, forgetGuards between identities, admin-seeded fixtures; rows the
 * tools write ride the DEFAULT connection so RefreshDatabase rolls them back.
 */

beforeEach(function () {
    // Same workaround as McpAnnotationToolsTest/NotificationTriggerTest: the
    // hypercite upsert's afterCommit connection-score recompute runs on
    // pgsql_admin, which under RefreshDatabase deadlocks against the test's
    // wrapping transaction — no-op it.
    $this->app->instance(
        \App\Services\Connections\ConnectionRefresher::class,
        Mockery::mock(\App\Services\Connections\ConnectionRefresher::class, function ($mock) {
            $mock->shouldReceive('refresh')->zeroOrMoreTimes();
        })
    );
    // Keep WarmBookCacheJob / QueueBookEmbeddings from running inline on the
    // sync queue driver — the write path's dispatches are not under test here.
    Queue::fake();
});

function wtToken(User $user, array $abilities = [TokenAbilities::WRITE]): string
{
    return $user->createToken('mcp write', $abilities, now()->addYear())->plainTextToken;
}

function wtCall($test, string $token, string $tool, array $arguments)
{
    app('auth')->forgetGuards();

    return $test->postJson('/mcp', [
        'jsonrpc' => '2.0',
        'id' => 1,
        'method' => 'tools/call',
        'params' => ['name' => $tool, 'arguments' => $arguments],
    ], [
        'Authorization' => 'Bearer '.$token,
        'Accept' => 'application/json, text/event-stream',
    ]);
}

function wtText($response): string
{
    return (string) ($response->json('result.content.0.text') ?? '');
}

function wtJson($response): array
{
    return json_decode(wtText($response), true) ?: [];
}

function wtReadAs(User $user, callable $query)
{
    DB::statement("select set_config('app.current_user', ?, false)", [$user->name]);

    return $query();
}

/** An owned book with two nodes and a known library timestamp. */
function wtSeedBook($test, User $owner, string $visibility = 'private', int $timestamp = 1000): string
{
    $book = 'book_mcpw_'.Str::random(6);
    (function () use ($book, $owner, $visibility, $timestamp): void {
        $this->seedLibrary([
            'book' => $book,
            'title' => 'Write Fixture',
            'visibility' => $visibility,
            'creator' => $owner->name,
            'timestamp' => $timestamp,
        ]);
        $this->seedNode([
            'book' => $book,
            'startLine' => 100,
            'chunk_id' => 0,
            'node_id' => $book.'_1_aaa',
            'content' => '<p id="100" data-node-id="'.$book.'_1_aaa">The sea refuses no river at all.</p>',
            'plainText' => 'The sea refuses no river at all.',
        ]);
        $this->seedNode([
            'book' => $book,
            'startLine' => 200,
            'chunk_id' => 0,
            'node_id' => $book.'_2_bbb',
            'content' => '<p id="200" data-node-id="'.$book.'_2_bbb">Every estuary keeps its own ledger.</p>',
            'plainText' => 'Every estuary keeps its own ledger.',
        ]);
    })->call($test);

    return $book;
}

// ─── update_node ────────────────────────────────────────────────────────────

test('update_node replaces content, keeps position, and advances the content clock', function () {
    $user = $this->seedUser();
    $book = wtSeedBook($this, $user);
    $token = wtToken($user);

    $response = wtCall($this, $token, 'update_node', [
        'book' => $book,
        'node_id' => $book.'_1_aaa',
        'content' => '<p>The sea refuses no river, revised.</p>',
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();

    $row = wtReadAs($user, fn () => DB::table('nodes')
        ->where('book', $book)->where('node_id', $book.'_1_aaa')->first());
    expect($row->content)->toContain('revised');
    // Positional identity survives: stamped id attr = startLine, same node_id.
    expect($row->content)->toContain('id="100"')->toContain('data-node-id="'.$book.'_1_aaa"');
    expect((float) $row->startLine)->toBe(100.0);

    // The content clock moved past the seeded value, so BookCache re-misses.
    $ts = wtReadAs($user, fn () => DB::table('library')->where('book', $book)->value('timestamp'));
    expect((int) $ts)->toBeGreaterThan(1000);
});

test('update_node strips execution vectors via the write-path sanitizer', function () {
    $user = $this->seedUser();
    $book = wtSeedBook($this, $user);

    $response = wtCall($this, wtToken($user), 'update_node', [
        'book' => $book,
        'node_id' => $book.'_1_aaa',
        'content' => '<p onclick="alert(1)">Safe words<script>alert(2)</script></p>',
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();

    $row = wtReadAs($user, fn () => DB::table('nodes')
        ->where('book', $book)->where('node_id', $book.'_1_aaa')->first());
    expect($row->content)->not->toContain('onclick')->not->toContain('<script');
    expect($row->content)->toContain('Safe words');
});

test('update_node refuses a book the user does not own', function () {
    $owner = $this->seedUser();
    $book = wtSeedBook($this, $owner, 'public');
    $stranger = $this->seedUser();

    $response = wtCall($this, wtToken($stranger), 'update_node', [
        'book' => $book,
        'node_id' => $book.'_1_aaa',
        'content' => '<p>hijack</p>',
    ]);
    expect($response->json('result.isError'))->toBeTrue();
    expect(wtText($response))->toContain('own');

    $row = wtReadAs($owner, fn () => DB::table('nodes')
        ->where('book', $book)->where('node_id', $book.'_1_aaa')->first());
    expect($row->content)->not->toContain('hijack');
});

test('write tools are hidden from a token without the write ability', function () {
    $user = $this->seedUser();
    $book = wtSeedBook($this, $user);

    foreach (['update_node' => ['book' => $book, 'node_id' => 'x', 'content' => '<p>y</p>'],
        'append_nodes' => ['book' => $book, 'html' => '<p>y</p>'],
        'cite_passage' => ['citing_book' => $book, 'citing_node_id' => 'x', 'source_book' => $book, 'quote' => 'ledger'],
    ] as $tool => $args) {
        $response = wtCall($this, wtToken($user, [TokenAbilities::READ, TokenAbilities::ANNOTATE]), $tool, $args);
        // Ability-sized listing: hidden ⇒ tool-not-found at the protocol layer.
        expect($response->json('error.code'))->toBe(-32602);
    }
});

// ─── append_nodes ───────────────────────────────────────────────────────────

test('append_nodes mints positions server-side and keeps reading order', function () {
    $user = $this->seedUser();
    $book = wtSeedBook($this, $user);

    $response = wtCall($this, wtToken($user), 'append_nodes', [
        'book' => $book,
        'html' => '<h2>Afterword</h2><p>Rivers end, ledgers remain.</p>',
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $out = wtJson($response);
    expect($out['appended'])->toBe(2);

    $rows = wtReadAs($user, fn () => DB::table('nodes')->where('book', $book)
        ->orderByRaw('"startLine"::numeric')->get());
    expect($rows)->toHaveCount(4);
    // Continues from the real end: 200 → 300, 400.
    expect((float) $rows[2]->startLine)->toBe(300.0);
    expect((float) $rows[3]->startLine)->toBe(400.0);
    expect($rows[2]->content)->toContain('<h2')->toContain('Afterword');
    expect($rows[2]->type)->toBe('h2');
    expect($rows[3]->content)->toContain('Rivers end');
    // Server-stamped positional attributes.
    expect($rows[3]->content)->toContain('id="400"')->toContain('data-node-id="');
});

// ─── cite_passage ───────────────────────────────────────────────────────────

test('cite_passage completes a two-way hypercite into an owned book from a public source', function () {
    $user = $this->seedUser();
    $citing = wtSeedBook($this, $user);
    $sourceOwner = $this->seedUser();
    $source = wtSeedBook($this, $sourceOwner, 'public');

    $response = wtCall($this, wtToken($user), 'cite_passage', [
        'citing_book' => $citing,
        'citing_node_id' => $citing.'_2_bbb',
        'after_text' => 'its own ledger',
        'source_book' => $source,
        'quote' => 'The sea refuses no river',
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $out = wtJson($response);
    $hyperciteId = $out['hypercite_id'];
    $anchorId = $out['anchor_id'];

    // Citing side: the arrow sits right after after_text, word-joined.
    $node = wtReadAs($user, fn () => DB::table('nodes')
        ->where('book', $citing)->where('node_id', $citing.'_2_bbb')->first());
    expect($node->content)->toContain('its own ledger'."\u{2060}".'<a href="/'.$source.'#'.$hyperciteId.'"');
    expect($node->content)->toContain('id="'.$anchorId.'"')->toContain('class="open-icon"');

    // Cited side: the caller's OWN anchor row, coupled, pointing back.
    $row = wtReadAs($user, fn () => DB::table('hypercites')
        ->where('book', $source)->where('hyperciteId', $hyperciteId)->first());
    expect($row)->not->toBeNull();
    expect($row->creator)->toBe($user->name);
    expect($row->relationshipStatus)->toBe('couple');
    expect(json_decode($row->citedIN, true))->toContain('/'.$citing.'#'.$anchorId);
    expect($row->hypercitedText)->toContain('The sea refuses no river');

    // Citing book's content clock advanced (its node changed).
    $ts = wtReadAs($user, fn () => DB::table('library')->where('book', $citing)->value('timestamp'));
    expect((int) $ts)->toBeGreaterThan(1000);
});

test('cite_passage insert_quote inserts the VERBATIM anchored passage in quotes before the arrow', function () {
    $user = $this->seedUser();
    $citing = wtSeedBook($this, $user);
    $source = wtSeedBook($this, $user, 'public');

    $response = wtCall($this, wtToken($user), 'cite_passage', [
        'citing_book' => $citing,
        'citing_node_id' => $citing.'_2_bbb',
        'source_book' => $source,
        'quote' => 'The sea refuses no river',
        'insert_quote' => true,
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $out = wtJson($response);

    $node = wtReadAs($user, fn () => DB::table('nodes')
        ->where('book', $citing)->where('node_id', $citing.'_2_bbb')->first());
    // The web-paste shape, server-supplied: space, 'verbatim passage', U+2060, arrow.
    expect($node->content)->toContain(" 'The sea refuses no river'"."\u{2060}".'<a href="/'.$source.'#'.$out['hypercite_id'].'"');
});

test('cite_passage MERGES citedIN when reusing the caller\'s own anchor', function () {
    $user = $this->seedUser();
    $citing = wtSeedBook($this, $user);
    $source = wtSeedBook($this, $user, 'public');

    // Pre-existing anchor of the caller's with one citation already recorded.
    $hyperciteId = 'hypercite_'.Str::lower(Str::random(7));
    (function () use ($source, $hyperciteId, $user): void {
        $this->seedHypercite([
            'book' => $source,
            'hyperciteId' => $hyperciteId,
            'node_id' => [$source.'_1_aaa'],
            'charData' => [$source.'_1_aaa' => ['charStart' => 0, 'charEnd' => 10]],
            'hypercitedText' => 'The sea',
            'relationshipStatus' => 'couple',
            'citedIN' => ['/book_elsewhere#hypercite_old1'],
            'creator' => $user->name,
        ]);
    })->call($this);

    $response = wtCall($this, wtToken($user), 'cite_passage', [
        'citing_book' => $citing,
        'citing_node_id' => $citing.'_1_aaa',
        'source_book' => $source,
        'source_hypercite_id' => $hyperciteId,
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $anchorId = wtJson($response)['anchor_id'];

    $citedIn = wtReadAs($user, fn () => json_decode(DB::table('hypercites')
        ->where('book', $source)->where('hyperciteId', $hyperciteId)->value('citedIN'), true));
    expect($citedIn)->toContain('/book_elsewhere#hypercite_old1')
        ->toContain('/'.$citing.'#'.$anchorId);
});

test('cite_passage refuses: citing book not owned, private foreign source, foreign anchor', function () {
    $user = $this->seedUser();
    $other = $this->seedUser();
    $own = wtSeedBook($this, $user);
    $othersBook = wtSeedBook($this, $other, 'public');
    $othersPrivate = wtSeedBook($this, $other, 'private');

    // 1. Citing INTO someone else's book is refused outright.
    $r1 = wtCall($this, wtToken($user), 'cite_passage', [
        'citing_book' => $othersBook, 'citing_node_id' => $othersBook.'_1_aaa',
        'source_book' => $own, 'quote' => 'The sea refuses no river',
    ]);
    expect($r1->json('result.isError'))->toBeTrue();
    expect(wtText($r1))->toContain('own');

    // 2. A private source book the user cannot read yields no anchorable nodes.
    $r2 = wtCall($this, wtToken($user), 'cite_passage', [
        'citing_book' => $own, 'citing_node_id' => $own.'_1_aaa',
        'source_book' => $othersPrivate, 'quote' => 'The sea refuses no river',
    ]);
    expect($r2->json('result.isError'))->toBeTrue();

    // 3. Reusing someone ELSE's anchor row is refused (never mutate it).
    $hyperciteId = 'hypercite_'.Str::lower(Str::random(7));
    (function () use ($othersBook, $hyperciteId, $other): void {
        $this->seedHypercite([
            'book' => $othersBook,
            'hyperciteId' => $hyperciteId,
            'node_id' => [$othersBook.'_1_aaa'],
            'charData' => [$othersBook.'_1_aaa' => ['charStart' => 0, 'charEnd' => 7]],
            'hypercitedText' => 'The sea',
            'relationshipStatus' => 'single',
            'citedIN' => [],
            'creator' => $other->name,
        ]);
    })->call($this);
    $r3 = wtCall($this, wtToken($user), 'cite_passage', [
        'citing_book' => $own, 'citing_node_id' => $own.'_1_aaa',
        'source_book' => $othersBook, 'source_hypercite_id' => $hyperciteId,
    ]);
    expect($r3->json('result.isError'))->toBeTrue();
    expect(wtText($r3))->toContain('someone else');
});

// ─── import guard + payload parity (plan's coherence fixes) ────────────────

test('import_document refuses content carrying hypercite markup (dead-arrow guard)', function () {
    $user = $this->seedUser();
    $token = $user->createToken('mcp imp', [TokenAbilities::IMPORT], now()->addYear())->plainTextToken;

    $response = wtCall($this, $token, 'import_document', [
        'title' => 'Essay With Arrows',
        'content' => "Prose citing 'the sea'\u{2060}<a href=\"https://hyperlit.test/book_x#hypercite_abc1234\" id=\"hypercite_abc1234\" class=\"open-icon\">↗</a> inline.",
    ]);
    expect($response->json('result.isError'))->toBeTrue();
    expect(wtText($response))->toContain('cite_passage');
});

test('create_hypercite returns the web-parity clipboard payload', function () {
    $user = $this->seedUser();
    $book = wtSeedBook($this, $user);
    $token = $user->createToken('mcp an', [TokenAbilities::ANNOTATE], now()->addYear())->plainTextToken;

    $response = wtCall($this, $token, 'create_hypercite', [
        'book' => $book, 'quote' => 'Every estuary keeps',
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $out = wtJson($response);
    // id attribute (annotationPaste matcher) + U+2060 (unmint regex shape).
    expect($out['citation_html'])->toContain('id="'.$out['hypercite_id'].'"');
    expect($out['citation_html'])->toContain("\u{2060}".'<a ');
});

// ─── Arrow stacking → ONE grouped arrow (the archivist's "never two in a row") ──

test('cite_passage merges a second citation at the same spot into ONE grouped arrow', function () {
    $user = $this->seedUser();
    $citing = wtSeedBook($this, $user);
    $source = wtSeedBook($this, $user, 'public');
    $token = wtToken($user);

    $first = wtJson(wtCall($this, $token, 'cite_passage', [
        'citing_book' => $citing,
        'citing_node_id' => $citing.'_2_bbb',
        'after_text' => 'its own ledger.',
        'source_book' => $source,
        'quote' => 'The sea refuses no river',
    ]));

    $second = wtCall($this, $token, 'cite_passage', [
        'citing_book' => $citing,
        'citing_node_id' => $citing.'_2_bbb',
        'after_text' => 'its own ledger.',
        'source_book' => $source,
        'quote' => 'Every estuary keeps',
    ]);
    expect($second->json('result.isError'))->not->toBeTrue();
    $out = wtJson($second);
    // The merged citation reports the EXISTING anchor as its citing-side id.
    expect($out['anchor_id'])->toBe($first['anchor_id']);
    expect($out['message'])->toContain('MERGED');

    $node = wtReadAs($user, fn () => DB::table('nodes')
        ->where('book', $citing)->where('node_id', $citing.'_2_bbb')->first());

    // Exactly ONE arrow anchor — never two ↗ in a row.
    expect(substr_count($node->content, 'class="open-icon"'))->toBe(1);
    expect(substr_count($node->content, '↗'))->toBe(1);

    // It is a GROUP arrow carrying both members in reading order.
    preg_match('/data-cite-group="([^"]*)"/', $node->content, $m);
    expect($m)->not->toBeEmpty();
    $members = json_decode(html_entity_decode($m[1], ENT_QUOTES), true);
    expect($members)->toHaveCount(2);
    expect($members[0]['t'])->toBe('/'.$source.'#'.$first['hypercite_id']);
    expect($members[1]['t'])->toBe('/'.$source.'#'.$out['hypercite_id']);
    expect($members[1]['s'])->toContain('Write Fixture');
    expect($members[1]['q'])->toContain('Every estuary keeps');

    // BOTH source rows cite back at the one shared anchor id.
    foreach ([$first['hypercite_id'], $out['hypercite_id']] as $hid) {
        $row = wtReadAs($user, fn () => DB::table('hypercites')
            ->where('book', $source)->where('hyperciteId', $hid)->first());
        expect(json_decode($row->citedIN, true))->toContain('/'.$citing.'#'.$first['anchor_id']);
    }
});

test('a third citation at the same spot joins the existing group', function () {
    $user = $this->seedUser();
    $citing = wtSeedBook($this, $user);
    $source = wtSeedBook($this, $user, 'public');
    $token = wtToken($user);

    foreach (['The sea refuses no river', 'Every estuary keeps', 'no river at all'] as $quote) {
        $response = wtCall($this, $token, 'cite_passage', [
            'citing_book' => $citing,
            'citing_node_id' => $citing.'_2_bbb',
            'source_book' => $source,
            'quote' => $quote,
        ]);
        expect($response->json('result.isError'))->not->toBeTrue();
    }

    $node = wtReadAs($user, fn () => DB::table('nodes')
        ->where('book', $citing)->where('node_id', $citing.'_2_bbb')->first());
    expect(substr_count($node->content, 'class="open-icon"'))->toBe(1);
    preg_match('/data-cite-group="([^"]*)"/', $node->content, $m);
    $members = json_decode(html_entity_decode($m[1], ENT_QUOTES), true);
    expect($members)->toHaveCount(3);
});

test('an insert_quote citation never merges — the quoted text separates the arrows', function () {
    $user = $this->seedUser();
    $citing = wtSeedBook($this, $user);
    $source = wtSeedBook($this, $user, 'public');
    $token = wtToken($user);

    wtCall($this, $token, 'cite_passage', [
        'citing_book' => $citing,
        'citing_node_id' => $citing.'_2_bbb',
        'source_book' => $source,
        'quote' => 'The sea refuses no river',
    ]);
    $second = wtCall($this, $token, 'cite_passage', [
        'citing_book' => $citing,
        'citing_node_id' => $citing.'_2_bbb',
        'source_book' => $source,
        'quote' => 'Every estuary keeps',
        'insert_quote' => true,
    ]);
    expect($second->json('result.isError'))->not->toBeTrue();

    $node = wtReadAs($user, fn () => DB::table('nodes')
        ->where('book', $citing)->where('node_id', $citing.'_2_bbb')->first());
    // Two arrows is fine HERE: the verbatim quote sits between them.
    expect(substr_count($node->content, 'class="open-icon"'))->toBe(2);
    expect($node->content)->not->toContain('data-cite-group');
});

// ─── Honest concurrency: the base clock is the READ-time clock ─────────────

test('a write whose base clock predates a concurrent edit is refused, not merged over it', function () {
    $user = $this->seedUser();
    $book = wtSeedBook($this, $user); // seeded clock = 1000

    // A concurrent writer lands AFTER our (simulated) read: the real
    // update_node call advances the content clock past the seeded 1000 — and
    // as a side effect seats the RLS session context for the direct sync below.
    $interleaved = wtCall($this, wtToken($user), 'update_node', [
        'book' => $book,
        'node_id' => $book.'_1_aaa',
        'content' => '<p>Concurrent edit landed.</p>',
    ]);
    expect($interleaved->json('result.isError'))->not->toBeTrue();

    // Our write still carries the clock from BEFORE that edit (the seeded
    // 1000) → the honest answer is the 409, not a silent overwrite. This is
    // the exact lost-update shape that ate three arrows in the OpenCode run.
    $node = wtReadAs($user, fn () => DB::table('nodes')
        ->where('book', $book)->where('node_id', $book.'_1_aaa')->first());
    expect($node)->not->toBeNull();

    $stale = \App\Mcp\Support\BookContentWriter::sync(
        $user,
        $book,
        [\App\Mcp\Support\BookContentWriter::nodeItemFrom($node, '<p id="100" data-node-id="'.$book.'_1_aaa">Derived from a stale read.</p>')],
        [],
        1000,
    );
    expect($stale['ok'])->toBeFalse();
    expect($stale['error'])->toContain('concurrent');
    expect($stale['result']['error'] ?? null)->toBe('STALE_DATA');

    // The concurrent edit survived — nothing was silently overwritten.
    $row = wtReadAs($user, fn () => DB::table('nodes')
        ->where('book', $book)->where('node_id', $book.'_1_aaa')->first());
    expect($row->content)->toContain('Concurrent edit landed');
});
