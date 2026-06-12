<?php

namespace App\Jobs;

use App\Services\EmbeddingService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class GenerateNodeEmbedding implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;
    public int $backoff = 30;

    public function __construct(
        private int $nodeId,
    ) {
        // Run on a dedicated queue so bulk embedding generation (one job per node —
        // thousands for a large book) can never sit in front of interactive
        // imports/reconverts on the 'default' queue. Workers process
        // 'default,embeddings' in priority order, so conversions always run first
        // and embeddings fill idle time. Mirrors the citation-pipeline jobs.
        $this->onQueue('embeddings');
    }

    public function handle(EmbeddingService $embeddingService): void
    {
        // pgsql_admin (BYPASSRLS) throughout: queue workers have no RLS session
        // context, so on the default connection PRIVATE books' nodes/library rows
        // are invisible — this job silently no-op'd for every private book (found
        // 2026-06-12: 0 of 1.5M private-book nodes embedded vs 27k public). The
        // UPDATE must be admin too, or the write itself is RLS-blocked.
        $admin = DB::connection('pgsql_admin');

        $node = $admin->table('nodes')->where('id', $this->nodeId)->first();

        if (!$node || empty($node->plainText)) {
            return;
        }

        // Skip very short text (not useful for embedding)
        if (strlen(trim($node->plainText)) < 20) {
            return;
        }

        // Skip sub-books (their content belongs to the parent)
        $library = $admin->table('library')
            ->where('book', $node->book)
            ->first();

        if (!$library || $library->type === 'sub_book') {
            return;
        }

        $embedding = $embeddingService->embed($node->plainText);

        if ($embedding) {
            $vectorStr = '[' . implode(',', $embedding) . ']';
            $admin->table('nodes')
                ->where('id', $this->nodeId)
                ->update(['embedding' => DB::raw("'{$vectorStr}'::vector")]);
        }
    }
}
