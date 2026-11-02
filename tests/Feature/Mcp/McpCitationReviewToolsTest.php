<?php

use App\Jobs\CitationPipelineJob;
use App\Mcp\TokenAbilities;
use App\Models\User;
use App\Services\BillingService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

/**
 * run_citation_review / get_citation_review / claim_review_work /
 * submit_review_verdict over the real /mcp endpoint. The pipeline JOB is faked
 * (Queue::fake) and BillingService::canProceed is mocked, so these test the
 * MCP seam — the trigger/row, the spend gate, status, and the BYO ticket loop
 * incl. RLS isolation — not the hours-long review itself.
 */

beforeEach(function () {
    // canProceed true by default; a test overrides for the 402 path.
    $this->mock(BillingService::class, function ($m) {
        $m->shouldReceive('canProceed')->andReturn(true)->byDefault();
    });
});

function crToken(User $user, array $abilities): string
{
    return $user->createToken('mcp cr', $abilities, now()->addYear())->plainTextToken;
}

function crCall($test, string $token, string $tool, array $arguments)
{
    app('auth')->forgetGuards();

    return $test->postJson('/mcp', [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call',
        'params' => ['name' => $tool, 'arguments' => $arguments],
    ], ['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json, text/event-stream']);
}

function crJson($response): array
{
    return json_decode((string) ($response->json('result.content.0.text') ?? ''), true) ?: [];
}

function crSeedBook($test, User $owner): string
{
    $book = 'book_mcpcr_'.Str::random(6);
    (function () use ($book, $owner) {
        $this->seedLibrary(['book' => $book, 'title' => 'Cited Work', 'visibility' => 'private', 'creator' => $owner->name]);
    })->call($test);

    return $book;
}

