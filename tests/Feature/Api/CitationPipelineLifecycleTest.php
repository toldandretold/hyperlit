<?php

/**
 * Citation pipeline lifecycle + failure modes over HTTP — the machinery the
 * AI-review button drives. Locks: the live-viz contract (telemetry + map in
 * the API), stale auto-fail (a wedged pipeline must not block the book
 * forever), resume guards, and trigger concurrency.
 */

use App\Jobs\CitationPipelineJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function pipeDb()
{
    return DB::connection('pgsql_admin');
}

function pipeSeed(string $book, array $opts = []): string
{
    $id = (string) Str::uuid();
    pipeDb()->table('citation_pipelines')->insert(array_merge([
        'id'         => $id,
        'book'       => $book,
        'status'     => 'running',
        'created_at' => now(),
        'updated_at' => now(),
    ], $opts));
    return $id;
}

afterEach(function () {
    $this->cleanupApiFixtures();
});

// ── Live-viz contract ──────────────────────────────────────────────

test('pipeline map endpoint returns the stage chain with notes and code refs', function () {
    $this->loginUser();

    $resp = $this->getJson('/api/citation-pipeline/map')->assertOk();

    $stages = $resp->json('stages');
    expect(array_column($stages, 'id'))->toBe(['bibliography', 'vacuum', 'ocr', 'review']);
    foreach ($stages as $stage) {
        expect($stage['plain'])->not->toBeEmpty();
        expect($stage['code_ref'])->not->toBeEmpty();
    }
    // Review carries its sub-stages for the nested viz row
    expect(collect($stages)->firstWhere('id', 'review')['substages'])->not->toBeEmpty();
});

test('status endpoint returns the telemetry event stream', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = pipeSeed($book, [
        'current_step' => 'vacuum',
        'telemetry'    => json_encode([
            ['stage' => 'bibliography', 'status' => 'completed', 'at' => now()->toDateTimeString()],
            ['stage' => 'vacuum', 'status' => 'started', 'detail' => 'Fetching source 1/3', 'at' => now()->toDateTimeString()],
        ]),
    ]);

    $this->getJson("/api/citation-pipeline/status/{$id}")
        ->assertOk()
        ->assertJsonPath('pipeline.telemetry.0.stage', 'bibliography')
        ->assertJsonPath('pipeline.telemetry.1.detail', 'Fetching source 1/3')
        ->assertJsonPath('pipeline.current_step', 'vacuum');
});

// ── Stale auto-fail ────────────────────────────────────────────────

test('a pipeline stuck in pending for over 5 minutes is auto-failed by the status poll', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = pipeSeed($book, ['status' => 'pending', 'updated_at' => now()->subMinutes(10)]);

    $this->getJson("/api/citation-pipeline/status/{$id}")
        ->assertOk()
        ->assertJsonPath('pipeline.status', 'failed');

    expect(pipeDb()->table('citation_pipelines')->where('id', $id)->value('error'))
        ->toContain('stuck in pending');
});

test('a pipeline with no progress for over 3 hours is auto-failed', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = pipeSeed($book, ['status' => 'running', 'updated_at' => now()->subHours(4)]);

    $this->getJson("/api/citation-pipeline/status/{$id}")
        ->assertOk()
        ->assertJsonPath('pipeline.status', 'failed');
});

test('a fresh running pipeline is left alone', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = pipeSeed($book, ['status' => 'running', 'updated_at' => now()]);

    $this->getJson("/api/citation-pipeline/status/{$id}")
        ->assertOk()
        ->assertJsonPath('pipeline.status', 'running');
});

// ── Resume guards ──────────────────────────────────────────────────

test('only failed pipelines can be resumed', function () {
    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);
    $id = pipeSeed($book, ['status' => 'completed']);

    $this->assertApiError($this->postJson("/api/citation-pipeline/resume/{$id}"), 422);
});

test('resuming a failed pipeline re-queues the job and resets it to pending', function () {
    Queue::fake();

    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);
    $id = pipeSeed($book, ['status' => 'failed', 'error' => 'boom']);

    $this->postJson("/api/citation-pipeline/resume/{$id}")
        ->assertOk()
        ->assertJsonPath('pipeline_id', $id);

    Queue::assertPushed(CitationPipelineJob::class);

    $row = pipeDb()->table('citation_pipelines')->where('id', $id)->first();
    expect($row->status)->toBe('pending');
    expect($row->error)->toBeNull();
});

// ── Trigger concurrency ────────────────────────────────────────────

test('triggering while a pipeline is already running returns 409', function () {
    Queue::fake();

    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);
    pipeSeed($book, ['status' => 'running', 'updated_at' => now()]);

    $this->assertApiError(
        $this->postJson('/api/citation-pipeline/trigger', ['book' => $book]),
        409,
    );
    Queue::assertNothingPushed();
});
