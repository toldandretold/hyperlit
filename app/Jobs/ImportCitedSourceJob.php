<?php

namespace App\Jobs;

use App\Models\CanonicalSource;
use App\Models\User;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\Hypercites\CitedWorksQuery;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceHarvest\WorkOcrCharger;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Import ONE most-cited external source from the /maintainer/hypercites console
 * so future detections can match quotes against it. The whole existing
 * acquisition ladder applies (AutoVersionCreator → ContentFetchService →
 * OCR/JATS/HTML), and OCR is charged to the admin who pressed the button —
 * per successful NEW import only, exactly as journal-import bills its runs.
 *
 * A landed book (new OR already minted) is also collected onto the scope's
 * public "Cited by: <label>" shelf — the same shelf ImportCitedBulkJob fills —
 * so single imports show up in /maintainer/shelf-import alongside bulk ones.
 */
class ImportCitedSourceJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600;
    public int $tries = 1;

    public function __construct(private string $runId)
    {
        $this->onQueue('citation-pipeline');
    }

    public function handle(AutoVersionCreator $creator, WorkOcrCharger $charger, HarvestShelf $shelves): void
    {
        $db = DB::connection('pgsql_admin');
        $run = $db->table('hypercite_runs')->where('id', $this->runId)->first();
        if (! $run) {
            Log::warning('ImportCitedSourceJob: run row vanished', ['run' => $this->runId]);

            return;
        }

        $this->mark(['status' => 'running', 'error' => null, 'step_detail' => 'fetching + converting']);

        try {
            $canonical = CanonicalSource::find($run->canonical_source_id);
            if (! $canonical) {
                throw new \RuntimeException('canonical row not found');
            }

            $scope = CitedWorksQuery::scopeFromRun($run);

            $result = $creator->create($canonical, false);
            $status = $result['status'] ?? 'error';

            if ($status === 'assigned' && $run->user_id) {
                $user = User::on('pgsql_admin')->find($run->user_id);
                if ($user && ! empty($result['book'])) {
                    $charger->charge($user, $result['book'], 'Cited-source import OCR (' . ($scope['label'] ?? '?') . "): {$result['book']}");
                }
            }

            if ($scope && in_array($status, ['assigned', 'assigned_existing'], true) && ! empty($result['book'])) {
                $shelf = $shelves->ensureCitedShelfFor($scope['label']);
                $shelves->addBooks($shelf->id, [$result['book']]);
            }

            $this->mark([
                'status'      => in_array($status, ['assigned', 'assigned_existing'], true) ? 'completed' : 'failed',
                'counts'      => json_encode($result),
                'step_detail' => "import {$status}" . (! empty($result['book']) ? " → {$result['book']}" : ''),
                'error'       => in_array($status, ['assigned', 'assigned_existing'], true)
                    ? null
                    : ($result['reason'] ?? $status),
            ]);
        } catch (\Throwable $e) {
            Log::error('ImportCitedSourceJob failed', ['run' => $this->runId, 'error' => $e->getMessage()]);
            $this->mark(['status' => 'failed', 'error' => mb_substr($e->getMessage(), 0, 500)]);
        }
    }

    private function mark(array $fields): void
    {
        DB::connection('pgsql_admin')->table('hypercite_runs')
            ->where('id', $this->runId)
            ->update($fields + ['updated_at' => now()]);
    }
}