test('run_citation_review triggers the pipeline with inference_mode from use_my_model', function () {
    Queue::fake();
    $user = $this->seedUser();
    $book = crSeedBook($this, $user);
    $token = crToken($user, [TokenAbilities::SPEND]);

    $response = crCall($this, $token, 'run_citation_review', ['book' => $book, 'use_my_model' => true]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $json = crJson($response);
    expect($json['using_my_model'])->toBeTrue();
    expect($json['pipeline_id'])->not->toBeNull();
    expect($json)->toHaveKey('byo_instructions');

    $row = DB::connection('pgsql_admin')->table('citation_pipelines')->where('book', $book)->first();
    expect($row)->not->toBeNull();
    expect($row->inference_mode)->toBe('client');
    Queue::assertPushed(CitationPipelineJob::class, 1);
});

test('run_citation_review defaults to the server model (no byo instructions)', function () {
    Queue::fake();
    $user = $this->seedUser();
    $book = crSeedBook($this, $user);
    $token = crToken($user, [TokenAbilities::SPEND]);

    $json = crJson(crCall($this, $token, 'run_citation_review', ['book' => $book]));
    expect($json['using_my_model'])->toBeFalse();
    expect($json)->not->toHaveKey('byo_instructions');
    expect(DB::connection('pgsql_admin')->table('citation_pipelines')->where('book', $book)->value('inference_mode'))
        ->toBe('server');
});

test('run_citation_review requires the spend ability', function () {
    Queue::fake();
    $user = $this->seedUser();
    $book = crSeedBook($this, $user);
    $token = crToken($user, [TokenAbilities::READ, TokenAbilities::IMPORT]);

    $response = crCall($this, $token, 'run_citation_review', ['book' => $book]);
    // Ability-sized listing: hidden from the token, so tool-not-found.
    expect($response->json('error.code'))->toBe(-32602);
    Queue::assertNothingPushed();
});

test('run_citation_review surfaces an insufficient balance clearly', function () {
    Queue::fake();
    $this->mock(BillingService::class, fn ($m) => $m->shouldReceive('canProceed')->andReturn(false));
    $user = $this->seedUser();
    $book = crSeedBook($this, $user);
    $token = crToken($user, [TokenAbilities::SPEND]);

    $response = crCall($this, $token, 'run_citation_review', ['book' => $book]);
    expect($response->json('result.isError'))->toBeTrue();
    expect((string) $response->json('result.content.0.text'))->toContain('Insufficient balance');
    Queue::assertNothingPushed();
});

test('get_citation_review reports running status, and none when absent', function () {
    Queue::fake();
    $user = $this->seedUser();
    $book = crSeedBook($this, $user);
    $token = crToken($user, [TokenAbilities::SPEND]);

    // Before any run: none.
    $none = crJson(crCall($this, crToken($user, [TokenAbilities::READ]), 'get_citation_review', ['book' => $book]));
    expect($none['status'])->toBe('none');
    expect($none['report_ready'])->toBeFalse();

    // Trigger → a pending pipeline exists → running status.
    crCall($this, $token, 'run_citation_review', ['book' => $book]);
    $running = crJson(crCall($this, crToken($user, [TokenAbilities::READ]), 'get_citation_review', ['book' => $book]));
    expect($running['status'])->toBe('pending');
    expect($running['report_ready'])->toBeFalse();
});

test('get_citation_review surfaces a paused review (not "none"), and run_citation_review resumes it', function () {
    Queue::fake();
    $user = $this->seedUser();
    $book = crSeedBook($this, $user);

    // Seed a PAUSED client-mode pipeline (as happens when BYO answers are slow).
    $pipelineId = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('citation_pipelines')->insert([
        'id' => $pipelineId, 'book' => $book, 'status' => 'paused',
        'current_step' => 'review', 'inference_mode' => 'client',
        'user_id' => $user->id, 'created_at' => now(), 'updated_at' => now(),
    ]);

    try {
        // get_citation_review must report paused + resume guidance. For a
        // client-mode (BYO) pipeline the note must frame the pause as the
        // NORMAL drain rhythm — an agent reading "didn't arrive in time"
        // treats a healthy run as a failure — and still name the resume call.
        $status = crJson(crCall($this, crToken($user, [TokenAbilities::READ]), 'get_citation_review', ['book' => $book]));
        expect($status['status'])->toBe('paused');
        expect($status['note'])->toContain('NORMAL');
        expect($status['note'])->toContain('run_citation_review');

        // run_citation_review resumes the SAME pipeline rather than starting new.
        $resume = crJson(crCall($this, crToken($user, [TokenAbilities::SPEND]), 'run_citation_review', ['book' => $book]));
        expect($resume['resumed'] ?? null)->toBeTrue();
        expect($resume['pipeline_id'])->toBe($pipelineId);
        expect($resume['using_my_model'])->toBeTrue();
        expect($resume)->toHaveKey('byo_instructions');
        Queue::assertPushed(CitationPipelineJob::class, 1);

        // No NEW pipeline row was created.
        expect(DB::connection('pgsql_admin')->table('citation_pipelines')->where('book', $book)->count())->toBe(1);
    } finally {
        DB::connection('pgsql_admin')->table('citation_pipelines')->where('id', $pipelineId)->delete();
    }
});

test('claim_review_work + submit_review_verdict round-trips an ai_review ticket (RLS-scoped)', function () {
    $owner = $this->seedUser();
    $token = crToken($owner, [TokenAbilities::READ]);

    // Seed a parked ai_review ticket owned by the user (RLS: creator = name).
    $ticketId = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('inference_tickets')->insert([
        'id' => $ticketId,
        'creator' => $owner->name,
        'feature' => 'ai_review',
        'context_id' => 'pipe-1',
        'request_hash' => hash('sha256', 'x'),
        'status' => 'pending',
        'request' => json_encode(['model' => 'x', 'messages' => [
            ['role' => 'system', 'content' => 'Judge the claim.'],
            ['role' => 'user', 'content' => 'Does source S support claim C?'],
        ]]),
        'expires_at' => now()->addMinutes(15),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    // Claim → returns the prompt messages.
    $claim = crJson(crCall($this, $token, 'claim_review_work', []));
    expect($claim['count'])->toBe(1);
    expect($claim['work'][0]['work_id'])->toBe($ticketId);
    expect($claim['work'][0]['messages'])->toHaveCount(2);

    // Submit the answer.
    $submit = crCall($this, $token, 'submit_review_verdict', ['work_id' => $ticketId, 'answer' => '{"support":"confirmed"}']);
    expect($submit->json('result.isError'))->not->toBeTrue();
    expect(crJson($submit)['status'])->toBe('completed');

    // Read on the DEFAULT connection with the owner's RLS context — the
    // completion wrote there (inside the test transaction), so pgsql_admin
    // can't see it.
    DB::statement("select set_config('app.current_user', ?, false)", [$owner->name]);
    expect(DB::table('inference_tickets')->where('id', $ticketId)->value('status'))->toBe('completed');

    // RLS: a DIFFERENT user can neither claim nor complete it.
    $stranger = $this->seedUser();
    app('auth')->forgetGuards();
    // Re-seed a fresh pending ticket for the owner so there IS claimable work.
    $t2 = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('inference_tickets')->insert([
        'id' => $t2, 'creator' => $owner->name, 'feature' => 'ai_review', 'context_id' => 'pipe-1',
        'request_hash' => hash('sha256', 'y'), 'status' => 'pending',
        'request' => json_encode(['messages' => []]), 'expires_at' => now()->addMinutes(15),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $strangerClaim = crJson(crCall($this, crToken($stranger, [TokenAbilities::READ]), 'claim_review_work', []));
    expect($strangerClaim['count'])->toBe(0); // can't see the owner's tickets
});

