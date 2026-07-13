<?php

/**
 * Vibe CSS — happy-path charge (docs/billing.md).
 *
 * The e2e stripe suite covers the 402 gate and the validation-failure no-charge;
 * the only prior coverage of a SUCCESSFUL generation's charge was the opt-in
 * real-spend e2e (RUN_LIVE_SPEND=1). This locks it in CI: a parsed theme charges
 * the LLM token cost × tier into a 'vibe_css' ledger row.
 */

use App\Models\User;
use App\Services\LlmService;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    $this->mock(\App\Http\Controllers\UserHomeServerController::class, function ($mock) {
        $mock->shouldReceive('generateAccountBook')->andReturnNull();
    });
});

it('charges a successful vibe CSS generation at the LLM cost × tier', function () {
    $user = $this->seedUser(['status' => 'solidarity', 'credits' => 10]);

    // 1M prompt + 1M completion on gpt-oss-120b = $0.15 + $0.60 = $0.75 raw.
    $this->mock(LlmService::class, function ($mock) {
        $mock->shouldReceive('chat')->andReturn('{"--vibe-canvas-speed": "1.5"}');
        $mock->shouldReceive('getUsageStats')->andReturn([
            'by_model' => [
                'accounts/fireworks/models/gpt-oss-120b' => [
                    'prompt_tokens'     => 1_000_000,
                    'completion_tokens' => 1_000_000,
                ],
            ],
        ]);
    });

    $response = $this->actingAs($user)->postJson('/api/vibe-css/generate', [
        'prompt' => 'calm ocean at dusk',
    ]);

    $response->assertOk()->assertJson(['success' => true]);
    expect($response->json('overrides'))->toHaveKey('--vibe-canvas-speed');

    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
    $rows = DB::table('billing_ledger')
        ->where('user_id', $user->id)->where('category', 'vibe_css')->get();
    expect($rows)->toHaveCount(1);
    expect((float) $rows[0]->amount)->toEqualWithDelta(0.75 * 2.0, 0.0001); // solidarity 2×
    expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.75 * 2.0, 0.0001);
});

it('does not charge when the LLM output cannot be parsed into a theme', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);

    $this->mock(LlmService::class, function ($mock) {
        $mock->shouldReceive('chat')->andReturn('sorry, no JSON here');
        $mock->shouldReceive('getUsageStats')->andReturn(['by_model' => []]);
    });

    $this->actingAs($user)
        ->postJson('/api/vibe-css/generate', ['prompt' => 'unparseable'])
        ->assertStatus(422);

    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
    expect(DB::table('billing_ledger')->where('user_id', $user->id)->count())->toBe(0);
    expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001);
});
