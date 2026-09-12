<?php

namespace App\Services\Conversion;

use App\Jobs\ProcessDocumentImportJob;
use App\Services\Annotations\AnnotationSnapshotService;
use App\Services\Import\BookContentClearer;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * Queue ONE book for reconversion from the source already on disk.
 *
 * Extracted from ImportController::reconvert when the consoles grew a bulk button for the same
 * work, so there is one reconvert implementation and not two. The controller still owns
 * authorisation and the optional replace-the-file upload; everything from "which source file is
 * this" to "dispatch the job" lives here, because that is the part a bulk caller has to repeat
 * exactly — the annotation snapshot and the content clear in particular are not optional steps a
 * second implementation could reasonably skip.
 *
 * WHAT THIS COSTS: nothing, when the source is cached. A PDF book reconverts from
 * `ocr_response.json`, which `mistral_ocr.py` replays instead of calling the API; html/docx/epub
 * reconvert from their `original.*`. That is the whole point of the operation — re-run a FIXED
 * processor over an UNCHANGED input, so the only thing that changed is our code.
 *
 * …which is exactly why `$requireCachedSource` exists. A PDF book whose `ocr_response.json` has
 * gone misses the cache and the pipeline OCRs it again, for real money. One book at a time that is
 * a visible surprise; queued across a 900-article journal it is a silent four-figure one. Bulk
 * callers pass true and the book is refused with a reason instead.
 */
class BookReconverter
{
    /** Source files a reconvert can start from, in the order the pipeline prefers them. */
    private const SOURCE_EXTENSIONS = ['pdf', 'md', 'html', 'docx', 'epub', 'doc', 'odt', 'rtf'];

    /**
     * Outputs of a previous conversion. Deleted so a failed run cannot leave a half-new book
     * wearing the old run's footnotes.
     */
    private const STALE_OUTPUTS = [
        'footnotes.json', 'footnotes.jsonl', 'nodes.json', 'nodes.jsonl',
        'audit.json', 'references.json', 'intermediate.html', 'notify_email.json',
    ];

    /**
     * @param  bool  $requireCachedSource  refuse a PDF book with no OCR cache rather than re-OCR it
     * @return array{queued: bool, reason: ?string, source: ?string}
     */
    public function queue(
        string $book,
        ?int $userId,
        array $creatorInfo,
        bool $requireCachedSource = false,
    ): array {
        $path = resource_path("markdown/{$book}");

        [$sourceType, $inputFile] = $this->resolveSource($path);
        if (! $inputFile) {
            return ['queued' => false, 'reason' => 'no source file on disk to reconvert from', 'source' => null];
        }

        if ($requireCachedSource && $sourceType === 'pdf' && ! File::exists("{$path}/ocr_response.json")) {
            return [
                'queued' => false,
                'source' => $sourceType,
                // Named precisely, because the operator's next question is always "so what would
                // it have cost" — and the answer is "a fresh Mistral OCR of the whole PDF".
                'reason' => 'no cached OCR (ocr_response.json) — reconverting would re-run OCR and be charged',
            ];
        }

        // Stops a concurrent re-trigger from launching a SECOND conversion racing this one on the
        // same files and rows. Short TTL so a crash never permanently blocks the book.
        $lock = Cache::lock("reconvert:{$book}", 30);
        if (! $lock->get()) {
            return ['queued' => false, 'reason' => 'a conversion is already starting for this book', 'source' => $sourceType];
        }

        try {
            if ($inFlight = $this->inFlightReason($path)) {
                return ['queued' => false, 'reason' => $inFlight, 'source' => $sourceType];
            }

            foreach (self::STALE_OUTPUTS as $stale) {
                File::delete("{$path}/{$stale}");
            }

            // Snapshot annotation anchor text BEFORE clearing, so the import job can re-anchor
            // highlights and hypercites to the new nodes (AnnotationReattachmentService). A failed
            // snapshot must not abort the reconvert — losing anchors is better than losing the fix.
            try {
                app(AnnotationSnapshotService::class)->snapshot($book, DB::connection('pgsql_admin'));
            } catch (\Throwable $e) {
                Log::warning('Annotation snapshot failed (reconvert continues)', [
                    'book' => $book, 'error' => $e->getMessage(),
                ]);
            }

            // Via pgsql_admin: an ADMIN reconverting a book they do not own has no RLS right to the
            // owner's rows on the default connection, so the delete would silently no-op and the
            // old content would duplicate under the new import.
            app(BookContentClearer::class)->clear($book, DB::connection('pgsql_admin'));

            File::put("{$path}/progress.json", json_encode([
                'status'     => 'queued',
                'percent'    => 0,
                'stage'      => 'queued',
                'detail'     => 'Waiting to start...',
                'updated_at' => now()->toIso8601String(),
            ], JSON_PRETTY_PRINT));
        } finally {
            $lock->release();
        }

        ProcessDocumentImportJob::dispatch(
            $book,
            $sourceType,
            $userId,
            [],   // no metadata changes on reconvert; the job only fills empty fields
            $creatorInfo,
        );

        Log::info('Reconvert job dispatched', ['book' => $book, 'sourceType' => $sourceType]);

        return ['queued' => true, 'reason' => null, 'source' => $sourceType];
    }

    /** Does this book have a source a reconvert could reuse without spending anything? */
    public function hasCachedSource(string $book): bool
    {
        $path = resource_path("markdown/{$book}");
        [$sourceType, $inputFile] = $this->resolveSource($path);

        if (! $inputFile) {
            return false;
        }

        return $sourceType !== 'pdf' || File::exists("{$path}/ocr_response.json");
    }

    /** @return array{0: ?string, 1: ?string} [sourceType, inputFile] */
    private function resolveSource(string $path): array
    {
        foreach (self::SOURCE_EXTENSIONS as $ext) {
            if (File::exists("{$path}/original.{$ext}")) {
                return [$ext, "{$path}/original.{$ext}"];
            }
        }

        // A book imported from markdown keeps no `original.md`; its converted source IS main-text.md.
        if (File::exists("{$path}/main-text.md")) {
            return ['md', "{$path}/main-text.md"];
        }

        return [null, null];
    }

    /**
     * A conversion already running, per the book's own progress marker.
     *
     * Markers older than 30 minutes are ignored: a worker that died mid-conversion leaves one
     * behind forever, and treating that as in-flight would make the book permanently unreconvertable.
     */
    private function inFlightReason(string $path): ?string
    {
        $progressFile = "{$path}/progress.json";
        if (! File::exists($progressFile)) {
            return null;
        }

        $prev = json_decode(File::get($progressFile), true) ?: [];
        $prevAt = isset($prev['updated_at']) ? strtotime((string) $prev['updated_at']) : 0;
        $fresh = $prevAt && (time() - $prevAt) < 1800;

        return ($fresh && in_array($prev['status'] ?? '', ['queued', 'processing'], true))
            ? 'a conversion is already in progress for this book'
            : null;
    }
}
