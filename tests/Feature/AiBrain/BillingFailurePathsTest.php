<?php

/**
 * AI Brain — Billing failure-path tests
 *
 * Locks the contract that BillingService::charge() is NEVER called when:
 *   - retrieval returns zero matches (shelf scope into empty shelf, etc.)
 *   - the LLM service fails (all fallback models down)
 *   - validation rejects the request
 *
 * We mock LlmService (to control router decisions + final-answer success) and
 * BillingService (to assert charge was/wasn't called). Both are resolved out of
 * the container, so swapping bindings before hitting the controller is enough —
 * the controller receives our mock instances.
 */

use App\Models\User;
use App\Services\BillingService;
use App\Services\LlmService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function billingAdminConn()
{
    return DB::connection('pgsql_admin');
}

function makeBillingUser(string $name): User
{
    $unique = $name . '_' . Str::random(8);
    $id = billingAdminConn()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@billingtest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'premium',  // bypass billing pre-flight; the question is about charge() after that
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

function makeEmptyShelf(string $creator): string
{
    $shelfId = (string) Str::uuid();
    billingAdminConn()->table('shelves')->insert([
        'id'         => $shelfId,
        'creator'    => $creator,
        'name'       => 'Empty shelf ' . Str::random(4),
        'slug'       => 'empty-' . Str::random(6),
        'visibility' => 'private',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return $shelfId;
}

function billingBasePayload(array $overrides = []): array
{
    return array_merge([
        'selectedText' => 'a passage that does not exist in any seeded book',
        'question'     => 'does anyone here cite this?',
        'bookId'       => 'book_billing_test_' . Str::random(6),
        'highlightId'  => 'HL_billing_' . Str::random(6),
        'nodeIds'      => ['nonexistent_node_1'],
        'charData'     => ['nonexistent_node_1' => ['charStart' => 0, 'charEnd' => 10]],
    ], $overrides);
}

beforeEach(function () {
    // Clean prior runs (pgsql_admin connection isn't covered by RefreshDatabase)
    billingAdminConn()->table('shelves')->whereRaw("slug LIKE 'empty-%'")->delete();
    billingAdminConn()->table('users')->whereRaw("email LIKE '%@billingtest.test'")->delete();
});

test('no billing when shelf scope retrieval returns empty matches', function () {
    $user = makeBillingUser('billing_empty_shelf');
    $shelfId = makeEmptyShelf($user->name);

    // Router LLM returns a search plan (forcing retrieval down the search path,
    // where the empty shelf will yield zero matches).
    $this->mock(LlmService::class, function ($mock) {
        $mock->shouldReceive('chatWithFallback')
            ->andReturn([
                'content' => '<search>{"keywords":"monetarism","library_keywords":"","embedding_query":"monetarism inflation"}</search>',
                'model'   => 'accounts/fireworks/models/deepseek-v4-pro',
            ]);
        $mock->shouldReceive('getUsageStats')->andReturn(['by_model' => []]);
        $mock->shouldReceive("clearTransport"); // finally-cleanup of the BYO transport seam
    });

    // The billing assertion: charge must not be called on the empty-matches path
    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldNotReceive('charge');
    });

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', billingBasePayload([
            'sourceScope' => 'shelf',
            'shelfId'     => $shelfId,
        ]));

    // The SSE stream returns 200 with an error event embedded
    $response->assertStatus(200);

    // Body should include the shelf-specific error message
    $body = $response->streamedContent();
    expect($body)->toContain('No matches in this shelf');
});

test('no billing when LLM router fails (all fallback models down)', function () {
    $user = makeBillingUser('billing_llm_failure');

    // Simulate every fallback model failing
    $this->mock(LlmService::class, function ($mock) {
        $mock->shouldReceive('chatWithFallback')->andReturn(null);
        $mock->shouldReceive('getUsageStats')->andReturn(['by_model' => []]);
        $mock->shouldReceive("clearTransport"); // finally-cleanup of the BYO transport seam
    });

    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldNotReceive('charge');
    });

    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', billingBasePayload());

    $response->assertStatus(200);
    $body = $response->streamedContent();
    expect($body)->toContain('error');
});

test('no billing when validation rejects the request', function () {
    $user = makeBillingUser('billing_validation_fail');

    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldNotReceive('charge');
    });

    // Retired scope → 422 from validation, no LLM call, no billing
    $response = $this->actingAs($user)
        ->postJson('/api/ai-brain/query', billingBasePayload(['sourceScope' => 'all']));

    $response->assertStatus(422);
});

test('no billing when shelfId belongs to another user', function () {
    $owner    = makeBillingUser('billing_shelf_owner');
    $attacker = makeBillingUser('billing_shelf_attacker');
    $shelfId  = makeEmptyShelf($owner->name);

    $this->mock(BillingService::class, function ($mock) {
        $mock->shouldReceive('canProceed')->andReturnTrue();
        $mock->shouldNotReceive('charge');
    });

    $response = $this->actingAs($attacker)
        ->postJson('/api/ai-brain/query', billingBasePayload([
            'sourceScope' => 'shelf',
            'shelfId'     => $shelfId,
        ]));

    $response->assertStatus(404);
});
