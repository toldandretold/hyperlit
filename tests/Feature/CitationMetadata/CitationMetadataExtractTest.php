<?php

/**
 * Auto metadata — the AI tier of the source panel's wand
 * (POST /api/citation-meta/extract).
 *
 * What matters here is the guard order and the charge semantics: only the owner
 * can spend credits rewriting a library card, encrypted books never have their
 * plaintext read server-side, and a model that answers with nothing usable costs
 * the user nothing. See docs/billing.md (`category: citation_meta`).
 */

use App\Models\User;
use App\Services\E2ee\EncryptedBookGuard;
use App\Services\LlmService;
use Illuminate\Support\Facades\DB;

const GOOD_JSON = '{"title":"Ways of Seeing","author":"John Berger","year":1972,"type":"book","journal":null,"publisher":"Penguin","self_authored":false,"confidence":"high"}';

const SAMPLE_TEXT = "Ways of Seeing\n\nby John Berger\n\nSeeing comes before words.";

beforeEach(function () {
    EncryptedBookGuard::forget();
    $this->mock(\App\Http\Controllers\UserHomeServerController::class, function ($mock) {
        $mock->shouldReceive('generateAccountBook')->andReturnNull();
    });
});

/**
 * Mock the LLM to answer `$reply`, with 1M+1M tokens on gpt-oss-120b = $0.75 raw.
 *
 * Bound with app()->instance() rather than TestCase::mock(), which is protected
 * and so unreachable from a Pest global helper. This also replaces the singleton
 * AppServiceProvider registers, which is the object the controller resolves.
 */
function mockLlm(string $reply, ?array $usage = null): void
{
    $mock = Mockery::mock(LlmService::class);
    $mock->shouldReceive('resetUsageStats')->andReturnNull();
    $mock->shouldReceive('setTransport')->andReturnNull();
    $mock->shouldReceive('clearTransport')->andReturnNull();
    $mock->shouldReceive('chat')->andReturn($reply);
    $mock->shouldReceive('getUsageStats')->andReturn($usage ?? [
        'by_model' => [
            'accounts/fireworks/models/gpt-oss-120b' => [
                'prompt_tokens' => 1_000_000,
                'completion_tokens' => 1_000_000,
            ],
        ],
    ]);

    app()->instance(LlmService::class, $mock);
}

/** Ledger rows this user accrued (RLS needs BOTH session vars set to read them). */
function ledgerFor(User $user, ?string $category = null)
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
    $q = DB::table('billing_ledger')->where('user_id', $user->id);

    return $category ? $q->where('category', $category)->get() : $q->get();
}

it('requires authentication', function () {
    $this->postJson('/api/citation-meta/extract', [
        'book' => 'nobody', 'text' => SAMPLE_TEXT,
    ])->assertStatus(401);
});

it('extracts metadata and charges the token cost × tier', function () {
    $user = $this->seedUser(['status' => 'solidarity', 'credits' => 10]);
    $this->seedLibrary(['book' => 'wos_1', 'creator' => $user->name, 'creator_token' => $user->user_token]);
    mockLlm(GOOD_JSON);

    $response = $this->actingAs($user)->postJson('/api/citation-meta/extract', [
        'book' => 'wos_1', 'text' => SAMPLE_TEXT,
    ]);

    $response->assertOk()->assertJson(['success' => true]);
    expect($response->json('metadata.title'))->toBe('Ways of Seeing');
    expect($response->json('metadata.author'))->toBe('John Berger');
    expect($response->json('metadata.year'))->toBe(1972);
    expect($response->json('metadata.self_authored'))->toBeFalse();

    $rows = ledgerFor($user, 'citation_meta');
    expect($rows)->toHaveCount(1);
    expect((float) $rows[0]->amount)->toEqualWithDelta(0.75 * 2.0, 0.0001); // solidarity 2×
    expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.75 * 2.0, 0.0001);

    // The client states what was actually taken using this figure, rather than
    // keeping its own copy of the tier table to drift out of sync.
    expect((float) $response->json('charged'))->toEqualWithDelta(0.75 * 2.0, 0.0001);
});

