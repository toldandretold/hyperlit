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
    ) {}

    public function handle(EmbeddingService $embeddingService): void
    {
        $node = DB::table('nodes')->where('id', $this->nodeId)->first();

        if (!$node || empty($node->plainText)) {
            return;
        }

        // Skip very short text (not useful for embedding)
        if (strlen(trim($node->plainText)) < 20) {
            return;
        }

        // Skip sub-books (their content belongs to the parent)
        $library = DB::table('library')
            ->where('book', $node->book)
            ->first();

        if (!$library || $library->type === 'sub_book') {
            return;
        }

        $embedding = $embeddingService->embed($node->plainText);

        if ($embedding) {
            $vectorStr = '[' . implode(',', $embedding) . ']';
            DB::table('nodes')
                ->where('id', $this->nodeId)
                ->update(['embedding' => DB::raw("'{$vectorStr}'::vector")]);
        }
    }
}
