<?php

namespace App\Services\DocumentImport;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * How many conversion jobs sit ahead of a queued import.
 *
 * The import worker (queue "default", numprocs=1) is strictly serial across
 * ALL users, so a queued book's place in line is simply the number of jobs
 * rows with a lower id that are still in the table — including the reserved
 * (currently running) one. Job rows are matched by payload LIKE, the same
 * technique as CitationDoctorCommand; the jobs table stays tiny with a serial
 * worker, so the scan is cheap, and results are cached briefly because both
 * the per-book poll and the aggregate endpoint call this every couple of
 * seconds.
 */
class ImportQueuePosition
{
    /**
     * Jobs ahead of this book's conversion job, or null when the book has no
     * job row on the default queue (already running jobs keep their row, so
     * null usually means "finished or never dispatched").
     */
    public static function jobsAhead(string $bookId): ?int
    {
        return Cache::remember("import-queue-pos:{$bookId}", 10, function () use ($bookId) {
            // bookId is sanitized to [a-zA-Z0-9_-] by callers, but `_` is a
            // LIKE single-char wildcard — escape it so book_1 can't match book91.
            $needle = addcslashes($bookId, '%_\\');

            $row = DB::table('jobs')
                ->where('queue', 'default')
                ->where('payload', 'like', "%{$needle}%")
                ->orderBy('id')
                ->first(['id', 'reserved_at']);

            if (!$row) {
                return null;
            }

            return DB::table('jobs')
                ->where('queue', 'default')
                ->where('id', '<', $row->id)
                ->count();
        });
    }
}
