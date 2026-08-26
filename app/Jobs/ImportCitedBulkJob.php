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
 * Import the most-cited external OA works of a hypercite-console scope in one
 * press — the bulk sibling of ImportCitedSourceJob, collecting every book it
 * lands (new or already minted) onto the scope's public "Cited by: <label>"
 * shelf so the imports can be assessed together in /maintainer/shelf-import
 * before a re-detect matches against them.
 *
 * The work-list is CitedWorksQuery::importableExternal — exactly the rows the
 * most-cited tab shows with an import button, in the same order. `held` flips
 * true as imports land, so pressing again naturally continues down the list
 * rather than repeating it.
 *
 * Same acquisition + billing rules as everywhere else: AutoVersionCreator's
 * full ladder per work; OCR charged to the pressing admin per successful NEW
 * import only (`assigned`, never `assigned_existing`); per-work sleep because
 * this may hit the same publisher repeatedly.
 */
class ImportCitedBulkJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600;
    public int $tries = 1;

    /**
     * How long the loop may keep taking new work — comfortably inside
     * `$timeout` so it exits and REPORTS rather than being killed mid-work,
     * and `$timeout` stays under the queue's retry_after. Same rationale and
     * value as JournalImportActionJob.
     */
    private const WORK_BUDGET = 3000;

    /** Bounded per-work failure list on the run row (same cap as journal-import). */
    private const MAX_REPORTED_FAILURES = 100;

    public function __construct(private string $runId)
    {
        $this->onQueue('citation-pipeline');
    }

    public function handle(
        AutoVersionCreator $creator,
        WorkOcrCharger $charger,
        HarvestShelf $shelves,
        CitedWorksQuery $cited,
    ): void {
        $db = DB::connection('pgsql_admin');
        $run = $db->table('hypercite_runs')->where('id', $this->runId)->first();
        if (! $run) {
            Log::warning('ImportCitedBulkJob: run row vanished', ['run' => $this->runId]);

            return;
        }

        $this->mark(['status' => 'running', 'error' => null, 'step_detail' => 'listing importable works']);

        try {
            $scope = CitedWorksQuery::scopeFromRun($run);
            if (! $scope) {
                throw new \RuntimeException('run has no resolvable scope');
            }

            // Shelf first, so a run that dies partway has still collected what
            // it managed, and the page can link to the console immediately.
            $shelf = $shelves->ensureCitedShelfFor($scope['label']);
            $counts = ['shelf' => ['id' => $shelf->id, 'name' => $shelf->name, 'slug' => $shelf->slug]];
            $this->mark(['counts' => json_encode($counts)]);

            $works = $cited->importableExternal($scope);
            $limit = (int) ($run->work_limit ?? 0);
            if ($limit > 0) {
                $works = $works->take($limit);
            }

            $payer = $run->user_id ? User::on('pgsql_admin')->find($run->user_id) : null;
            $total = $works->count();
            $stats = ['requested' => $total, 'attempted' => 0, 'imported' => 0, 'already_held' => 0, 'failed' => 0];
            $failures = [];
            $stoppedEarly = false;
            $deadline = time() + self::WORK_BUDGET;

            foreach ($works as $i => $work) {
                if (time() >= $deadline) {
                    $stoppedEarly = true;
                    break;
                }

                $n = $i + 1;
                $title = (string) ($work['title'] ?? '(untitled)');
                $this->mark(['step_detail' => "import {$n}/{$total}: {$title}"]);
                $stats['attempted']++;

                try {
                    $canonical = CanonicalSource::find($work['canonical_id']);
                    if (! $canonical) {
                        throw new \RuntimeException('canonical row vanished');
                    }

                    $result = $creator->create($canonical, false);
                    $status = $result['status'] ?? 'error';

                    if ($status === 'assigned' && $payer && ! empty($result['book'])) {
                        $charger->charge($payer, $result['book'], "Cited-source bulk import OCR ({$scope['label']}): {$result['book']}");
                    }

                    if (in_array($status, ['assigned', 'assigned_existing'], true) && ! empty($result['book'])) {
                        // Per-work, not batched at the end: an aborted run keeps its gains.
                        $shelves->addBooks($shelf->id, [$result['book']]);
                        $stats[$status === 'assigned' ? 'imported' : 'already_held']++;
                    } else {
                        $stats['failed']++;
                        if (count($failures) < self::MAX_REPORTED_FAILURES) {
                            $failures[] = [
                                'title'        => $title,
                                'canonical_id' => $work['canonical_id'],
                                'status'       => $status,
                                'reason'       => $result['reason'] ?? null,
                            ];
                        }
                    }
                } catch (\Throwable $e) {
                    $stats['failed']++;
                    if (count($failures) < self::MAX_REPORTED_FAILURES) {
                        $failures[] = [
                            'title'        => $title,
                            'canonical_id' => $work['canonical_id'],
                            'status'       => 'error',
                            'reason'       => mb_substr($e->getMessage(), 0, 300),
                        ];
                    }
                }

                sleep((int) config('services.source_fetch.work_sleep_seconds', 2));
            }

            // Re-measured, not derived: `held` has flipped under us, so this is
            // the number the NEXT press would attempt.
            $remaining = $cited->importableExternal($scope)->count();

            $counts += $stats + [
                'failures'      => $failures,
                'stopped_early' => $stoppedEarly,
                'remaining'     => $remaining,
            ];
            $counts['summary'] = "{$stats['imported']} imported, {$stats['already_held']} already held, "
                . "{$stats['failed']} failed, {$remaining} still importable"
                . ($stoppedEarly ? ' — stopped at the time limit, press again to continue' : '');

            $this->mark([
                'status'      => 'completed',
                'counts'      => json_encode($counts),
                'step_detail' => $counts['summary'],
            ]);
        } catch (\Throwable $e) {
            Log::error('ImportCitedBulkJob failed', ['run' => $this->runId, 'error' => $e->getMessage()]);
            $this->mark(['status' => 'failed', 'error' => mb_substr($e->getMessage(), 0, 500)]);
        }
    }

    private function mark(array $fields): void
    {
        DB::connection('pgsql_admin')->table('hypercite_runs')
            ->where('id', $this->runId)
            ->update($fields + ['updated_at' => now()]);
    }

    public function failed(\Throwable $e): void
    {
        $this->mark(['status' => 'failed', 'error' => mb_substr($e->getMessage(), 0, 500)]);
    }
}
