<?php

use App\Mcp\TokenAbilities;
use App\Models\PgHyperlight;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The annotation WRITE tools over the real /mcp endpoint. Same harness rules
 * as McpServerTest (bearer-only minting, forgetGuards between identities,
 * admin-seeded fixtures). Written rows ride the DEFAULT connection, so
 * RefreshDatabase rolls them back.
 */

beforeEach(function () {
    // The hypercite upsert's afterCommit connection-score recompute runs on
    // pgsql_admin; under RefreshDatabase the afterCommit fires INSIDE the
    // test's wrapping transaction, whose library-row locks the recompute
    // UPDATEs against — the cross-connection wedge the deferral fixes in
    // prod. Same workaround as NotificationTriggerTest: no-op the refresher.
    $this->app->instance(
        \App\Services\Connections\ConnectionRefresher::class,
        Mockery::mock(\App\Services\Connections\ConnectionRefresher::class, function ($mock) {
            $mock->shouldReceive('refresh')->zeroOrMoreTimes();
        })
    );
});

function annotToken(User $user, array $abilities = [TokenAbilities::ANNOTATE]): string
{
    return $user->createToken('mcp annot', $abilities, now()->addYear())->plainTextToken;
}

function annotCall($test, string $token, string $tool, array $arguments)
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

function annotText($response): string
{
    return (string) ($response->json('result.content.0.text') ?? '');
}

/** The tool's JSON result, decoded (Response::json returns it as the text block). */
function annotJson($response): array
{
    return json_decode(annotText($response), true) ?: [];
}

/**
 * Read a row written by the tools. The tools write through the DEFAULT pgsql
 * connection (inside RefreshDatabase's transaction), so pgsql_admin — a
 * separate connection — can't see the uncommitted row; and the default
 * connection is RLS-gated, so the read needs the owner's app.current_user.
 * Same split CharDataRecalcTest uses (HTTP-written rows read on default).
 */
function readAs(User $user, callable $query)
{
    DB::statement("select set_config('app.current_user', ?, false)", [$user->name]);

    return $query();
}

function readHl(User $user, string $book, string $id): ?PgHyperlight
{
    return readAs($user, fn () => PgHyperlight::where('book', $book)->where('hyperlight_id', $id)->first());
}

function seedAnnotBook($test, User $owner): string
{
    $book = 'book_mcpa_'.Str::random(6);
    (function () use ($book, $owner): void {
        $this->seedLibrary([
            'book' => $book,
            'title' => 'Annotation Fixture',
            'visibility' => 'private',
            'creator' => $owner->name,
        ]);
        $this->seedNode([
            'book' => $book,
            'startLine' => 100,
            'chunk_id' => 0,
            'node_id' => $book.'_1_aaa',
            'content' => '<p id="100" data-node-id="'.$book.'_1_aaa">Money &amp; credit precede barter in the record.</p>',
            'plainText' => 'Money &amp; credit precede barter in the record.',
        ]);
        $this->seedNode([
            'book' => $book,
            'startLine' => 200,
            'chunk_id' => 0,
            'node_id' => $book.'_2_bbb',
            'content' => '<p id="200" data-node-id="'.$book.'_2_bbb">Debt comes first. Debt comes first.</p>',
            'plainText' => 'Debt comes first. Debt comes first.',
        ]);
    })->call($test);

    return $book;
}

