<?php

namespace App\Services\CitationPipeline;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Append-only event stream for one citation pipeline run, persisted on
 * citation_pipelines.telemetry (JSONB) so the frontend's status polling can
 * drive the live visualisation — and so a finished run leaves a reviewable
 * trace of what actually happened ("review the review").
 *
 * Event shape: {stage, substage, status, detail, signals, at}
 *   status: started | progress | completed | failed | skipped
 *   signals: free-form counts the stage wants to surface (e.g. {resolved: 12})
 *
 * Best-effort by design: telemetry must never break the pipeline. A null
 * pipelineId (plain CLI run, no tracking) makes every emit a no-op.
 */
final class PipelineTelemetry
{
    /** Hard cap so a pathological loop can't bloat the row. */
    public const MAX_EVENTS = 400;

    public function __construct(private ?string $pipelineId) {}

    public function emit(string $stage, string $status, ?string $detail = null, array $signals = [], ?string $substage = null): void
    {
        if (!$this->pipelineId) {
            return;
        }

        try {
            // Read-append-write on EVERY emit — no in-memory cache. Several
            // emitter instances share one stream (the pipeline command and the
            // review command run in the same process; queue retries reuse it),
            // and a cached copy here would clobber events the other appended.
            $events = $this->load();

            $events[] = array_filter([
                'stage'    => $stage,
                'substage' => $substage,
                'status'   => $status,
                'detail'   => $detail,
                'signals'  => $signals ?: null,
                'at'       => now()->toDateTimeString(),
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
                ->table('citation_pipelines')
                ->where('id', $this->pipelineId)
                ->update([
                    'telemetry'  => json_encode($events),
                    'updated_at' => now(),
                ]);
        } catch (\Throwable $e) {
            Log::warning('Pipeline telemetry emit failed (pipeline unaffected)', [
                'pipeline' => $this->pipelineId,
                'stage'    => $stage,
                'error'    => $e->getMessage(),
            ]);
        }
    }

    /** Current event stream from the DB (empty when none yet). */
    private function load(): array
    {
        $raw = DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $this->pipelineId)
            ->value('telemetry');

        return $raw ? (json_decode($raw, true) ?: []) : [];
    }
}
