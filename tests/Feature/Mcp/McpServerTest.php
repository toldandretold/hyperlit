<?php

use App\Mcp\TokenAbilities;
use App\Models\User;
use Illuminate\Support\Str;

/**
 * The MCP endpoint end to end: JSON-RPC over POST /mcp with a bearer token,
 * through the REAL middleware stack — which is the point. laravel/mcp's own
 * test harness ($server->actingAs()->tool()) skips HTTP middleware entirely,
 * and the thing most worth pinning here is that the /mcp route's middleware
 * order (McpOptionalAuth BEFORE SetDatabaseSessionContext) gives every tool
 * the token user's RLS context. A token-less request 401s (that 401 carries
 * the OAuth discovery header — it is what makes claude.ai/mobile connectors
 * show a login); a GUEST connects via POST /mcp?guest=1 and sees only
 * get_connected (onboarding); an INVALID
 * token still 401s, with a how-to-connect body. Same harness traps as
 * ApiTokenManagementTest: bearer tokens are minted via createToken() (never
 * actingAs), and tests sending two identities forgetGuards() between
 * requests.
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

function mcpGuestCall($test, string $method, array $params = [])
{
    app('auth')->forgetGuards();

    // Guest mode is opt-in via ?guest=1 — a BARE token-less POST 401s so
    // OAuth-capable clients discover the login flow (see McpOptionalAuth).
    return $test->postJson('/mcp?guest=1', [
        'jsonrpc' => '2.0',
        'id' => 1,
        'method' => $method,
        'params' => $params,
    ], [
        'Accept' => 'application/json, text/event-stream',
    ]);
}

test('a token-less request WITHOUT ?guest=1 is 401 with OAuth discovery', function () {
    app('auth')->forgetGuards();

    $response = $this->postJson('/mcp', [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list',
    ], [
        'Accept' => 'application/json, text/event-stream',
    ]);

    $response->assertStatus(401);
    // Claude's client only starts OAuth off a 401 whose WWW-Authenticate
    // names the protected-resource metadata; the vendor middleware emits it
    // because routes/oauth.php registers mcp.oauth.protected-resource.
    $header = (string) $response->headers->get('WWW-Authenticate');
    expect($header)->toContain('realm="mcp"')
        ->toContain('resource_metadata=')
        ->toContain('/.well-known/oauth-protected-resource/mcp');
    // Agents that wanted the old silent guest handshake are told where it went.
    expect((string) $response->json('guest_mode'))->toContain('guest=1');
    expect($response->json('oauth'))->not->toBeNull();
});

test('an invalid-token 401 also carries OAuth discovery (the silent-refresh path)', function () {
    $response = $this->postJson('/mcp', [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list',
    ], [
        'Authorization' => 'Bearer not-a-real-token',
        'Accept' => 'application/json, text/event-stream',
    ]);

    $response->assertStatus(401);
    // An EXPIRED OAuth-minted PAT lands here; resource_metadata on this 401
    // is what lets Claude refresh without bothering the user.
    expect((string) $response->headers->get('WWW-Authenticate'))
        ->toContain('resource_metadata=');
});

test('a token-less GUEST completes the handshake and gets guest instructions', function () {
    $response = mcpGuestCall($this, 'initialize', [
        'protocolVersion' => '2025-06-18',
        'capabilities' => [],
        'clientInfo' => ['name' => 'pest', 'version' => '1.0'],
    ]);

    $response->assertOk();
    expect($response->json('result.serverInfo.name'))->toBe('Hyperlit');
    // Guest instructions point at onboarding, not the data-tool manual.
    expect($response->json('result.instructions'))->toContain('get_connected');
    expect($response->json('result.instructions'))->not->toContain('HYPERLIGHT');
});

test('a GUEST sees exactly one tool: get_connected', function () {
    $response = mcpGuestCall($this, 'tools/list');

    $names = collect($response->json('result.tools'))->pluck('name');
    expect($names->all())->toBe(['get_connected']);
});

test('a GUEST calling a hidden data tool gets a clean tool-not-found, not a crash', function () {
    $response = mcpGuestCall($this, 'tools/call', [
        'name' => 'list_books',
        'arguments' => [],
    ]);

    $response->assertOk();
    expect($response->json('error.code'))->toBe(-32602);
    expect((string) $response->json('error.message'))->toContain('not found');
});

test('get_connected walks a GUEST through minting a token', function () {
    $response = mcpGuestCall($this, 'tools/call', [
        'name' => 'get_connected',
        'arguments' => [],
    ]);

    $text = mcpToolText($response);
    expect($text)->toContain('GUEST')
        ->toContain('Data sovereignty')
        ->toContain('Authorization: Bearer');
});

test('an INVALID bearer token is 401 with a how-to-connect body, never a silent guest', function () {
    $response = $this->postJson('/mcp', [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list',
    ], [
        'Authorization' => 'Bearer not-a-real-token',
        'Accept' => 'application/json, text/event-stream',
    ]);

    $response->assertStatus(401);
    expect((string) $response->json('message'))->toContain('invalid');
    expect($response->json('hint'))->not->toBeNull();
    expect($response->json('guest_mode'))->not->toBeNull();
    // laravel/mcp's AddWwwAuthenticateHeader decorates any 401 on this route.
    expect((string) $response->headers->get('WWW-Authenticate'))->toContain('realm="mcp"');
});

test('an EXPIRED token is 401, not a guest', function () {
    $user = $this->seedUser();
    $token = $user->createToken('expired', [TokenAbilities::READ], now()->subDay())->plainTextToken;

    mcpCall($this, $token, 'tools/list')->assertStatus(401);
});

test('a token with the report ability sees report_bug; one without does not', function () {
    $user = $this->seedUser();

    $with = mcpToken($user, [TokenAbilities::READ, TokenAbilities::REPORT]);
    $names = collect(mcpCall($this, $with, 'tools/list')->json('result.tools'))->pluck('name');
    expect($names)->toContain('report_bug')->toContain('get_connected');

    $without = mcpToken($user, [TokenAbilities::READ]);
    $names = collect(mcpCall($this, $without, 'tools/list')->json('result.tools'))->pluck('name');
    expect($names)->not->toContain('report_bug');
});

test('the DEFAULT tools/list holds the ENTIRE registry on one page', function () {
    // The vendor default (15) split the registry mid-list, and real clients
    // do not reliably follow nextCursor: OpenCode's agent saw only the first
    // 15 tools, concluded import_document "isn't available", and rewrote an
    // EXISTING book to get itself a container. A truncated tool surface is an
    // agent improvising around a hole — one page must hold everything, so
    // this counts the registry by reflection and fails the moment the tool
    // count outgrows the page size.
    $user = $this->seedUser();
    $token = mcpToken($user, TokenAbilities::all());

    $response = mcpCall($this, $token, 'tools/list');

    $registry = (new ReflectionClass(\App\Mcp\Servers\HyperlitServer::class))
        ->getProperty('tools')->getDefaultValue();

    $names = collect($response->json('result.tools'))->pluck('name');
    expect($names)->toHaveCount(count($registry));
    // The first casualties of the old page split, pinned by name.
    expect($names)->toContain('import_document')->toContain('export_markdown');
    expect($response->json('result.nextCursor'))->toBeNull();
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

test('tools/list exposes the full toolset to an all-abilities token', function () {
    $token = mcpToken($this->seedUser(), TokenAbilities::all());

    $response = mcpCall($this, $token, 'tools/list');

    $names = collect($response->json('result.tools'))->pluck('name');
    expect($names)->toContain('list_books', 'search_library', 'search_text',
        'get_book', 'read_book', 'list_annotations', 'list_shelves');
    // The write toolset (write ability): node edits + two-way hypercites.
    expect($names)->toContain('update_node', 'append_nodes', 'cite_passage');

    // semantic search is the archivist's retrieval move and must be VISIBLE
    // as its own tool in a bare listing — it shipped once as an invisible
    // mode of search_text and every agent reached for keyword search instead.
    expect($names)->toContain('semantic_search');

    // The v2 surface: audio, lifecycle, social reads, translation, billing.
    expect($names)->toContain('create_audiobook', 'get_audiobook_status', 'cancel_audiobook',
        'package_audiobook', 'get_credit_balance', 'translate_passage');
    expect($names)->toContain('set_book_visibility', 'set_book_slug', 'delete_book',
        'get_book_stats', 'like_book');
    expect($names)->toContain('list_notifications', 'mark_notifications_read',
        'get_reading_position', 'set_reading_position', 'get_citation_graph', 'list_feed');

    $readBook = collect($response->json('result.tools'))->firstWhere('name', 'read_book');
    expect($readBook['annotations']['readOnlyHint'] ?? null)->toBeTrue();
});

test('the tool list is ABILITY-SIZED: a token only sees tools it can call', function () {
    // The visible list IS the capability map — an agent must never plan
    // around a tool its token would refuse, and the minting checkboxes are
    // how the user sizes the agent's surface. denyUnlessAble remains the
    // call-time backstop; this pins the listing side.
    $user = $this->seedUser();

    $readOnly = collect(mcpCall($this, mcpToken($user, [TokenAbilities::READ]), 'tools/list')
        ->json('result.tools'))->pluck('name');
    expect($readOnly)->toContain('semantic_search', 'read_book', 'get_credit_balance', 'get_connected');
    expect($readOnly)->not->toContain('create_highlight');   // annotate
    expect($readOnly)->not->toContain('import_document');    // import
    expect($readOnly)->not->toContain('cite_passage');       // write
    expect($readOnly)->not->toContain('create_audiobook');   // spend
    expect($readOnly)->not->toContain('report_bug');         // report

    $annotate = collect(mcpCall($this, mcpToken($user, [TokenAbilities::READ, TokenAbilities::ANNOTATE]), 'tools/list')
        ->json('result.tools'))->pluck('name');
    expect($annotate)->toContain('create_highlight', 'like_book', 'modify_shelf');
    expect($annotate)->not->toContain('cite_passage')->not->toContain('create_audiobook');

    // Hidden ⇒ also uncallable at the protocol layer: a clean tool-not-found,
    // not an ability refusal (the registry filter runs before dispatch).
    $blocked = mcpCall($this, mcpToken($user, [TokenAbilities::READ]), 'tools/call', [
        'name' => 'create_audiobook', 'arguments' => ['book' => 'book_x'],
    ]);
    expect($blocked->json('error.code'))->toBe(-32602);
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

test('a token without the read ability cannot reach read tools (hidden, so tool-not-found)', function () {
    $user = $this->seedUser();
    seedReadableBook($this, $user);
    $token = mcpToken($user, [TokenAbilities::ANNOTATE]);

    $response = mcpCall($this, $token, 'tools/call', [
        'name' => 'list_books',
        'arguments' => [],
    ]);

    // Ability-sized listing: the registry filter runs before dispatch, so a
    // missing ability reads as tool-not-found, never a half-visible refusal.
    expect($response->json('error.code'))->toBe(-32602);
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
