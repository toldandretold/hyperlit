<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Jobs\GenerateNodeEmbeddingsJob;

/**
 * Generate vector embeddings for nodes.
 *
 * USAGE:
 *   php artisan nodes:generate-embeddings              # Queue job for all books
 *   php artisan nodes:generate-embeddings {book}       # Queue job for one book
 *   php artisan nodes:generate-embeddings --sync       # Run synchronously (no queue)
 */
class GenerateEmbeddings extends Command
{
    protected $signature = 'nodes:generate-embeddings
                            {book? : Optional book ID to target}
                            {--sync : Run synchronously instead of queueing}';

    protected $description = 'Generate vector embeddings for nodes that are missing them';

    public function handle(): int
    {
        $book = $this->argument('book');

        $this->info('Generating embeddings for ' . ($book ?? 'all books') . '...');

        if ($this->option('sync')) {
            $job = new GenerateNodeEmbeddingsJob($book);
            $job->handle(app(\App\Services\EmbeddingService::class));
            $this->info('Done (synchronous).');
        } else {
            GenerateNodeEmbeddingsJob::dispatch($book);
            $this->info('Job dispatched to queue.');
        }

        return self::SUCCESS;
    }
}
