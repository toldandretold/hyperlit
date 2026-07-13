<?php

/**
 * Citation review — billing math (docs/billing.md).
 *
 * CitationReviewCommand::billReview() aggregates the review's REAL costs into
 * one 'ai_review' charge: OCR pages (priced per the served model recorded in
 * the pipeline's step_timings) + per-model LLM token costs. Nothing else
 * asserted this math — the lifecycle tests never bill. billReview is private
 * (only the command calls it), so it is invoked through reflection with a
 * buffered output; the charge itself runs for real into the ledger.
 */

use App\Console\Commands\CitationReviewCommand;
use App\Models\User;
use Illuminate\Console\OutputStyle;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\Console\Input\ArrayInput;
use Symfony\Component\Console\Output\BufferedOutput;

function citationBillReview(User $user, string $bookId, array $stats): void
{
    $command = app(CitationReviewCommand::class);
    $command->setLaravel(app());
    $command->setOutput(new OutputStyle(new ArrayInput([]), new BufferedOutput()));

    $method = new ReflectionMethod($command, 'billReview');
    $method->invoke($command, $user, $bookId, 'Billing Math Test Book', $stats);
}

beforeEach(function () {
    $this->mock(\App\Http\Controllers\UserHomeServerController::class, function ($mock) {
        $mock->shouldReceive('generateAccountBook')->andReturnNull();
    });
});

it('bills OCR pages (per served model) + per-model LLM tokens as one ai_review charge', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 50]);
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);

    // Pipeline row carrying the OCR telemetry billReview reads (committed via
    // admin conn — deleted below).
    $pipelineId = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('citation_pipelines')->insert([
        'id' => $pipelineId,
        'book' => 'book_cite_billing_test',
        'status' => 'completed',
        'step_timings' => json_encode([
            'ocr' => ['total_pages' => 100, 'model' => 'mistral-ocr-2512'],
        ]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    try {
        citationBillReview($user, 'book_cite_billing_test', [
            'pipeline_id' => $pipelineId,
            'llm_usage' => [
                'by_model' => [
                    // 1M in + 1M out on deepseek-v4-pro = $1.74 + $3.48 = $5.22
                    'accounts/fireworks/models/deepseek-v4-pro' => [
                        'prompt_tokens'     => 1_000_000,
                        'completion_tokens' => 1_000_000,
                    ],
                ],
            ],
        ]);

        // Raw: OCR 100/1000 × $2.00 = $0.20, LLM $5.22 → $5.42 × budget 1.5 = $8.13
        $rows = DB::table('billing_ledger')
            ->where('user_id', $user->id)->where('category', 'ai_review')->get();
        expect($rows)->toHaveCount(1);
        expect((float) $rows[0]->amount)->toEqualWithDelta(5.42 * 1.5, 0.0001);

        // Line items carry the itemized receipt: one OCR line + one per model.
        $lineItems = json_decode($rows[0]->line_items, true);
        expect($lineItems)->toHaveCount(2);
        expect($lineItems[0]['category'])->toBe('ocr');
        expect((float) $lineItems[0]['amount'])->toEqualWithDelta(0.20, 0.0001);
        expect($lineItems[1]['category'])->toBe('llm');
        expect((float) $lineItems[1]['amount'])->toEqualWithDelta(5.22, 0.0001);

        expect((float) User::find($user->id)->debits)->toEqualWithDelta(5.42 * 1.5, 0.0001);
    } finally {
        DB::connection('pgsql_admin')->table('citation_pipelines')->where('id', $pipelineId)->delete();
    }
});

it('bills from a WORKER context with no RLS session vars (silent-no-op regression)', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 50]);

    // Faithful worker simulation: the pipeline job (server-inference mode)
    // never sets the RLS vars before Artisan::call reaches billReview.
    foreach (['app.current_user', 'app.current_token', 'app.session_id'] as $var) {
        DB::statement("SELECT set_config(?, '', false)", [$var]);
    }

    citationBillReview($user, 'book_cite_billing_worker', [
        'llm_usage' => [
            'by_model' => [
                'accounts/fireworks/models/deepseek-v4-pro' => [
                    'prompt_tokens'     => 1_000_000,
                    'completion_tokens' => 1_000_000,
                ],
            ],
        ],
    ]);

    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
    $rows = DB::table('billing_ledger')
        ->where('user_id', $user->id)->where('category', 'ai_review')->get();
    expect($rows)->toHaveCount(1);
    expect((float) $rows[0]->amount)->toEqualWithDelta(5.22 * 1.5, 0.0001);
});

it('waives the LLM cost for BYO (client-inference) pipelines but still bills the server OCR', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 50]);
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);

    $pipelineId = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('citation_pipelines')->insert([
        'id' => $pipelineId,
        'book' => 'book_cite_billing_byo',
        'status' => 'completed',
        'inference_mode' => 'client', // the user's own key answered every LLM call
        'step_timings' => json_encode([
            'ocr' => ['total_pages' => 100, 'model' => 'mistral-ocr-2512'],
        ]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    try {
        citationBillReview($user, 'book_cite_billing_byo', [
            'pipeline_id' => $pipelineId,
            'llm_usage' => [
                'by_model' => [
                    'accounts/fireworks/models/deepseek-v4-pro' => [
                        'prompt_tokens'     => 1_000_000,
                        'completion_tokens' => 1_000_000,
                    ],
                ],
            ],
        ]);

        // Only the OCR line survives: 100/1000 × $2.00 = $0.20 raw × 1.5 = $0.30.
        $rows = DB::table('billing_ledger')
            ->where('user_id', $user->id)->where('category', 'ai_review')->get();
        expect($rows)->toHaveCount(1);
        expect((float) $rows[0]->amount)->toEqualWithDelta(0.20 * 1.5, 0.0001);
        $lineItems = json_decode($rows[0]->line_items, true);
        expect($lineItems)->toHaveCount(1);
        expect($lineItems[0]['category'])->toBe('ocr');
    } finally {
        DB::connection('pgsql_admin')->table('citation_pipelines')->where('id', $pipelineId)->delete();
    }
});

it('charges nothing when the review produced no billable usage', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 50]);
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);

    citationBillReview($user, 'book_cite_billing_zero', [
        'llm_usage' => ['by_model' => []],
    ]);

    expect(DB::table('billing_ledger')->where('user_id', $user->id)->count())->toBe(0);
    expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001);
});
