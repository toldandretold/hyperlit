<?php

use App\Jobs\CitationPipelineJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;

/**
 * Phase E — citation pipeline over BYO inference tickets: the trigger persists
 * inference_mode, billing pre-check stays (OCR still costs the server), and
 * paused pipelines are resumable.
 */

function adminPipeline(string $id): ?object
{
    return DB::connection('pgsql_admin')->table('citation_pipelines')->where('id', $id)->first();
}

function giveCredits(int $userId, float $amount = 5.0): void
{
    // canProceed reads $user->balance (credits - debits on the users row).
    DB::connection('pgsql_admin')->table('users')->where('id', $userId)->update(['credits' => $amount]);
}

afterEach(function () {
    // Pipelines are admin-committed (not covered by SeedsRlsFixtures cleanup).
    DB::connection('pgsql_admin')->table('citation_pipelines')->where('book', 'like', 'byo_pipe_%')->delete();
});

describe('trigger with client_inference', function () {
    it('persists inference_mode=client on the pipeline row', function () {
        Queue::fake();
        $user = $this->seedUser();
        giveCredits($user->id);
        $book = $this->seedLibrary(['book' => 'byo_pipe_book1', 'creator' => $user->name, 'title' => 'BYO Pipe']);

        $resp = $this->actingAs($user)->postJson('/api/citation-pipeline/trigger', [
            'book' => $book,
            'client_inference' => true,
        ]);

        $resp->assertOk();
        $pipeline = adminPipeline($resp->json('pipeline_id'));
        expect($pipeline->inference_mode)->toBe('client');
        Queue::assertPushed(CitationPipelineJob::class);
    });

    it('defaults to server mode without the flag', function () {
        Queue::fake();
        $user = $this->seedUser();
        giveCredits($user->id);
        $book = $this->seedLibrary(['book' => 'byo_pipe_book2', 'creator' => $user->name, 'title' => 'BYO Pipe 2']);

        $resp = $this->actingAs($user)->postJson('/api/citation-pipeline/trigger', ['book' => $book]);

        $resp->assertOk();
        expect(adminPipeline($resp->json('pipeline_id'))->inference_mode)->toBe('server');
    });

    it('still requires balance even in BYO mode (OCR costs are server-side)', function () {
        Queue::fake();
        $user = $this->seedUser(); // no credits
        $book = $this->seedLibrary(['book' => 'byo_pipe_book3', 'creator' => $user->name, 'title' => 'BYO Pipe 3']);

        $this->actingAs($user)->postJson('/api/citation-pipeline/trigger', [
            'book' => $book,
            'client_inference' => true,
        ])->assertStatus(402);
    });
});

describe('paused pipelines', function () {
    it('can be resumed (re-queues the job)', function () {
        Queue::fake();
        $user = $this->seedUser();
        giveCredits($user->id);
        $book = $this->seedLibrary(['book' => 'byo_pipe_book4', 'creator' => $user->name, 'title' => 'BYO Pipe 4']);

        $pipelineId = (string) \Illuminate\Support\Str::uuid();
        DB::connection('pgsql_admin')->table('citation_pipelines')->insert([
            'id' => $pipelineId,
            'book' => $book,
            'user_id' => $user->id,
            'status' => 'paused',
            'inference_mode' => 'client',
            'error' => 'Waiting for your AI provider — reopen the app and resume.',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $this->actingAs($user)
            ->postJson("/api/citation-pipeline/resume/{$pipelineId}")
            ->assertOk();

        expect(adminPipeline($pipelineId)->status)->toBe('pending');
        Queue::assertPushed(CitationPipelineJob::class);
    });

    it('still rejects resuming a running pipeline', function () {
        $user = $this->seedUser();
        giveCredits($user->id);
        $book = $this->seedLibrary(['book' => 'byo_pipe_book5', 'creator' => $user->name, 'title' => 'BYO Pipe 5']);

        $pipelineId = (string) \Illuminate\Support\Str::uuid();
        DB::connection('pgsql_admin')->table('citation_pipelines')->insert([
            'id' => $pipelineId,
            'book' => $book,
            'user_id' => $user->id,
            'status' => 'running',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $this->actingAs($user)
            ->postJson("/api/citation-pipeline/resume/{$pipelineId}")
            ->assertStatus(422);
    });
});
