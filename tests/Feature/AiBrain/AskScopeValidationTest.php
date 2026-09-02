<?php

/**
 * AI Archivist ask endpoint (/api/ai-brain/ask) — scope + validation contract.
 *
 * The hero-page (home / journal / archive) selection-free entry point. The key
 * contract INVERTS query()'s shelf gate: ask() accepts any PUBLIC shelf —
 * including someone else's (a visitor asking a journal page's corpus) — and
 * 404s private shelves even for their owner (personal-shelf asks belong to the
 * in-reader flow). No LLM key required; pre-stream rejections only, except the
 * public-shelf acceptance test which mocks the pipeline.
 */

use App\Models\User;
use App\Services\BillingService;
use App\Services\LlmService;
use App\Services\RetrievalService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function askAdminConn()
{
    return DB::connection('pgsql_admin');
}

function makeAskUser(string $name): User
{
    $unique = $name . '_' . Str::random(8);
    $id = askAdminConn()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@askvaltest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'premium',   // skip the billing pre-flight so the gate under test can fire
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

function makeAskShelf(string $creator, string $visibility): string
{
    $shelfId = (string) Str::uuid();
    askAdminConn()->table('shelves')->insert([
        'id'         => $shelfId,
        'creator'    => $creator,
        'name'       => 'Ask shelf ' . Str::random(4),
        'slug'       => 'askshelf-' . Str::random(6),
        'visibility' => $visibility,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return $shelfId;
}

beforeEach(function () {
    askAdminConn()->table('shelves')->whereRaw("slug LIKE 'askshelf-%'")->delete();
    askAdminConn()->table('users')->whereRaw("email LIKE '%@askvaltest.test'")->delete();
});

test('rejects unauthenticated requests with 401', function () {
    $response = $this->postJson('/api/ai-brain/ask', ['question' => 'what is delinking?']);

    $response->assertStatus(401);
});

test('rejects a missing question with 422', function () {
    $user = makeAskUser('ask_val_noq');

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', []);

    $response->assertStatus(422);
    expect($response->json('errors.question'))->not->toBeEmpty();
});

test('rejects a too-short question with 422', function () {
    $user = makeAskUser('ask_val_short');

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', ['question' => 'hi']);

    $response->assertStatus(422);
});

test('rejects a non-uuid shelfId with 422', function () {
    $user = makeAskUser('ask_val_baduuid');

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', [
        'question' => 'what is delinking?',
        'shelfId'  => 'not-a-uuid',
    ]);

    $response->assertStatus(422);
});

test('rejects a nonexistent shelf with 404', function () {
    $user = makeAskUser('ask_val_missing');

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', [
        'question' => 'what is delinking?',
        'shelfId'  => (string) Str::uuid(),
    ]);

    $response->assertStatus(404);
    expect($response->json('message'))->toContain('Shelf');
});

test('rejects a PRIVATE shelf with 404 even for its owner', function () {
    $user = makeAskUser('ask_val_ownpriv');
    $shelfId = makeAskShelf($user->name, 'private');

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', [
        'question' => 'what is delinking?',
        'shelfId'  => $shelfId,
    ]);

    $response->assertStatus(404);
});

test("rejects another user's PRIVATE shelf with 404", function () {
    $owner = makeAskUser('ask_val_privowner');
    $asker = makeAskUser('ask_val_privasker');
    $shelfId = makeAskShelf($owner->name, 'private');

    $response = $this->actingAs($asker)->postJson('/api/ai-brain/ask', [
        'question' => 'what is delinking?',
        'shelfId'  => $shelfId,
    ]);

    $response->assertStatus(404);
});

test("accepts another user's PUBLIC shelf and opens the stream", function () {
    // The inverted-gate contract: a visitor may ask a public journal/archive
    // shelf they do not own. Pipeline mocked to end at the no-matches path so
    // no LLM key or seeded corpus is needed — status 200 with the stream open
    // proves the gate passed.
    $owner = makeAskUser('ask_val_pubowner');
    $asker = makeAskUser('ask_val_pubasker');
    $shelfId = makeAskShelf($owner->name, 'public');

    $this->mock(LlmService::class, function ($mock) {
        $mock->shouldReceive('chatWithFallback')->andReturn([
            'content' => '<search>{"keywords":"delinking","library_keywords":"","embedding_query":"delinking world economy"}</search>',
            'model'   => 'accounts/fireworks/models/deepseek-v4-pro-0813',
        ]);
        $mock->shouldReceive('getUsageStats')->andReturn(['by_model' => []]);
        $mock->shouldReceive('clearTransport');
    });
    $this->mock(RetrievalService::class, function ($mock) {
        $mock->shouldReceive('execute')->andReturn([
            'matches' => [], 'queryText' => null, 'toolsUsed' => ['embedding_search'], 'log' => [],
        ]);
        $mock->shouldNotReceive('executeLocalContext'); // selection-free by contract
    });
    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldNotReceive('charge');
    });

    $response = $this->actingAs($asker)->postJson('/api/ai-brain/ask', [
        'question' => 'what is delinking?',
        'shelfId'  => $shelfId,
    ]);

    $response->assertStatus(200);
    expect($response->streamedContent())->toContain('No matches in this collection');
});