test('create_highlight anchors a quote with client-space offsets and server-side attribution', function () {
    $user = $this->seedUser();
    $book = seedAnnotBook($this, $user);
    $token = annotToken($user);

    $response = annotCall($this, $token, 'create_highlight', [
        'book' => $book,
        'quote' => 'Money & credit precede barter',
        'annotation' => 'Graeber\'s core claim.',
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    $text = annotText($response);
    expect($text)->toContain('HL_');

    $id = annotJson($response)['hyperlight_id'];
    $row = readHl($user, $book, $id);

    expect($row)->not->toBeNull();
    expect($row->creator)->toBe($user->name);
    // Offsets measured in the DECODED text ("Money & credit…"), from 0.
    expect($row->charData[$book.'_1_aaa'])->toEqualCanonicalizing(['charStart' => 0, 'charEnd' => 29]);
    expect($row->annotation)->toContain('Graeber');
    expect($row->highlightedText)->toBe('Money & credit precede barter');
});

test('highlighting a book you own defaults to public; a book you do not own defaults to private', function () {
    $owner = $this->seedUser();
    $reader = $this->seedUser();

    // A PUBLIC book owned by someone else, with a quotable node.
    $book = 'book_vis_'.Str::random(6);
    (function () use ($book, $owner) {
        $this->seedLibrary(['book' => $book, 'title' => 'Public Work', 'visibility' => 'public', 'creator' => $owner->name]);
        $this->seedNode([
            'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $book.'_1_aaa',
            'content' => '<p id="100" data-node-id="'.$book.'_1_aaa">A shared sentence to annotate.</p>',
            'plainText' => 'A shared sentence to annotate.',
        ]);
    })->call($this);

    // Visibility is stored as the annotation sub-book library row's visibility.
    $subVis = fn (User $u, string $hlId) => readAs($u, fn () => DB::table('library')
        ->where('book', $book.'/'.$hlId)->value('visibility'));

    // The READER (not the owner) highlights it with no visibility arg → private.
    $r1 = annotCall($this, annotToken($reader), 'create_highlight', ['book' => $book, 'quote' => 'shared sentence']);
    expect($r1->json('result.isError'))->not->toBeTrue();
    expect($subVis($reader, annotJson($r1)['hyperlight_id']))->toBe('private');

    // The OWNER highlights their own book with no arg → public.
    $r2 = annotCall($this, annotToken($owner), 'create_highlight', ['book' => $book, 'quote' => 'to annotate']);
    expect($r2->json('result.isError'))->not->toBeTrue();
    expect($subVis($owner, annotJson($r2)['hyperlight_id']))->toBe('public');
});

test('an ambiguous quote returns contexts; occurrence disambiguates', function () {
    $user = $this->seedUser();
    $book = seedAnnotBook($this, $user);
    $token = annotToken($user);

    $ambiguous = annotCall($this, $token, 'create_highlight', [
        'book' => $book, 'quote' => 'Debt comes first',
    ]);
    expect($ambiguous->json('result.isError'))->toBeTrue();
    expect(annotText($ambiguous))->toContain('occurrence')->toContain('1.')->toContain('2.');

    $second = annotCall($this, $token, 'create_highlight', [
        'book' => $book, 'quote' => 'Debt comes first', 'occurrence' => 2,
    ]);
    expect($second->json('result.isError'))->not->toBeTrue();

    $row = readHl($user, $book, annotJson($second)['hyperlight_id']);
    expect($row->charData[$book.'_2_bbb'])->toEqualCanonicalizing(['charStart' => 18, 'charEnd' => 34]);
});

test('update_highlight edits the note and visibility; another user\'s highlight is refused', function () {
    $owner = $this->seedUser();
    $book = seedAnnotBook($this, $owner);
    $token = annotToken($owner);

    $create = annotCall($this, $token, 'create_highlight', ['book' => $book, 'quote' => 'precede barter']);
    $id = annotJson($create)['hyperlight_id'];

    $update = annotCall($this, $token, 'update_highlight', [
        'book' => $book, 'hyperlight_id' => $id,
        'annotation' => 'Revised note.', 'visibility' => 'private',
    ]);
    expect($update->json('result.isError'))->not->toBeTrue();

    $row = readHl($owner, $book, $id);
    expect($row->annotation)->toContain('Revised note.');
    // The anchor survived the update untouched.
    expect($row->highlightedText)->toBe('precede barter');

    // A stranger's token cannot update it.
    $stranger = $this->seedUser();
    $refused = annotCall($this, annotToken($stranger), 'update_highlight', [
        'book' => $book, 'hyperlight_id' => $id, 'annotation' => 'hijack',
    ]);
    expect($refused->json('result.isError'))->toBeTrue();
    expect(readHl($owner, $book, $id)->annotation)->not->toContain('hijack');
});

test('delete_highlight removes the row; hide mode flips hidden', function () {
    $user = $this->seedUser();
    $book = seedAnnotBook($this, $user);
    $token = annotToken($user);

    // Seed the highlight COMMITTED (via admin): the hide endpoint persists its
    // moderation flag through pgsql_admin (the UPDATE RLS policy is creator-
    // only), which can't see a row still uncommitted on the default connection
    // — a test-harness connection artifact, not a product path (in prod the
    // create committed long before). seedHyperlight gives it a real owner.
    $id = 'HL_'.now()->getTimestampMs();
    (function () use ($book, $id, $user) {
        $this->seedHyperlight([
            'book' => $book,
            'hyperlight_id' => $id,
            'node_id' => [$book.'_1_aaa'],
            'charData' => [$book.'_1_aaa' => ['charStart' => 16, 'charEnd' => 30]],
            'highlightedText' => 'precede barter',
            'startLine' => 100,
            'creator' => $user->name,
        ]);
    })->call($this);

    $hide = annotCall($this, $token, 'delete_highlight', [
        'book' => $book, 'hyperlight_id' => $id, 'mode' => 'hide',
    ]);
    expect($hide->json('result.isError'))->not->toBeTrue();
    expect((bool) readHl($user, $book, $id)->hidden)->toBeTrue();

    $delete = annotCall($this, $token, 'delete_highlight', [
        'book' => $book, 'hyperlight_id' => $id,
    ]);
    expect($delete->json('result.isError'))->not->toBeTrue();
    expect(readHl($user, $book, $id))->toBeNull();

    // Deleting it again is an honest error, not a silent success.
    $again = annotCall($this, $token, 'delete_highlight', [
        'book' => $book, 'hyperlight_id' => $id,
    ]);
    expect($again->json('result.isError'))->toBeTrue();
});

test('create_hypercite mints a citable anchor with a deep link', function () {
    $user = $this->seedUser();
    $book = seedAnnotBook($this, $user);
    $token = annotToken($user);

    $response = annotCall($this, $token, 'create_hypercite', [
        'book' => $book, 'quote' => 'Money & credit precede barter',
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $text = annotText($response);
    expect($text)->toContain('hypercite_')->toContain('#hypercite_');

    $hyperciteId = annotJson($response)['hypercite_id'];
    $row = readAs($user, fn () => DB::table('hypercites')
        ->where('book', $book)->where('hyperciteId', $hyperciteId)->first());
    expect($row)->not->toBeNull();
    expect($row->relationshipStatus ?? 'single')->toBe('single');
});

test('a read-only token cannot use the write tools', function () {
    $user = $this->seedUser();
    $book = seedAnnotBook($this, $user);
    $readOnly = annotToken($user, [TokenAbilities::READ]);

    $response = annotCall($this, $readOnly, 'create_highlight', [
        'book' => $book, 'quote' => 'precede barter',
    ]);
    expect($response->json('result.isError'))->toBeTrue();
    expect(annotText($response))->toContain("'annotate' ability");
    expect(readAs($user, fn () => PgHyperlight::where('book', $book)->exists()))->toBeFalse();
});

test('modify_shelf drives the full shelf lifecycle', function () {
    $user = $this->seedUser();
    $book = seedAnnotBook($this, $user);
    $token = annotToken($user);

    $create = annotCall($this, $token, 'modify_shelf', [
        'action' => 'create', 'name' => 'MCP Reading List',
    ]);
    expect($create->json('result.isError'))->not->toBeTrue();
    $shelfId = DB::table('shelves')->where('creator', $user->name)
        ->where('name', 'MCP Reading List')->value('id');
    expect($shelfId)->not->toBeNull();

    $add = annotCall($this, $token, 'modify_shelf', [
        'action' => 'add_book', 'shelf_id' => (string) $shelfId, 'book' => $book,
    ]);
    expect($add->json('result.isError'))->not->toBeTrue();
    expect(DB::table('shelf_items')->where('shelf_id', $shelfId)->where('book', $book)->exists())->toBeTrue();

    $remove = annotCall($this, $token, 'modify_shelf', [
        'action' => 'remove_book', 'shelf_id' => (string) $shelfId, 'book' => $book,
    ]);
    expect($remove->json('result.isError'))->not->toBeTrue();
    expect(DB::table('shelf_items')->where('shelf_id', $shelfId)->exists())->toBeFalse();

    $delete = annotCall($this, $token, 'modify_shelf', [
        'action' => 'delete', 'shelf_id' => (string) $shelfId,
    ]);
    expect($delete->json('result.isError'))->not->toBeTrue();
    expect(DB::table('shelves')->where('id', $shelfId)->exists())->toBeFalse();
});



