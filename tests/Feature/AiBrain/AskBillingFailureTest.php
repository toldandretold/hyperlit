<?php

/**
 * AI Archivist ask endpoint — billing failure paths.
 *
 * Same contract as BillingFailurePathsTest for query(): charge() is NEVER
 * called on empty retrieval, router failure, or validation rejection; it is
 * called exactly once (category 'ai_brain') on success; and it is waived under
 * client_inference (BYO key).
 */

use App\Models\User;
use App\Services\BillingService;
use App\Services\LlmService;
use App\Services\RetrievalService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function askBillAdminConn()
{
    return DB::connection('pgsql_admin');
}

function makeAskBillUser(string $name): User
{
    $unique = $name . '_' . Str::random(8);
    $id = askBillAdminConn()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@askbilltest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'premium',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

function askBillSourceMatch(): object
{
    $m = new \stdClass();
    $m->id = 1;
    $m->book = 'book_askbill_source';
    $m->node_id = 'book_askbill_source_node_1';
    $m->plainText = 'A relevant passage about monetarism and its discontents in the periphery.';
    $m->content = '<p>A relevant passage about monetarism and its discontents in the periphery.</p>';
    $m->book_title = 'Monetarism';
    $m->book_author = 'Someone';
    $m->book_year = '1980';
    $m->similarity = 0.8;
    return $m;
}

function askBillRouterPlan(): array
{
    return [
        'content' => '<search>{"keywords":"monetarism","library_keywords":"","embedding_query":"monetarism inflation"}</search>',
        'model'   => 'accounts/fireworks/models/deepseek-v4-pro-0813',
    ];
}

function cleanupAskBillArtifacts(string $creator, ?string $answerBookId): void
{
    $admin = askBillAdminConn();
    if ($answerBookId) {
        $admin->table('nodes')->where('book', $answerBookId)->delete();
        $admin->table('library')->where('book', $answerBookId)->delete();
    }
    $admin->table('hypercites')->where('book', 'book_askbill_source')->delete();
    $shelfIds = $admin->table('shelves')->where('creator', $creator)->pluck('id');
    foreach ($shelfIds as $sid) {
        $admin->table('shelf_items')->where('shelf_id', $sid)->delete();
    }
    $admin->table('shelves')->where('creator', $creator)->delete();
}

beforeEach(function () {
    askBillAdminConn()->table('users')->whereRaw("email LIKE '%@askbilltest.test'")->delete();
});

test('no billing when retrieval returns empty matches', function () {
    $user = makeAskBillUser('askbill_empty');

    $this->mock(LlmService::class, function ($mock) {
        $mock->shouldReceive('chatWithFallback')->andReturn(askBillRouterPlan());
        $mock->shouldReceive('getUsageStats')->andReturn(['by_model' => []]);
        $mock->shouldReceive('clearTransport');
    });
    $this->mock(RetrievalService::class, function ($mock) {
        $mock->shouldReceive('execute')->andReturn([
            'matches' => [], 'queryText' => null, 'toolsUsed' => ['embedding_search'], 'log' => [],
        ]);
    });
    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldNotReceive('charge');
    });

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', [
        'question' => 'does anyone here cite this?',
    ]);

    $response->assertStatus(200);
    expect($response->streamedContent())->toContain('No relevant passages found');
});

test('no billing when the router LLM fails (all fallback models down)', function () {
    $user = makeAskBillUser('askbill_llmdown');

    $this->mock(LlmService::class, function ($mock) {
        $mock->shouldReceive('chatWithFallback')->andReturn(null);
        $mock->shouldReceive('getUsageStats')->andReturn(['by_model' => []]);
        $mock->shouldReceive('clearTransport');
    });
    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldNotReceive('charge');
    });

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', [
        'question' => 'does anyone here cite this?',
    ]);

    $response->assertStatus(200);
    expect($response->streamedContent())->toContain('error');
});

test('no billing when validation rejects the request', function () {
    $user = makeAskBillUser('askbill_valfail');

    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldNotReceive('charge');
    });

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', ['question' => 'hi']);

    $response->assertStatus(422);
});

test('a successful ask charges exactly once under category ai_brain', function () {
    $user = makeAskBillUser('askbill_success');

    $this->mock(LlmService::class, function ($mock) {
        $mock->shouldReceive('chatWithFallback')->andReturn(
            askBillRouterPlan(),
            [
                'content' => '<p>Monetarism was contested from the start [1].</p>',
                'model'   => 'accounts/fireworks/models/deepseek-v4-pro-0813',
            ]
        );
        $mock->shouldReceive('getUsageStats')->andReturn(['by_model' => []]);
        $mock->shouldReceive('clearTransport');
    });
    $this->mock(RetrievalService::class, function ($mock) {
        $mock->shouldReceive('execute')->andReturn([
            'matches' => [askBillSourceMatch()], 'queryText' => null, 'toolsUsed' => ['embedding_search'], 'log' => [],
        ]);
    });
    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldReceive('charge')
            ->once()
            ->withArgs(fn($user, $cost, $description, $category) => $category === 'ai_brain'
                && str_starts_with($description, 'AI Archivist: '));
    });

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', [
        'question' => 'was monetarism contested?',
    ]);

    $response->assertStatus(200);
    $body = $response->streamedContent();
    expect($body)->toContain('"success":true');

    preg_match('/"bookId":"(book_\d+)"/', $body, $m);
    cleanupAskBillArtifacts($user->name, $m[1] ?? null);
});

test('no billing under client_inference (BYO key) — charge waived', function () {
    $user = makeAskBillUser('askbill_byo');

    $this->mock(LlmService::class, function ($mock) {
        $mock->shouldReceive('setTransport');
        $mock->shouldReceive('chatWithFallback')->andReturn(
            askBillRouterPlan(),
            [
                'content' => '<p>Monetarism was contested from the start [1].</p>',
                'model'   => 'accounts/fireworks/models/deepseek-v4-pro-0813',
            ]
        );
        $mock->shouldReceive('getUsageStats')->andReturn(['by_model' => []]);
        $mock->shouldReceive('clearTransport');
    });
    $this->mock(RetrievalService::class, function ($mock) {
        $mock->shouldReceive('execute')->andReturn([
            'matches' => [askBillSourceMatch()], 'queryText' => null, 'toolsUsed' => ['embedding_search'], 'log' => [],
        ]);
    });
    $this->mock(BillingService::class, function ($mock) {
        // canProceed is skipped under BYO; charge must never fire
        $mock->shouldNotReceive('charge');
    });

    $response = $this->actingAs($user)->postJson('/api/ai-brain/ask', [
        'question' => 'was monetarism contested?',
        'client_inference' => true,
    ]);

    $response->assertStatus(200);
    $body = $response->streamedContent();
    expect($body)->toContain('"success":true');

    preg_match('/"bookId":"(book_\d+)"/', $body, $m);
    cleanupAskBillArtifacts($user->name, $m[1] ?? null);
});
