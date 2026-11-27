<?php

namespace App\Jobs;

use App\Services\SourceImport\Content\MarxistsWorkFetcher;
use App\Services\SourceImport\Identifier\MarxistsId;
use App\Services\SourceImport\Metadata\SourceMetadata;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * The fetch half of a marxists.org import (docs/marxists-import.md): crawl the
 * work's pages and stitch them into `original.epub`, then hand the book to
 * ProcessDocumentImportJob exactly as an uploaded EPUB would be.
 *
 * A job, not part of the request, because the crawl WAITS between pages — a
 * 47-page Capital is over a minute, which no web request should hold. It rides
 * the interactive import lane (a person is watching the progress card), and so
 * does the conversion it dispatches; the dispatcher sets the queue, never this
 * class (tests/Feature/Import/ImportQueuePriorityTest.php).
 */
class StitchMarxistsWorkJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 1;

    /** Under the import worker's 900s limit; the stitcher's own timeout is shorter still. */
    public int $timeout = 840;

    /**
     * @param  string  $path  the MarxistsId value (site path of the work's contents page)
     */
    public function __construct(
        public string $bookId,
        public string $path,
        public ?int $userId,
        public array $formData,
        public array $creatorInfo,
    ) {}

    public function handle(MarxistsWorkFetcher $fetcher): void
    {
        $dir = resource_path("markdown/{$this->bookId}");
        if (!File::exists($dir)) {
            File::makeDirectory($dir, 0755, true);
        }

        $id = new MarxistsId($this->path);
        $fetch = $fetcher->fetch($id, new SourceMetadata([], 'marxists'), $dir);

        if (!$fetch->ok) {
            Log::warning('marxists.org stitch failed', ['book' => $this->bookId, 'url' => $id->url(), 'reason' => $fetch->reason]);
            $this->writeProgress($dir, 'failed', 'fetch_failed', self::humanFailure($fetch->reason));

            return;
        }

        // Book, article or letter — read from the crawl just made (MarxistsWorkClassifier).
        try {
            app(\App\Services\Marxists\MarxistsCitation::class)->apply($this->bookId);
        } catch (\Throwable $e) {
            Log::warning('marxists.org classification failed (continuing)', ['book' => $this->bookId, 'error' => $e->getMessage()]);
        }

        $this->writeProgress($dir, 'queued', 'queued', 'Pages fetched — converting…', 40);

        ProcessDocumentImportJob::dispatch($this->bookId, $fetch->extension, $this->userId, $this->formData, $this->creatorInfo)
            ->onQueue(ProcessDocumentImportJob::QUEUE_INTERACTIVE);

        Log::info('marxists.org work stitched', ['book' => $this->bookId, 'url' => $id->url()]);
    }

    public function failed(\Throwable $e): void
    {
        $this->writeProgress(resource_path("markdown/{$this->bookId}"), 'failed', 'fetch_failed', self::humanFailure(null));
    }

    public static function humanFailure(?string $reason): string
    {
        return match ($reason) {
            'not_a_single_work' => 'That page lists several works. Import one work at a time, from its own contents page.',
            'too_many_pages'    => 'That work has more pages than one import can fetch.',
            'page_unavailable'  => 'marxists.org did not return that page.',
            'no_title'          => 'Could not find a title on that page.',
            default             => 'Could not fetch the work from marxists.org.',
        };
    }

    private function writeProgress(string $dir, string $status, string $stage, string $detail, int $percent = 0): void
    {
        try {
            File::put("{$dir}/progress.json", json_encode([
                'status'     => $status,
                'stage'      => $stage,
                'percent'    => $percent,
                'detail'     => $detail,
                'updated_at' => now()->toIso8601String(),
            ], JSON_PRETTY_PRINT));
        } catch (\Throwable) {
            // Progress is diagnostic only.
        }
    }
}
