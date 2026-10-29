<?php

use App\Mcp\TokenAbilities;
use App\Models\User;
use Illuminate\Support\Str;

/**
 * The MCP endpoint end to end: JSON-RPC over POST /mcp with a bearer token,
 * through the REAL middleware stack — which is the point. laravel/mcp's own
 * test harness ($server->actingAs()->tool()) skips HTTP middleware entirely,
 * and the thing most worth pinning here is that the /mcp route's middleware
 * order (auth:sanctum BEFORE SetDatabaseSessionContext) gives every tool the
 * token user's RLS context. Same harness traps as ApiTokenManagementTest:
 * bearer tokens are minted via createToken() (never actingAs), and tests
 * sending two identities forgetGuards() between requests.
 */

function mcpToken(User $user, array $abilities = [TokenAbilities::READ]): string
{
    return $user->createToken('mcp test', $abilities, now()->addYear())->plainTextToken;
}

function mcpCall($test, string $token, string $method, array $params = [])
{
    app('auth')->forgetGuards();

    return $test->postJson('/mcp', [
        'jsonrpc' => '2.0',
        'id' => 1,
        'method' => $method,
        'params' => $params,
    ], [
        'Authorization' => 'Bearer '.$token,
        'Accept' => 'application/json, text/event-stream',
    ]);
}

/** The text payload of the first content block of a tools/call result. */
function mcpToolText($response): string
{
    $result = $response->json('result');
    expect($result)->not->toBeNull();

    return (string) ($result['content'][0]['text'] ?? '');
}

function seedReadableBook($test, User $owner, string $visibility = 'private'): string
{
    $book = 'book_mcp_'.Str::random(6);

    // seedLibrary/seedNode are protected on SeedsRlsFixtures — bind in.
    (function () use ($book, $owner, $visibility): void {
        $this->seedLibrary([
            'book' => $book,
            'title' => 'MCP Fixture Book',
            'author' => 'Fixture Author',
            'visibility' => $visibility,
            'creator' => $owner->name,
        ]);
        $this->seedNode([
            'book' => $book,
            'startLine' => 100,
            'chunk_id' => 0,
            'node_id' => $book.'_1_aaa',
            'content' => '<h1 id="100" data-node-id="'.$book.'_1_aaa">The Mirror &amp; the Lamp</h1>',
            'plainText' => 'The Mirror &amp; the Lamp',
        ]);
        $this->seedNode([
            'book' => $book,
            'startLine' => 200,
            'chunk_id' => 0,
            'node_id' => $book.'_2_bbb',
            'content' => '<p id="200" data-node-id="'.$book.'_2_bbb">Romantic theory treats art as expression.</p>',
            'plainText' => 'Romantic theory treats art as expression.',
        ]);
    })->call($test);

    return $book;
}

test('the endpoint requires authentication', function () {
    $this->postJson('/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping'])
        ->assertStatus(401);
});

test('initialize identifies the Hyperlit server', function () {
    $token = mcpToken($this->seedUser());

    $response = mcpCall($this, $token, 'initialize', [
        'protocolVersion' => '2025-06-18',
        'capabilities' => [],
        'clientInfo' => ['name' => 'pest', 'version' => '1.0'],
    ]);

    $response->assertOk();
    expect($response->json('result.serverInfo.name'))->toBe('Hyperlit');
    expect($response->json('result.instructions'))->toContain('HYPERLIGHT');
});

test('tools/list exposes the v1 read toolset', function () {
    $token = mcpToken($this->seedUser());

    $response = mcpCall($this, $token, 'tools/list');

    $names = collect($response->json('result.tools'))->pluck('name');
    expect($names)->toContain('list_books', 'search_library', 'search_text',
        'get_book', 'read_book', 'list_annotations', 'list_shelves');

    $readBook = collect($response->json('result.tools'))->firstWhere('name', 'read_book');
    expect($readBook['annotations']['readOnlyHint'] ?? null)->toBeTrue();
});

