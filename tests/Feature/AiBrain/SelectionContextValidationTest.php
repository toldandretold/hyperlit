<?php

/**
 * AI Brain — selectionContext payload validation.
 *
 * The client may attach a `selectionContext` (nesting chain + in-selection links)
 * to enrich the LLM prompt. These tests hit /api/ai-brain/query with malformed
 * selectionContext and assert the controller rejects it with 422 BEFORE opening
 * the SSE stream. Bounds keep the preamble from blowing the token budget. No LLM
 * key required. Mirrors AiBrainScopeValidationTest.php (premium user skips billing).
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function scvConn()
{
    return DB::connection('pgsql_admin');
}

function scvUser(string $name): User
{
    $unique = $name . '_' . Str::random(8);
    $id = scvConn()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@scvtest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'premium',   // skip the billing pre-flight so validation can fire
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

function scvPayload(array $overrides = []): array
{
    return array_merge([
        'selectedText' => 'some selected passage long enough to pass validation',
        'question'     => 'why does this matter?',
        'bookId'       => 'book_scv_test',
        'highlightId'  => 'HL_scv_test',
        'nodeIds'      => ['book_scv_test_node_1'],
        'charData'     => ['book_scv_test_node_1' => ['charStart' => 0, 'charEnd' => 10]],
    ], $overrides);
}

/** A well-formed selectionContext used to prove the rules ACCEPT good input. */
function scvValidContext(): array
{
    return [
        'chain' => [
            ['type' => 'highlight', 'creator' => 'sam', 'isAi' => false, 'label' => 'a note', 'itemId' => 'HL_abc'],
            ['type' => 'footnote', 'creator' => null, 'isAi' => false, 'itemId' => 'Fn123'],
        ],
        'chainTruncated' => false,
        'citations' => [
            ['referenceId' => 'Ref1', 'content' => 'Smith 2020', 'title' => 'A Work', 'author' => 'Smith', 'year' => '2020'],
        ],
        'hypercites' => [
            ['hyperciteId' => 'hypercite_x', 'targetBook' => 'book_other', 'visibility' => 'restricted'],
        ],
    ];
}

test('rejects a nesting chain longer than the cap with 422', function () {
    $user = scvUser('scv_chain_max');
    $chain = array_fill(0, 6, ['type' => 'highlight', 'creator' => 'x', 'isAi' => false]);

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', scvPayload(['selectionContext' => ['chain' => $chain]]));

    $response->assertStatus(422);
    expect($response->json('errors'))->toHaveKey('selectionContext.chain');
});

test('rejects an unknown chain level type with 422', function () {
    $user = scvUser('scv_chain_type');
    $ctx = ['chain' => [['type' => 'wormhole', 'creator' => 'x', 'isAi' => false]]];

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', scvPayload(['selectionContext' => $ctx]));

    $response->assertStatus(422);
    $errorKeys = array_keys($response->json('errors') ?? []);
    expect(collect($errorKeys)->contains(fn($k) => str_contains($k, 'chain') && str_contains($k, 'type')))->toBeTrue();
});

test('rejects an oversized chain label with 422', function () {
    $user = scvUser('scv_label');
    $ctx = ['chain' => [['type' => 'highlight', 'creator' => 'x', 'isAi' => false, 'label' => str_repeat('a', 201)]]];

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', scvPayload(['selectionContext' => $ctx]));

    $response->assertStatus(422);
});

test('rejects oversized hypercitedText with 422', function () {
    $user = scvUser('scv_hctext');
    $ctx = ['hypercites' => [[
        'hyperciteId' => 'hypercite_x',
        'targetBook' => 'book_other',
        'hypercitedText' => str_repeat('a', 1001),
    ]]];

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', scvPayload(['selectionContext' => $ctx]));

    $response->assertStatus(422);
});

test('rejects a hypercite missing targetBook with 422', function () {
    $user = scvUser('scv_hc_missing');
    $ctx = ['hypercites' => [['hyperciteId' => 'hypercite_x']]];

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', scvPayload(['selectionContext' => $ctx]));

    $response->assertStatus(422);
});

test('a well-formed selectionContext adds no validation errors', function () {
    $user = scvUser('scv_valid');

    // Pair a valid selectionContext with an independently-invalid field so the
    // request 422s pre-stream (never touching the LLM); then assert the errors
    // come ONLY from that field, proving the selectionContext rules accepted it.
    $response = $this->actingAs($user)->postJson('/api/ai-brain/query', scvPayload([
        'sourceScope'      => 'all',            // retired scope → guaranteed 422
        'selectionContext' => scvValidContext(),
    ]));

    $response->assertStatus(422);
    $errorKeys = array_keys($response->json('errors') ?? []);
    expect($errorKeys)->toContain('sourceScope');
    foreach ($errorKeys as $key) {
        expect(str_starts_with($key, 'selectionContext'))->toBeFalse();
    }
});
