<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;

/**
 * The "just run the worker" command for dev. Covers EVERY named queue in the
 * codebase in user-facing-first priority order, so a citation review or vibe
 * convert never waits behind a 29k embeddings backlog.
 *
 * Queue names live on the jobs' onQueue() calls — if you add a new queue,
 * add it here (and to the prod Supervisor config, see
 * memory: prod-infra-digitalocean / docs deploy notes).
 */
class WorkCommand extends Command
{
    protected $signature = 'work';

    protected $description = 'Dev queue worker over all queues, right priority order (citation-pipeline > vibe > default > embeddings)';

    public function handle(): int
    {
        $this->info('Working queues: citation-pipeline > vibe > default > embeddings  (Ctrl+C to stop)');

        return $this->call('queue:work', [
            '--queue'   => 'citation-pipeline,vibe,default,embeddings',
            '--timeout' => 7200, // jobs with their own $timeout still take precedence
        ]);
    }
}