test('list_books returns the token user\'s own books', function () {
    $user = $this->seedUser();
    $book = seedReadableBook($this, $user);
    $token = mcpToken($user);

    $response = mcpCall($this, $token, 'tools/call', [
        'name' => 'list_books',
        'arguments' => [],
    ]);

    expect(mcpToolText($response))->toContain($book)->toContain('MCP Fixture Book');
});

test('read_book reads a PRIVATE own book through the token RLS context, entity-decoded and paginated', function () {
    $user = $this->seedUser();
    $book = seedReadableBook($this, $user);
    $token = mcpToken($user);

    $response = mcpCall($this, $token, 'tools/call', [
        'name' => 'read_book',
        'arguments' => ['book' => $book],
    ]);

    $text = mcpToolText($response);
    // Entities DECODED (the client coordinate space), not the raw plainText.
    expect($text)->toContain('The Mirror & the Lamp')
        ->toContain('Romantic theory treats art as expression.');

    // Pagination: a 1-char budget still returns the first node, then points
    // at it as the resume cursor.
    $paged = mcpCall($this, $token, 'tools/call', [
        'name' => 'read_book',
        'arguments' => ['book' => $book, 'max_chars' => 1000, 'after_line' => 100],
    ]);
    $pagedText = mcpToolText($paged);
    expect($pagedText)->toContain('Romantic theory')->not->toContain('Mirror');
});

test('another user\'s token cannot read a private book', function () {
    $owner = $this->seedUser();
    $book = seedReadableBook($this, $owner);
    $stranger = $this->seedUser();
    $token = mcpToken($stranger);

    $response = mcpCall($this, $token, 'tools/call', [
        'name' => 'read_book',
        'arguments' => ['book' => $book],
    ]);

    expect($response->json('result.isError'))->toBeTrue();
    expect(mcpToolText($response))->not->toContain('Romantic theory');
});

test('a token without the read ability is refused with a named ability', function () {
    $user = $this->seedUser();
    seedReadableBook($this, $user);
    $token = mcpToken($user, [TokenAbilities::ANNOTATE]);

    $response = mcpCall($this, $token, 'tools/call', [
        'name' => 'list_books',
        'arguments' => [],
    ]);

    expect($response->json('result.isError'))->toBeTrue();
    expect(mcpToolText($response))->toContain("'read' ability");
});

test('an encrypted book is refused for content, allowed for metadata', function () {
    $user = $this->seedUser();
    $book = 'book_mcp_e2ee_'.Str::random(6);
    $this->seedLibrary([
        'book' => $book,
        'title' => 'Sealed Book',
        'visibility' => 'private',
        'creator' => $user->name,
        'encrypted' => true,
    ]);
    \App\Services\E2ee\EncryptedBookGuard::forget($book);
    $token = mcpToken($user);

    $read = mcpCall($this, $token, 'tools/call', [
        'name' => 'read_book',
        'arguments' => ['book' => $book],
    ]);
    expect($read->json('result.isError'))->toBeTrue();
    expect(mcpToolText($read))->toContain('end-to-end encrypted');

    $meta = mcpCall($this, $token, 'tools/call', [
        'name' => 'get_book',
        'arguments' => ['book' => $book],
    ]);
    expect($meta->json('result.isError'))->not->toBeTrue();
    expect(mcpToolText($meta))->toContain('Sealed Book')->toContain('"encrypted": true');

    \App\Services\E2ee\EncryptedBookGuard::forget($book);
});

test('get_book returns metadata plus table of contents', function () {
    $user = $this->seedUser();
    $book = seedReadableBook($this, $user);
    $token = mcpToken($user);

    $response = mcpCall($this, $token, 'tools/call', [
        'name' => 'get_book',
        'arguments' => ['book' => $book],
    ]);

    $text = mcpToolText($response);
    expect($text)->toContain('MCP Fixture Book')->toContain('table_of_contents');
});

test('list_shelves works over a bearer token', function () {
    $user = $this->seedUser();
    $token = mcpToken($user);

    $response = mcpCall($this, $token, 'tools/call', [
        'name' => 'list_shelves',
        'arguments' => [],
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    expect(mcpToolText($response))->toContain('shelves');
});
