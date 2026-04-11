<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class QueueBookEmbeddings implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 2;
    public int $backoff = 60;

    public function __construct(
        private string $bookId,
    ) {}

    public function handle(): void
    {
        // Only embed nodes from public, non-sub-book library records
        $library = DB::table('library')
            ->where('book', $this->bookId)
            ->first();

        if (!$library || $library->visibility !== 'public' || $library->type === 'sub_book') {
            return;
        }

        // Find all nodes in this book that have plainText but no embedding
        $nodeIds = DB::table('nodes')
            ->where('book', $this->bookId)
            ->whereNull('embedding')
            ->whereNotNull('plainText')
            ->whereRaw("LENGTH(TRIM(\"plainText\")) >= 20")
            ->pluck('id');

        if ($nodeIds->isEmpty()) {
            return;
        }

        Log::info('QueueBookEmbeddings: dispatching embedding jobs', [
            'book' => $this->bookId,
            'count' => $nodeIds->count(),
        ]);

        foreach ($nodeIds as $nodeId) {
            GenerateNodeEmbedding::dispatch($nodeId);
        }
    }
}
