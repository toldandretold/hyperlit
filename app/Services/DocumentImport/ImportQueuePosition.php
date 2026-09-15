<?php

namespace App\Services\DocumentImport;

use App\Jobs\ProcessDocumentImportJob;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * How many conversion jobs sit ahead of a queued import.
 *
 * The import worker (numprocs=1) is strictly serial, but it now serves TWO
 * lanes in priority order — `--queue=imports,default`. User-initiated imports
 * ride `imports` and preempt everything on `default` (mass reconvert-all /
 * ar5iv fan-outs), so "ahead of me" depends on which lane the job is in:
 *
 *   - on `imports`: earlier `imports` rows + the ONE `default` job the worker
 *     may be running right now (reserved). Queued default jobs do NOT count —
 *     the worker won't touch them while an imports job waits.
 *   - on `default`: earlier `default` rows + EVERY `imports` row, queued or
 *     running — they all jump ahead.
 *
 * Job rows are matched by payload LIKE, the same technique as
 * CitationDoctorCommand; results are cached briefly because both the per-book
 * poll and the aggregate endpoint call this every couple of seconds.
 */
class ImportQueuePosition
{
    /**
     * Jobs ahead of this book's conversion job, or null when the book has no
     * job row on either import lane (already running jobs keep their row, so
     * null usually means "finished or never dispatched").
     */
    public static function jobsAhead(string $bookId): ?int
    {
        return Cache::remember("import-queue-pos:{$bookId}", 10, function () use ($bookId) {
            $interactive = ProcessDocumentImportJob::QUEUE_INTERACTIVE;

            // bookId is sanitized to [a-zA-Z0-9_-] by callers, but `_` is a
            // LIKE single-char wildcard — escape it so book_1 can't match book91.
            $needle = addcslashes($bookId, '%_\\');

            $row = DB::table('jobs')
                ->whereIn('queue', [$interactive, 'default'])
                ->where('payload', 'like', "%{$needle}%")
                ->orderBy('id')
                ->first(['id', 'queue']);

            if (!$row) {
                return null;
            }

            if ($row->queue === $interactive) {
                return DB::table('jobs')
                    ->where('queue', $interactive)
                    ->where('id', '<', $row->id)
                    ->count()
                    + DB::table('jobs')
                        ->where('queue', 'default')
                        ->whereNotNull('reserved_at')
                        ->count();
            }

            return DB::table('jobs')
                ->where('queue', 'default')
                ->where('id', '<', $row->id)
                ->count()
                + DB::table('jobs')
                    ->where('queue', $interactive)
                    ->count();
        });
    }
}
