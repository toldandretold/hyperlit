<?php

namespace App\Jobs;

use App\Services\Marxists\MarxistsBulkImporter;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;

/**
 * One work of the marxists.org BULK import (docs/marxists-import.md): crawl, stitch, mint the
 * system-owned book and queue its conversion — MarxistsBulkImporter::importWork.
 *
 * A mass backend fan-out, so `marxists:import` dispatches it on `default` and the conversion it
 * queues stays there too; the interactive `imports` lane is for a person waiting on one import
 * (tests/Feature/Import/ImportQueuePriorityTest.php).
 */
class ImportMarxistsWorkJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 1;

    /** Under the import worker's 900s limit. */
    public int $timeout = 840;

    public function __construct(public int $workId)
    {
    }

    public function handle(MarxistsBulkImporter $importer): void
    {
        $importer->importWork($this->workId);
    }

    public function failed(\Throwable $e): void
    {
        DB::connection('pgsql_admin')->table('marxists_works')
            ->where('id', $this->workId)->where('status', MarxistsBulkImporter::STATUS_QUEUED)
            ->update(['status' => MarxistsBulkImporter::STATUS_FAILED, 'reason' => mb_substr($e->getMessage(), 0, 500), 'updated_at' => now()]);
    }
}