it('never charges when the model answers with unparseable output', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $this->seedLibrary(['book' => 'wos_2', 'creator' => $user->name, 'creator_token' => $user->user_token]);
    mockLlm('sorry, no JSON here');

    $this->actingAs($user)->postJson('/api/citation-meta/extract', [
        'book' => 'wos_2', 'text' => SAMPLE_TEXT,
    ])->assertStatus(422);

    expect(ledgerFor($user)->count())->toBe(0);
    expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001);
});

it('never charges when the model finds nothing (valid JSON, all nulls)', function () {
    // "The model found nothing" is a failure, not a result — billing for it
    // would charge the user for an empty answer.
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $this->seedLibrary(['book' => 'wos_3', 'creator' => $user->name, 'creator_token' => $user->user_token]);
    mockLlm('{"title":null,"author":null,"year":null,"type":null,"journal":null,"publisher":null,"self_authored":true,"confidence":"low"}');

    $this->actingAs($user)->postJson('/api/citation-meta/extract', [
        'book' => 'wos_3', 'text' => SAMPLE_TEXT,
    ])->assertStatus(422);

    expect(ledgerFor($user)->count())->toBe(0);
});

it('refuses a book the user does not own', function () {
    // Translating a stranger's public passage is fine; spending credits to
    // rewrite their library card is not.
    $owner = $this->seedUser();
    $other = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $this->seedLibrary([
        'book' => 'wos_4', 'creator' => $owner->name, 'creator_token' => $owner->user_token,
        'visibility' => 'public',
    ]);
    mockLlm(GOOD_JSON);

    $this->actingAs($other)->postJson('/api/citation-meta/extract', [
        'book' => 'wos_4', 'text' => SAMPLE_TEXT,
    ])->assertStatus(403);

    expect(ledgerFor($other)->count())->toBe(0);
});

it('404s a book that does not exist (or that RLS hides)', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    mockLlm(GOOD_JSON);

    $this->actingAs($user)->postJson('/api/citation-meta/extract', [
        'book' => 'no_such_book_here', 'text' => SAMPLE_TEXT,
    ])->assertStatus(404);
});

it('refuses an encrypted book — its plaintext must never reach the server', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $this->seedLibrary([
        'book' => 'wos_enc', 'creator' => $user->name, 'creator_token' => $user->user_token,
        'visibility' => 'private', 'listed' => false,
        'encrypted' => true, 'wrapped_dek' => 'hlenc.v1.DEK.CT',
    ]);
    mockLlm(GOOD_JSON);

    $this->actingAs($user)->postJson('/api/citation-meta/extract', [
        'book' => 'wos_enc', 'text' => SAMPLE_TEXT,
    ])->assertStatus(403);

    expect(ledgerFor($user)->count())->toBe(0);
});

it('402s when the balance is spent, before calling the model', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 0, 'debits' => 5]);
    $this->seedLibrary(['book' => 'wos_5', 'creator' => $user->name, 'creator_token' => $user->user_token]);
    mockLlm(GOOD_JSON);

    $this->actingAs($user)->postJson('/api/citation-meta/extract', [
        'book' => 'wos_5', 'text' => SAMPLE_TEXT,
    ])->assertStatus(402);

    expect(ledgerFor($user)->count())->toBe(0);
});

it('waives the charge under BYO — the user\'s own key paid', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $this->seedLibrary(['book' => 'wos_6', 'creator' => $user->name, 'creator_token' => $user->user_token]);
    mockLlm(GOOD_JSON);

    $response = $this->actingAs($user)->postJson('/api/citation-meta/extract', [
        'book' => 'wos_6', 'text' => SAMPLE_TEXT, 'client_inference' => true,
    ]);

    $response->assertOk();
    expect($response->json('charged'))->toBeNull();
    expect(ledgerFor($user)->count())->toBe(0);
});

it('rejects text past the input ceiling rather than paying to read it', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $this->seedLibrary(['book' => 'wos_7', 'creator' => $user->name, 'creator_token' => $user->user_token]);
    mockLlm(GOOD_JSON);

    $this->actingAs($user)->postJson('/api/citation-meta/extract', [
        'book' => 'wos_7', 'text' => str_repeat('a', 9000),
    ])->assertStatus(422);

    expect(ledgerFor($user)->count())->toBe(0);
});
