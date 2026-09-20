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

it('bills Brave web-search requests as their own line item', function () {
    // Brave charges per REQUEST ($5/1k) and the cost scales with how many
    // references a document has — it used to be absorbed entirely by us
    // (~$0.65 per review, invisible in the ledger).
    $user = $this->seedUser(['status' => 'budget', 'credits' => 50]);
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);

    $pipelineId = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('citation_pipelines')->insert([
        'id' => $pipelineId,
        'book' => 'book_cite_billing_web',
        'status' => 'completed',
        'step_timings' => json_encode([
            'web_search' => ['requests' => 130, 'provider' => 'brave'],
        ]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    try {
        citationBillReview($user, 'book_cite_billing_web', ['pipeline_id' => $pipelineId]);

        // 130/1000 × $5.00 = $0.65 raw → × budget 1.5 = $0.975
        $rows = DB::table('billing_ledger')
            ->where('user_id', $user->id)->where('category', 'ai_review')->get();
        expect($rows)->toHaveCount(1);
        expect((float) $rows[0]->amount)->toEqualWithDelta(0.65 * 1.5, 0.0001);

        $lineItems = json_decode($rows[0]->line_items, true);
        expect($lineItems)->toHaveCount(1);
        expect($lineItems[0]['category'])->toBe('web_search');
        expect($lineItems[0]['quantity'])->toBe(130);
        expect($lineItems[0]['unit'])->toBe('requests');
        expect($lineItems[0]['meta']['provider'])->toBe('brave');
        expect((float) $lineItems[0]['amount'])->toEqualWithDelta(0.65, 0.0001);
    } finally {
        DB::connection('pgsql_admin')->table('citation_pipelines')->where('id', $pipelineId)->delete();
    }
});

it('bills web search even under BYO — the Brave key is OURS in every inference mode', function () {
    // Deliberate asymmetry vs LLM tokens: inference tickets mean the user's own
    // key paid their LLM provider, but every Brave request still ran on our
    // subscription, so waiving it would hand away a real cost.
    $user = $this->seedUser(['status' => 'budget', 'credits' => 50]);
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);

    $pipelineId = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('citation_pipelines')->insert([
        'id' => $pipelineId,
        'book' => 'book_cite_billing_web_byo',
        'status' => 'completed',
        'inference_mode' => 'client',
        'step_timings' => json_encode([
            'web_search' => ['requests' => 200, 'provider' => 'brave'],
        ]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    try {
        citationBillReview($user, 'book_cite_billing_web_byo', [
            'pipeline_id' => $pipelineId,
            'llm_usage' => ['by_model' => [
                'accounts/fireworks/models/deepseek-v4-pro' => [
                    'prompt_tokens' => 1_000_000, 'completion_tokens' => 1_000_000,
                ],
            ]],
        ]);

        $rows = DB::table('billing_ledger')
            ->where('user_id', $user->id)->where('category', 'ai_review')->get();
        expect($rows)->toHaveCount(1);
        // ONLY the web search: 200/1000 × $5 = $1.00 × 1.5. LLM waived.
        expect((float) $rows[0]->amount)->toEqualWithDelta(1.00 * 1.5, 0.0001);
        $lineItems = json_decode($rows[0]->line_items, true);
        expect(array_column($lineItems, 'category'))->toBe(['web_search']);
    } finally {
        DB::connection('pgsql_admin')->table('citation_pipelines')->where('id', $pipelineId)->delete();
    }
});

it('prices requests from config so a Brave rate change is one edit', function () {
    expect(\App\Services\BraveSearchService::costForRequests(1000))->toEqualWithDelta(5.00, 0.0001);
    expect(\App\Services\BraveSearchService::costForRequests(130))->toEqualWithDelta(0.65, 0.0001);
    expect(\App\Services\BraveSearchService::costForRequests(0))->toBe(0.0);
    config(['services.brave_search.price_per_1k_requests' => 8.00]);
    expect(\App\Services\BraveSearchService::costForRequests(1000))->toEqualWithDelta(8.00, 0.0001);
});

it('counts every issued request, including ones that resolve nothing', function () {
    // Brave bills on issue, so a 402 or a no-useful-results response is still
    // a charge — the counter must not be inferred from resolutions.
    \Illuminate\Support\Facades\Http::fake([
        'api.search.brave.com/*' => \Illuminate\Support\Facades\Http::response(
            ['type' => 'ErrorResponse', 'error' => ['status' => 402]], 402),
    ]);
    config(['services.brave_search.api_key' => 'test-key']);

    $brave = app(\App\Services\BraveSearchService::class);
    $brave->resetRequestCount();
    expect($brave->requestCount())->toBe(0);

    $brave->searchAndFetch('A Title', 'Author', 2020, DB::connection('pgsql_admin'));
    expect($brave->requestCount())->toBe(1);

    // The batch path counts its whole chunk.
    $brave->searchAndFetchBatch([
        'r1' => ['title' => 'One', 'author' => null, 'year' => null],
        'r2' => ['title' => 'Two', 'author' => null, 'year' => null],
    ], DB::connection('pgsql_admin'));
    expect($brave->requestCount())->toBe(3);
});

it('shares one BraveSearchService instance so the scan count survives to billing', function () {
    // The LlmService lesson: with a fresh instance per resolve, the count read
    // at billing time is 0 and every web search is free for the user.
    expect(app(\App\Services\BraveSearchService::class))
        ->toBe(app(\App\Services\BraveSearchService::class));
});
