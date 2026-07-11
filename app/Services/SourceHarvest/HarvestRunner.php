<?php

namespace App\Services\SourceHarvest;

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\AutoVersionCreator;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Executes one Source Network Harvester run: pop a {book, depth} entry off
 * the frontier, scan its bibliography (citation:scan-bibliography — the
 * command encapsulates the two-pass bibliography+footnote logic and its
 * results land in DB columns stage 2 reads), select the eligible open-access
 * canonicals most-cited-first under the run's work budget, and fetch+convert
 * each into an auto_version_book via AutoVersionCreator.
 *
 * Recursion-ready but dormant at max_depth 1: each newly assigned version
 * book would be pushed onto the frontier at depth+1 and get ITS bibliography
 * scanned on the next loop iteration. Idempotent re-runs: eligibility
 * excludes already-versioned canonicals and AutoVersionCreator wires
 * pointers from prior partial runs without fetching.
 *
 * All writes go through pgsql_admin (queue-worker RLS posture); the HTTP
 * controller's owner check is the authorization boundary.
 */
class HarvestRunner
{
    public function __construct(
        private AutoVersionCreator $creator,
        private HarvestEligibility $eligibility,
        private HarvestShelf $shelf,
    ) {
    }

    public function run(string $harvestId): void
    {
        $db = DB::connection('pgsql_admin');
        $harvest = $db->table('source_network_harvests')->where('id', $harvestId)->first();
        if (!$harvest) {
            throw new \RuntimeException("Harvest row not found: {$harvestId}");
        }

        $telemetry = new HarvestTelemetry($harvestId);

        $frontier = json_decode($harvest->frontier, true) ?: [];
        $visited = json_decode($harvest->visited_books, true) ?: [];
        $counts = array_merge([
            'eligible'          => 0,
            'attempted'         => 0,
            'assigned'          => 0,
            'assigned_existing' => 0,
            'fetch_failed'      => 0,
            'ocr_failed'        => 0,
            'deferred'          => 0,
            'errors'            => 0,
            'capped'            => 0,
        ], json_decode($harvest->counts, true) ?: []);

        $maxDepth = (int) $harvest->max_depth;
        $maxWorks = (int) $harvest->max_works;
        $sleep = (int) config('source_harvest.sleep_between_works', 2);

        $persist = function (array $extra = []) use ($db, $harvestId, &$frontier, &$visited, &$counts) {
            $db->table('source_network_harvests')->where('id', $harvestId)->update(array_merge([
                'frontier'      => json_encode(array_values($frontier)),
                'visited_books' => json_encode(array_values($visited)),
                'counts'        => json_encode($counts),
                'updated_at'    => now(),
            ], $extra));
        };

        $harvestedBooks = []; // assigned this run — collected onto the harvest shelf at the end

        while (($entry = array_shift($frontier)) !== null) {
            $book = $entry['book'] ?? null;
            $depth = (int) ($entry['depth'] ?? 0);
            if (!$book || in_array($book, $visited, true)) {
                continue;
            }
            $visited[] = $book;

            // ---- Stage 1: resolve this book's citations to canonicals ----
            $persist(['step' => 'scan', 'step_detail' => "Scanning bibliography (depth {$depth})"]);
            $telemetry->emit('scan', 'started', "Scanning bibliography of {$book} (depth {$depth})");

            $exit = Artisan::call('citation:scan-bibliography', ['target' => $book]);
            if ($exit !== 0) {
                $telemetry->emit('scan', 'failed', "citation:scan-bibliography exited {$exit}");
                throw new \RuntimeException("citation:scan-bibliography exited {$exit} for {$book}");
            }
            $telemetry->emit('scan', 'completed');

            // ---- Stage 2: pick eligible canonicals under the remaining budget ----
            $persist(['step' => 'select', 'step_detail' => 'Choosing fetchable open-access works']);
            $telemetry->emit('select', 'started', 'Choosing fetchable open-access works');

            $budget = $maxWorks - $counts['attempted'];
            if ($budget <= 0) {
                $counts['capped']++;
                $telemetry->emit('select', 'skipped', 'work budget exhausted before this book');
                $persist();
                continue;
            }

            $eligible = $this->eligibility->eligibleCanonicalsFor($book);
            $counts['eligible'] += $eligible->count();

            if ($eligible->count() > $budget) {
                // Most-cited-first ordering means the cap drops the tail.
                $counts['capped'] += $eligible->count() - $budget;
                $telemetry->emit('select', 'progress', ($eligible->count() - $budget) . ' eligible works over budget, dropped');
                $eligible = $eligible->take($budget);
            }

            $telemetry->emit('select', 'completed', "{$eligible->count()} works selected", [
                'eligible' => $eligible->count(),
                'capped'   => $counts['capped'],
            ]);

            $telemetry->emit('harvest', 'started', "{$eligible->count()} eligible open-access works", [
                'eligible' => $eligible->count(),
            ]);

            // ---- Stage 3: fetch + convert each work ----
            foreach ($eligible->values() as $i => $row) {
                $label = ($i + 1) . '/' . $eligible->count() . ': ' . mb_substr($row->title ?? '(untitled)', 0, 60);
                $persist(['step' => 'harvest', 'step_detail' => "Importing work {$label}"]);

                $counts['attempted']++;

                try {
                    $canonical = CanonicalSource::find($row->id);
                    if (!$canonical) {
                        throw new \RuntimeException('canonical row vanished mid-run');
                    }

                    $result = $this->creator->create($canonical);
                    $status = $result['status'];

                    $counts[$status === 'error' ? 'errors' : $status] =
                        ($counts[$status === 'error' ? 'errors' : $status] ?? 0) + 1;

                    $telemetry->emit(
                        'harvest',
                        in_array($status, ['assigned', 'assigned_existing'], true) ? 'progress' : 'skipped',
                        "{$label} — {$status}" . ($result['reason'] ? " ({$result['reason']})" : ''),
                        array_filter(['lane' => $result['lane']])
                    );

                    if (in_array($status, ['assigned', 'assigned_existing'], true) && $result['book']) {
                        $harvestedBooks[] = $result['book'];
                    }

                    // Recursion: at max_depth > 1 (user picks the depth at
                    // trigger time, up to "unlimited") the new version book's
                    // own bibliography becomes the next frontier level, so the
                    // harvest follows the citation network outward. visited
                    // guards cycles; the work budget bounds the total.
                    if (
                        in_array($status, ['assigned', 'assigned_existing'], true)
                        && $result['book']
                        && $depth + 1 < $maxDepth
                        && !in_array($result['book'], $visited, true)
                    ) {
                        $frontier[] = ['book' => $result['book'], 'depth' => $depth + 1];
                    }
                } catch (\Throwable $e) {
                    // One bad PDF must never kill the run.
                    $counts['errors']++;
                    $telemetry->emit('harvest', 'skipped', "{$label} — error ({$e->getMessage()})");
                    Log::warning('Harvest work failed', [
                        'harvest'   => $harvestId,
                        'canonical' => $row->id,
                        'error'     => $e->getMessage(),
                    ]);
                }

                $persist();

                if ($sleep > 0 && $i < $eligible->count() - 1) {
                    sleep($sleep);
                }
            }

            $telemetry->emit('harvest', 'completed', null, [
                'assigned' => $counts['assigned'] + $counts['assigned_existing'],
                'attempted' => $counts['attempted'],
            ]);
            $persist();
        }

        // ---- Shelf: collect this run's sources onto the harvest shelf.
        // Runs when anything was assigned this run, or a shelf from a prior
        // run already exists (keeps the pointer fresh on continue-runs).
        if (!empty($harvestedBooks) || !empty($harvest->shelf_id)) {
            $persist(['step' => 'shelf', 'step_detail' => 'Collecting sources onto your shelf']);
            $telemetry->emit('shelf', 'started', 'Collecting sources onto your shelf');
            try {
                $shelfInfo = $this->shelf->ensureShelfFor($harvest->root_book);
                if ($shelfInfo) {
                    $this->shelf->addBooks($shelfInfo->id, $harvestedBooks);
                    $db->table('source_network_harvests')
                        ->where('id', $harvestId)
                        ->update(['shelf_id' => $shelfInfo->id, 'updated_at' => now()]);
                    $telemetry->emit('shelf', 'completed', count($harvestedBooks) . " source(s) on \"{$shelfInfo->name}\"", [
                        'books' => count($harvestedBooks),
                    ]);
                } else {
                    $telemetry->emit('shelf', 'skipped', 'no shelf owner resolvable for the root book');
                }
            } catch (\Throwable $e) {
                // A shelf failure must never fail the harvest itself.
                $telemetry->emit('shelf', 'failed', $e->getMessage());
                Log::warning('Harvest shelf step failed', [
                    'harvest' => $harvestId,
                    'error'   => $e->getMessage(),
                ]);
            }
        } else {
            // Nothing to shelve (no sources imported, no prior shelf). Emit a
            // terminal 'skipped' so the viz shows the stage as done-skipped
            // rather than leaving it stuck at 'pending' after the run finishes.
            $telemetry->emit('shelf', 'skipped', 'no new sources to collect');
        }

        // Bump annotations_updated_at so the frontend re-syncs bibliography
        // records (new canonical links) on next load — same trigger the
        // citation pipeline uses.
        $db->table('library')
            ->where('book', $harvest->root_book)
            ->update(['annotations_updated_at' => round(microtime(true) * 1000)]);

        $persist(['step' => null, 'step_detail' => null]);
    }
}
