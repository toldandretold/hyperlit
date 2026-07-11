<?php

namespace App\Services\SourceHarvest;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Append-only event stream for one harvest run, persisted on
 * source_network_harvests.telemetry (JSONB) — same capped read-append-write
 * pattern as CitationPipeline\PipelineTelemetry.
 *
 * Deliberately a sibling of PipelineTelemetry, NOT a merge into it: the
 * citation pipeline's PipelineMap + PipelineMapDriftTest contract hard-codes
 * its four-stage chain and a harvest is a different lifecycle (frontier,
 * depth, work budget). Do not "helpfully" unify them.
 *
 * Best-effort by design: telemetry must never break the harvest.
 */
final class HarvestTelemetry
{
    /** Hard cap so a pathological loop can't bloat the row. */
    public const MAX_EVENTS = 400;

    public function __construct(private ?string $harvestId)
    {
    }

    public function emit(string $stage, string $status, ?string $detail = null, array $signals = []): void
    {
        if (!$this->harvestId) {
            return;
        }

        try {
            $events = $this->load();

            $events[] = array_filter([
                'stage'   => $stage,
                'status'  => $status,
                'detail'  => $detail,
                'signals' => $signals ?: null,
                'at'      => now()->toDateTimeString(),
            ], fn ($v) => $v !== null);

            if (count($events) > self::MAX_EVENTS) {
                // Keep the head (run setup) and the freshest tail.
                $events = array_merge(
                    array_slice($events, 0, 50),
                    [['stage' => $stage, 'status' => 'progress', 'detail' => '… earlier events trimmed …', 'at' => now()->toDateTimeString()]],
                    array_slice($events, -(self::MAX_EVENTS - 51)),
                );
            }

            DB::connection('pgsql_admin')
                ->table('source_network_harvests')
                ->where('id', $this->harvestId)
                ->update([
                    'telemetry'  => json_encode($events),
                    'updated_at' => now(),
                ]);
        } catch (\Throwable $e) {
            Log::warning('Harvest telemetry emit failed (harvest unaffected)', [
                'harvest' => $this->harvestId,
                'stage'   => $stage,
                'error'   => $e->getMessage(),
            ]);
        }
    }

    /** Current event stream from the DB (empty when none yet). */
    private function load(): array
    {
        $raw = DB::connection('pgsql_admin')
            ->table('source_network_harvests')
            ->where('id', $this->harvestId)
            ->value('telemetry');

        return $raw ? (json_decode($raw, true) ?: []) : [];
    }
}
