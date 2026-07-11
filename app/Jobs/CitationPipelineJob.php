<?php

namespace App\Jobs;

use App\Models\User;
use App\Services\Llm\ClientInferenceUnavailableException;
use App\Services\Llm\ClientTicketTransport;
use App\Services\LlmService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class CitationPipelineJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 7200; // 2 hours — LLM calls are slow, batched 5 at a time
    public int $tries = 3;

    public function __construct(
        private string $bookId,
        private string $pipelineId,
        private bool $force = false,
        private ?int $userId = null,
        private bool $resume = false,
    ) {
        $this->onQueue('citation-pipeline');
    }

    /**
     * Backoff between retries: 1 minute, then 5 minutes.
     */
    public function backoff(): array
    {
        return [60, 300];
    }

    public function handle(): void
    {
        Log::info('CitationPipelineJob starting', [
            'book'       => $this->bookId,
            'pipelineId' => $this->pipelineId,
            'attempt'    => $this->attempts(),
        ]);

        $db = DB::connection('pgsql_admin');

        // Mark pipeline as running (handles both first attempt and retries)
        $update = [
            'status'     => 'running',
            'error'      => null,
            'updated_at' => now(),
        ];
        if ($this->attempts() === 1 && !$this->resume) {
            $update['current_step'] = 'bibliography';
        }
        $db->table('citation_pipelines')
            ->where('id', $this->pipelineId)
            ->update($update);

        $args = [
            'bookId'          => $this->bookId,
            '--pipeline-id'   => $this->pipelineId,
        ];
        if ($this->force) {
            $args['--force'] = true;
        }
        if ($this->userId) {
            $args['--user-id'] = $this->userId;
        }
        if ($this->resume || $this->attempts() > 1) {
            $args['--resume'] = true;
        }

        // BYO (client-inference) mode is recorded on the pipeline row so resume
        // and retry flows recover it without the client restating it. When set,
        // route every LLM call the command chain makes through inference tickets
        // — the singleton LlmService carries the transport through the whole
        // in-process Artisan::call with zero changes to the citation commands.
        $clientMode = ($db->table('citation_pipelines')
            ->where('id', $this->pipelineId)
            ->value('inference_mode')) === 'client';

        $llmService = app(LlmService::class);
        $rlsVarsSet = false;

        if ($clientMode) {
            $user = User::on('pgsql_admin')->find($this->userId);
            if (!$user) {
                throw new \RuntimeException("Client-inference pipeline {$this->pipelineId} has no user");
            }

            // Tickets live on the DEFAULT (RLS) connection; a queue worker has no
            // HTTP session, so set BOTH session vars the way
            // SetDatabaseSessionContext does (GenerateBookAudioJob pattern) or
            // every ticket INSERT/SELECT silently matches zero rows.
            DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
            DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
            $rlsVarsSet = true;

            $llmService->setTransport(new ClientTicketTransport(
                $user->name,
                'ai_review',
                $this->pipelineId,
                ttlSeconds: (int) config('services.llm.ticket_ttl_seconds', 300) * 3, // review prompts can queue behind 4-at-a-time workers
            ));
        }

        try {
            $exitCode = Artisan::call('citation:pipeline', $args);
        } catch (ClientInferenceUnavailableException $e) {
            // The client (native app) stopped answering tickets — PAUSE, don't
            // fail: the resume endpoint + --resume step-skip + ticket dedupe
            // replay everything already answered.
            Log::warning('CitationPipelineJob paused — client inference unavailable', [
                'book'       => $this->bookId,
                'pipelineId' => $this->pipelineId,
                'error'      => $e->getMessage(),
            ]);
            $db->table('citation_pipelines')
                ->where('id', $this->pipelineId)
                ->update([
                    'status'     => 'paused',
                    'error'      => 'Waiting for your AI provider — reopen the app and resume.',
                    'updated_at' => now(),
                ]);
            return; // no throw ⇒ no retry burn; resume is user-driven
        } finally {
            $llmService->clearTransport();
            if ($rlsVarsSet) {
                DB::statement("SELECT set_config('app.current_user', '', false)");
                DB::statement("SELECT set_config('app.current_token', '', false)");
            }
        }

        if ($exitCode !== 0) {
            $output = Artisan::output();
            Log::error('CitationPipelineJob step failed', [
                'book'       => $this->bookId,
                'pipelineId' => $this->pipelineId,
                'exitCode'   => $exitCode,
                'output'     => $output,
                'attempt'    => $this->attempts(),
            ]);
            throw new \RuntimeException("citation:pipeline exited with code {$exitCode}");
        }

        // Mark pipeline as completed
        $db->table('citation_pipelines')
            ->where('id', $this->pipelineId)
            ->update(['status' => 'completed', 'updated_at' => now()]);

        Log::info('CitationPipelineJob completed', [
            'book'       => $this->bookId,
            'pipelineId' => $this->pipelineId,
        ]);
    }

    /**
     * Called after all retry attempts are exhausted.
     */
    public function failed(\Throwable $e): void
    {
        Log::error('CitationPipelineJob permanently failed after all retries', [
            'book'       => $this->bookId,
            'pipelineId' => $this->pipelineId,
            'error'      => $e->getMessage(),
        ]);

        DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $this->pipelineId)
            ->update([
                'status'     => 'failed',
                'error'      => $e->getMessage(),
                'updated_at' => now(),
            ]);
    }
}
