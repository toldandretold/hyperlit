<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use App\Services\EmbeddingService;

/**
 * Generate vector embeddings for nodes that don't have one yet.
 *
 * Processes in batches to stay within API rate limits and memory.
 * Can be dispatched for a single book or for all books.
 *
 * Usage:
 *   GenerateNodeEmbeddingsJob::dispatch();              // all books
 *   GenerateNodeEmbeddingsJob::dispatch('my-book-id');  // single book
 */
class GenerateNodeEmbeddingsJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600; // 1 hour max
    public int $tries = 1;

    private const BATCH_SIZE = 32; // texts per embedding API call
    private const MIN_TEXT_LENGTH = 20; // skip trivially short nodes

    public function __construct(
        private ?string $bookId = null,
    ) {}

    public function handle(EmbeddingService $embeddingService): void
    {
        $db = DB::connection('pgsql_admin');
        $processed = 0;
        $failed = 0;

        Log::info('Starting embedding generation', ['book' => $this->bookId ?? 'all']);

        $query = $db->table('nodes')
            ->whereNull('embedding')
            ->where('book', 'NOT LIKE', 'most-%')
            ->whereRaw("LENGTH(COALESCE(\"plainText\", '')) >= ?", [self::MIN_TEXT_LENGTH])
            ->orderBy('book')
            ->orderBy('startLine');

        if ($this->bookId) {
            $query->where('book', $this->bookId);
        }

        $query->chunkById(self::BATCH_SIZE, function ($nodes) use ($embeddingService, $db, &$processed, &$failed) {
            $texts = [];
            $ids = [];

            foreach ($nodes as $node) {
                $text = $node->plainText ?: strip_tags($node->content ?? '');
                if (mb_strlen($text) < self::MIN_TEXT_LENGTH) {
                    continue;
                }
                $texts[] = $text;
                $ids[] = $node->id;
            }

            if (empty($texts)) {
                return;
            }

            $embeddings = $embeddingService->embedBatch($texts, 60);

            foreach ($embeddings as $i => $embedding) {
                if ($embedding === null) {
                    $failed++;
                    continue;
                }

                $db->table('nodes')
                    ->where('id', $ids[$i])
                    ->update(['embedding' => $embeddingService->toPgVector($embedding)]);

                $processed++;
            }

            // Small delay between batches to respect rate limits
            usleep(100_000); // 100ms
        });

        Log::info('Embedding generation complete', [
            'book'      => $this->bookId ?? 'all',
            'processed' => $processed,
            'failed'    => $failed,
        ]);
    }
}
