<?php

/**
 * AI Brain — Controller-level scope validation
 *
 * These tests hit /api/ai-brain/query directly with malformed or hostile scope
 * inputs and assert the controller rejects them BEFORE opening the SSE stream
 * or making any LLM call. No LLM key required; runs in <1 second.
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function adminConn()
{
    return DB::connection('pgsql_admin');
}

function makeUser(string $name): User
{
    $unique = $name . '_' . Str::random(8);
    $id = adminConn()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@valtest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'premium',   // skip the billing pre-flight so validation can fire
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

function basePayload(array $overrides = []): array
{
    return array_merge([
        'selectedText' => 'some selected passage long enough to pass validation',
        'question'     => 'why does this matter?',
        'bookId'       => 'book_validation_test',
        'highlightId'  => 'HL_validation_test',
        'nodeIds'      => ['book_validation_test_node_1'],
        'charData'     => ['book_validation_test_node_1' => ['charStart' => 0, 'charEnd' => 10]],
    ], $overrides);
}

test('rejects retired sourceScope "all" with 422', function () {
    $user = makeUser('validation_all');

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', basePayload(['sourceScope' => 'all']));

    $response->assertStatus(422);
    expect($response->json('errors.sourceScope'))->not->toBeEmpty();
});

test('rejects retired sourceScope "this" with 422', function () {
    $user = makeUser('validation_this');

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', basePayload(['sourceScope' => 'this']));

    $response->assertStatus(422);
    expect($response->json('errors.sourceScope'))->not->toBeEmpty();
});

test('rejects sourceScope=shelf without shelfId with 422', function () {
    $user = makeUser('validation_shelf_missing');

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', basePayload(['sourceScope' => 'shelf']));

    $response->assertStatus(422);
});

test('rejects shelfId belonging to another user with 404', function () {
    $owner    = makeUser('shelf_owner');
    $attacker = makeUser('shelf_attacker');

    $shelfId = (string) Str::uuid();
    adminConn()->table('shelves')->insert([
        'id'         => $shelfId,
        'creator'    => $owner->name,
        'name'       => 'Owners shelf',
        'slug'       => 'owners-shelf-' . Str::random(6),
        'visibility' => 'private',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $response = $this->actingAs($attacker)
        ->postJson('/api/ai-brain/query', basePayload([
            'sourceScope' => 'shelf',
            'shelfId'     => $shelfId,
        ]));

    $response->assertStatus(404);
    expect($response->json('message'))->toContain('Shelf');
});

test('rejects garbage sourceScope value with 422', function () {
    $user = makeUser('validation_garbage');

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', basePayload(['sourceScope' => "'; DROP TABLE library;--"]));

    $response->assertStatus(422);
});

test('rejects non-uuid shelfId with 422', function () {
    $user = makeUser('validation_bad_uuid');

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', basePayload([
            'sourceScope' => 'shelf',
            'shelfId'     => 'not-a-uuid',
        ]));

    $response->assertStatus(422);
});
