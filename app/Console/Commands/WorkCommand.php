<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;

/**
 * Single catch-all worker for quick manual shells ONLY. Covers EVERY named
 * queue in priority order — which means it is SERIAL: a 15-min citation
 * pipeline head-of-line-blocks a document import behind it.
 *
 * `npm run dev:all` / `dev:network` therefore do NOT use this any more: they
 * start a dedicated worker per queue (queue:import x2, queue:citation,
 * queue:vibe, queue:embeddings — see package.json), mirroring the prod
 * Supervisor topology (deploy/supervisor/). Use this command only for a
 * one-off `php artisan work` outside the dev stack; running it ALONGSIDE the
 * dedicated workers is harmless but pointless (it competes for the same jobs).
 *
 * Queue names live on the jobs' onQueue() calls — if you add a new queue, add
 * it here, to package.json's dev scripts, and to deploy/supervisor/.
 */
class WorkCommand extends Command
{
    protected $signature = 'work';

    protected $description = 'Catch-all single worker over every queue (manual use; dev:all runs dedicated per-queue workers instead)';

    public function handle(): int
    {
        $this->warn('Single SERIAL worker over all queues — long jobs block short ones.');
        $this->info('Working queues: citation-pipeline > vibe > default > embeddings  (Ctrl+C to stop)');

        return $this->call('queue:work', [
            '--queue'   => 'citation-pipeline,vibe,default,embeddings',
            '--timeout' => 7200, // jobs with their own $timeout still take precedence
        ]);
    }
}
