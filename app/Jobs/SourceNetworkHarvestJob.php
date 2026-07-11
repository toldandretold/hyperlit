<?php

namespace App\Jobs;

use App\Services\SourceHarvest\HarvestRunner;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Source Network Harvester orchestrator: one job per run, driving
 * HarvestRunner over the harvest row's frontier. Deliberately a single
 * sequential job rather than a per-work fan-out — sequential fetching with
 * politeness sleeps is the model every existing acquisition flow uses
 * against rate-limited external services, and the per-work try/catch in the
 * runner already isolates failures.
 *
 * tries = 1: a crashed run leaves the row 'running' until the controller's
 * stale watchdog fails it; re-triggering is cheap and idempotent (eligibility
 * excludes already-versioned canonicals, pointers wire from partial runs),
 * so an explicit user re-trigger beats automatic retries against
 * rate-limited publishers.
 */
class SourceNetworkHarvestJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 7200; // fetch + OCR across dozens of works is slow
    public int $tries = 1;

    public function __construct(private string $harvestId)
    {
        $this->onQueue('citation-pipeline');
    }

    public function handle(HarvestRunner $runner): void
    {
        Log::info('SourceNetworkHarvestJob starting', ['harvest' => $this->harvestId]);

        DB::connection('pgsql_admin')
            ->table('source_network_harvests')
            ->where('id', $this->harvestId)
            ->update(['status' => 'running', 'error' => null, 'updated_at' => now()]);

        $runner->run($this->harvestId);

        DB::connection('pgsql_admin')
            ->table('source_network_harvests')
            ->where('id', $this->harvestId)
            ->update(['status' => 'completed', 'updated_at' => now()]);

        Log::info('SourceNetworkHarvestJob completed', ['harvest' => $this->harvestId]);
    }

    public function failed(\Throwable $e): void
    {
        Log::error('SourceNetworkHarvestJob failed', [
            'harvest' => $this->harvestId,
            'error'   => $e->getMessage(),
        ]);

        DB::connection('pgsql_admin')
            ->table('source_network_harvests')
            ->where('id', $this->harvestId)
            ->update([
                'status'     => 'failed',
                'error'      => $e->getMessage(),
                'updated_at' => now(),
            ]);
    }
}
