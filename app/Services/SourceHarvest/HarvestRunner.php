<?php

namespace App\Services\SourceHarvest;

use App\Models\CanonicalSource;
use App\Models\User;
use App\Services\BillingService;
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
 * SLICED EXECUTION: run() works until the frontier drains OR the slice budget
 * (source_harvest.slice_seconds) elapses, then persists a bookmark — the
 * remaining frontier, with the current book's un-attempted works parked as a
 * `resume_ids` entry at the front — and returns 'sliced'. The job re-dispatches
 * itself, so an arbitrarily long harvest is a chain of short queue jobs; only
 * the LAST slice finalizes (shelf + yield report). finalize() rebuilds wholly
 * from the row's persisted state, so the job's failed() hook can also ship a
 * partial-marked report after a crash.
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
        private YieldReportBook $report,
    ) {
    }

    /** @return string outcome: 'completed' | 'cancelled' (terminal) | 'sliced' (re-dispatch to continue) */
    public function run(string $harvestId): string
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
            'eligible'            => 0,
            'attempted'           => 0,
            'assigned'            => 0,
            'assigned_existing'   => 0,
            'fetch_failed'        => 0,
            'ocr_failed'          => 0,
            'deferred'            => 0,
            'errors'              => 0,
            'capped'              => 0,
            'skipped_over_budget' => 0,
            'spend'               => 0,
        ], json_decode($harvest->counts, true) ?: []);

        $maxDepth = (int) $harvest->max_depth;
        $maxWorks = (int) $harvest->max_works;
        $sleep = (int) config('source_harvest.sleep_between_works', 2);

        // Slice budget — see the class docblock. $didWork is the progress
        // guard: a slice may only end after at least one unit of real work
        // (a bibliography scan or a work attempt), so the slice chain always
        // advances even when a single unit outruns the deadline.
        $sliceSeconds = (float) config('source_harvest.slice_seconds', 900);
        $sliceDeadline = $sliceSeconds > 0 ? microtime(true) + $sliceSeconds : null;
        $didWork = false;
        $sliced = false;
        $sliceDue = function () use ($sliceDeadline, &$didWork): bool {
            return $sliceDeadline !== null && $didWork && microtime(true) >= $sliceDeadline;
        };

        // Billing: the harvest owner pays per-work OCR (pay-as-you-go) up to an
        // optional max_spend cap. Load the owner via the admin connection (the
        // worker has no HTTP session); a null owner (anonymous harvest) is never
        // billed and has no cap. `$spend` is the running total of dollars
        // actually charged this run — the cap check and the completion display
        // read it; it's derivable from billing_ledger, so it's not persisted.
        $user = $harvest->user_id ? User::on('pgsql_admin')->find($harvest->user_id) : null;
        $maxSpend = $harvest->max_spend !== null ? (float) $harvest->max_spend : null;
        $spend = (float) ($counts['spend'] ?? 0);

        // Canonical metadata for a results row (success/error/skipped all share it).
        $metaFromRow = fn ($row) => [
            'canonical_source_id' => $row->id,
            'title'       => $row->title ?? null,
            'author'      => $row->author ?? null,
            'year'        => $row->year ?? null,
            'journal'     => $row->journal ?? null,
            'publisher'   => $row->publisher ?? null,
            'type'        => $row->type ?? null,
            'doi'         => $row->doi ?? null,
            'openalex_id' => $row->openalex_id ?? null,
            'oa_url'      => $row->oa_url ?? null,
            'pdf_url'     => $row->pdf_url ?? null,
            // For the yield report's network viz (node sizing) — on every
            // eligible row because eligibility selects cs.*.
            'cited_by_count' => $row->cited_by_count ?? null,
        ];

        // Stop-condition probe, checked at each work boundary. Returns a reason
        // ('cancelled' | 'finished' | 'over_budget') or null. cancel and finish
        // both stop gracefully and still finalize — the difference is the
        // stamped outcome: finish is a deliberately shortened run ('completed'),
        // cancel is abandoned ('cancelled'). Premium owners have no spend
        // ceiling (they aren't per-use billed) — only the stop flags stop them.
        $shouldStop = function () use ($db, $harvestId, $user, $maxSpend, &$spend): ?string {
            $flags = $db->table('source_network_harvests')->where('id', $harvestId)
                ->select(['cancel_requested', 'finish_requested'])->first();
            if ($flags?->cancel_requested) {
                return 'cancelled';
            }
            if ($flags?->finish_requested) {
                return 'finished';
            }
            if ($user && $user->status !== 'premium') {
                if ($maxSpend !== null && $spend >= $maxSpend) {
                    return 'over_budget';
                }
                $user->refresh();
                if (!app(BillingService::class)->canProceed($user)) {
                    return 'over_budget';
                }
            }
            return null;
        };

        $stopReason = null;

        // Per-work outcomes (canonical metadata + result) for the Source Yield
        // Report. Uncapped (unlike telemetry) — we want every failure.
        $results = json_decode($harvest->results ?? '[]', true) ?: [];

        $persist = function (array $extra = []) use ($db, $harvestId, &$frontier, &$visited, &$counts, &$results) {
            $db->table('source_network_harvests')->where('id', $harvestId)->update(array_merge([
                'frontier'      => json_encode(array_values($frontier)),
                'visited_books' => json_encode(array_values($visited)),
                'counts'        => json_encode($counts),
                'results'       => json_encode(array_values($results)),
                'updated_at'    => now(),
            ], $extra));
        };

        while (($entry = array_shift($frontier)) !== null) {
            $book = $entry['book'] ?? null;
            $depth = (int) ($entry['depth'] ?? 0);
            // A resume entry re-enters a book whose work batch a previous slice
            // left unfinished: bypass the visited guard and skip the
            // (already-done) bibliography scan, processing only the parked ids.
            $resumeIds = $entry['resume_ids'] ?? null;
            if (!$book || ($resumeIds === null && in_array($book, $visited, true))) {
                continue;
            }

            // Slice boundary between books: park this entry back at the front
            // untouched and hand off to the next slice.
            if ($sliceDue()) {
                array_unshift($frontier, $entry);
                $sliced = true;
                break;
            }

            if (!in_array($book, $visited, true)) {
                $visited[] = $book;
            }

            // Stop between books (cancel is the case that matters here; the
            // spend cap is enforced per-work below). Break to the finalize step.
            if ($stopReason = $shouldStop()) {
                break;
            }

            if ($resumeIds === null) {
                // ---- Stage 1: resolve this book's citations to canonicals ----
                $persist(['step' => 'scan', 'step_detail' => "Scanning bibliography (depth {$depth})"]);
                $telemetry->emit('scan', 'started', "Scanning bibliography of {$book} (depth {$depth})");

                $exit = Artisan::call('citation:scan-bibliography', ['target' => $book]);
                if ($exit !== 0) {
                    $telemetry->emit('scan', 'failed', "citation:scan-bibliography exited {$exit}");
                    throw new \RuntimeException("citation:scan-bibliography exited {$exit} for {$book}");
                }
                $telemetry->emit('scan', 'completed');
                $didWork = true;
            }

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
            if ($resumeIds !== null) {
                // Resume: only the parked, still-eligible works (a work that
                // got versioned between slices drops out here). Counted as
                // eligible by the slice that first selected them.
                $eligible = $eligible->whereIn('id', $resumeIds)->values();
                $telemetry->emit('select', 'progress', 'resuming ' . $eligible->count() . ' work(s) parked by the previous slice');
            } else {
                $counts['eligible'] += $eligible->count();
            }

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
                // Slice boundary BEFORE attempting the work: park the
                // un-attempted remainder of this batch as a resume entry at
                // the frontier front, so the next slice continues exactly here
                // (no re-scan, no double-attempt).
                if ($sliceDue()) {
                    array_unshift($frontier, [
                        'book'       => $book,
                        'depth'      => $depth,
                        'resume_ids' => $eligible->values()->slice($i)->pluck('id')->all(),
                    ]);
                    $sliced = true;
                    break;
                }

                // Stop BEFORE attempting the work: cancelled, or the spend cap /
                // balance is reached. On a budget stop, record this batch's
                // remainder as skipped_over_budget so the yield report lists what
                // a top-up + rerun would fetch (a cancel just stops cleanly).
                if ($stopReason = $shouldStop()) {
                    if ($stopReason === 'over_budget') {
                        foreach ($eligible->values()->slice($i) as $skip) {
                            $counts['skipped_over_budget']++;
                            $results[] = $metaFromRow($skip) + [
                                'status' => 'skipped_over_budget',
                                'reason' => 'spending limit reached',
                                'via'    => null,
                                'book'   => null,
                                // Citation lineage for the yield report's network
                                // viz: this work is cited BY $book, one level below
                                // it (root book = depth 0, never itself an entry).
                                'depth'       => $depth + 1,
                                'parent_book' => $book,
                            ];
                        }
                    }
                    $persist();
                    break;
                }

                $label = ($i + 1) . '/' . $eligible->count() . ': ' . mb_substr($row->title ?? '(untitled)', 0, 60);
                $persist(['step' => 'harvest', 'step_detail' => "Importing work {$label}"]);

                $counts['attempted']++;
                $didWork = true;

                try {
                    $canonical = CanonicalSource::find($row->id);
                    if (!$canonical) {
                        throw new \RuntimeException('canonical row vanished mid-run');
                    }

                    $result = $this->creator->create($canonical);
                    $status = $result['status'];

                    $counts[$status === 'error' ? 'errors' : $status] =
                        ($counts[$status === 'error' ? 'errors' : $status] ?? 0) + 1;

                    // Surface which OA copy won / how many were tried (Phase E
                    // of the OA-fetch hardening) so a run's telemetry shows
                    // "imported from europepmc.org" vs "tried 4, all walled".
                    $via = $result['via'] ?? null;
                    $detail = "{$label} — {$status}"
                        . ($via ? " {$via}" : '')
                        . ($result['reason'] ? " ({$result['reason']})" : '');
                    $telemetry->emit(
                        'harvest',
                        in_array($status, ['assigned', 'assigned_existing'], true) ? 'progress' : 'skipped',
                        $detail,
                        array_filter(['lane' => $result['lane']])
                    );

                    // (Shelving no longer tracks an in-memory list — finalize()
                    // derives the assigned books from the persisted results, so
                    // a crash or slice boundary loses nothing.)

                    // Bill the OCR for a FRESHLY imported work. 'assigned' = a new
                    // fetch+convert this run; 'assigned_existing' wired an already-
                    // converted stub (no new OCR, no charge). billOcrForBook returns
                    // 0 for native/BYO OCR and non-OCR lanes (JATS/HTML). The cap is
                    // enforced at the NEXT work's boundary — a PDF's page count is
                    // unknowable pre-OCR, so the work crossing the cap may tip over.
                    if ($status === 'assigned' && $result['book']) {
                        $spend += $this->chargeWorkOcr($user, $result['book']);
                        $counts['spend'] = round($spend, 2);
                    }

                    // Record the per-work outcome for the yield report — the
                    // canonical metadata (from the eligible row) plus how it went.
                    $results[] = $metaFromRow($row) + [
                        'status' => $status,
                        'reason' => $result['reason'] ?? null,
                        'via'    => $via,
                        'book'   => $result['book'] ?? null,
                        // Citation lineage (see the skipped_over_budget site).
                        'depth'       => $depth + 1,
                        'parent_book' => $book,
                    ];

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
                    $results[] = $metaFromRow($row) + [
                        'status' => 'error',
                        'reason' => $e->getMessage(),
                        'via'    => null,
                        'book'   => null,
                        // Citation lineage (see the skipped_over_budget site).
                        'depth'       => $depth + 1,
                        'parent_book' => $book,
                    ];
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

            if ($sliced) {
                break; // mid-batch slice — bookmark is on the frontier, exit to the slice return
            }

            $telemetry->emit('harvest', 'completed', null, [
                'assigned' => $counts['assigned'] + $counts['assigned_existing'],
                'attempted' => $counts['attempted'],
            ]);
            $persist();

            if ($stopReason) {
                break; // budget/cancel stop mid-batch — go straight to finalize
            }
        }

        if ($sliced) {
            // Not a terminal outcome: flush the bookmark and hand back to the
            // job, which re-dispatches a fresh slice. Finalize (shelf + yield
            // report) is deliberately skipped — the LAST slice runs it, and a
            // crash between slices still ships a report via the job's
            // failed() → finalize().
            $persist(['step' => 'sliced', 'step_detail' => 'Pausing — continuing in a fresh worker slice']);
            return 'sliced';
        }

        if ($stopReason === 'over_budget') {
            $telemetry->emit('harvest', 'progress',
                "Spending limit reached — stopped with {$counts['skipped_over_budget']} work(s) left for a rerun");
        } elseif ($stopReason === 'cancelled') {
            $telemetry->emit('harvest', 'skipped', 'Harvest cancelled');
        } elseif ($stopReason === 'finished') {
            $telemetry->emit('harvest', 'progress',
                'Finished early by request — writing the report for everything gathered');
        }

        // Flush the loop's final state so finalize() (which reads only the
        // row) sees everything, then finalize and clear the step marker.
        $persist();
        $this->finalize($harvestId);
        $persist(['step' => null, 'step_detail' => null]);

        return $stopReason === 'cancelled' ? 'cancelled' : 'completed';
    }

    /**
     * Shelf + yield report finalization, rebuilt ENTIRELY from the harvest
     * row's persisted state (results/counts are flushed after every work), so
     * it serves two callers: the natural end of a run, and the job's failed()
     * hook after a crash — the "always ship a report for whatever we got"
     * guarantee. $failureNote (crash path) renders as a warning at the top of
     * the report; a later successful re-run regenerates the report in place
     * and clears it. Never throws: a shelf/report failure must not fail (or
     * mask the failure of) the harvest itself.
     *
     * Runs whenever ANY work was attempted — so even a 0-import run still
     * produces a shelf carrying a useful report — or when a shelf from a
     * prior run already exists.
     */
    public function finalize(string $harvestId, ?string $failureNote = null): void
    {
        $db = DB::connection('pgsql_admin');
        $harvest = $db->table('source_network_harvests')->where('id', $harvestId)->first();
        if (!$harvest) {
            return;
        }

        $telemetry = new HarvestTelemetry($harvestId);
        $results = json_decode($harvest->results ?? '[]', true) ?: [];
        $counts = json_decode($harvest->counts ?? '{}', true) ?: [];

        // The DURABLE harvested set for this book — every work reachable from it
        // that now carries an auto_version_book, straight from the database. This
        // is the single source of truth for what HAS been harvested, so the
        // report is correct regardless of which run pulled what or whether an
        // earlier run crashed before finalizing. See HarvestEligibility.
        $harvestedNetwork = $this->eligibility->harvestedNetworkFor($harvest->root_book);

        // Books to shelve: the durable harvested version books, unioned with any
        // assigned this run (belt-and-braces — the durable set already contains
        // them). addBooks() upserts, so re-shelving across finalizes is harmless.
        $harvestedBooks = array_values(array_unique(array_filter(array_merge(
            array_map(fn ($r) => $r['book'] ?? null, $harvestedNetwork),
            array_map(
                fn ($r) => in_array($r['status'] ?? '', ['assigned', 'assigned_existing'], true)
                    ? ($r['book'] ?? null) : null,
                $results
            )
        ))));

        if (!empty($results) || !empty($harvestedNetwork) || !empty($harvest->shelf_id)) {
            $db->table('source_network_harvests')->where('id', $harvestId)->update([
                'step'        => 'shelf',
                'step_detail' => 'Collecting sources + writing the yield report',
                'updated_at'  => now(),
            ]);
            $telemetry->emit('shelf', 'started', 'Collecting sources onto your shelf');
            try {
                $shelfInfo = $this->shelf->ensureShelfFor($harvest->root_book);
                if ($shelfInfo) {
                    $rootTitle = $db->table('library')->where('book', $harvest->root_book)->value('title')
                        ?: $harvest->root_book;

                    // Write the yield report (successes from the durable set) and
                    // shelve every harvested source alongside it.
                    $reportBook = $this->report->generate($harvest->root_book, $rootTitle, $results, $failureNote, $harvestedNetwork);
                    $shelfBooks = array_values(array_filter(array_merge($harvestedBooks, [$reportBook])));
                    $this->shelf->addBooks($shelfInfo->id, $shelfBooks);

                    $db->table('source_network_harvests')
                        ->where('id', $harvestId)
                        ->update(['shelf_id' => $shelfInfo->id, 'report_book' => $reportBook, 'updated_at' => now()]);

                    $failed = max(0, (int) ($counts['attempted'] ?? 0)
                        - (int) ($counts['assigned'] ?? 0) - (int) ($counts['assigned_existing'] ?? 0));
                    $telemetry->emit(
                        'shelf',
                        'completed',
                        count($harvestedBooks) . " source(s) shelved + yield report ({$failed} couldn't be fetched)",
                        ['books' => count($harvestedBooks), 'failed' => $failed]
                    );
                } else {
                    $telemetry->emit('shelf', 'skipped', 'no shelf owner resolvable for the root book');
                }
            } catch (\Throwable $e) {
                // A shelf/report failure must never fail the harvest itself.
                $telemetry->emit('shelf', 'failed', $e->getMessage());
                Log::warning('Harvest shelf/report step failed', [
                    'harvest' => $harvestId,
                    'error'   => $e->getMessage(),
                ]);
            }
        } else {
            // Nothing attempted at all — emit a terminal 'skipped' so the viz
            // shows the stage done-skipped, not stuck at 'pending'.
            $telemetry->emit('shelf', 'skipped', 'no citations were eligible to fetch');
        }

        // Bump annotations_updated_at so the frontend re-syncs bibliography
        // records (new canonical links) on next load — same trigger the
        // citation pipeline uses.
        $db->table('library')
            ->where('book', $harvest->root_book)
            ->update(['annotations_updated_at' => round(microtime(true) * 1000)]);
    }

    /**
     * Charge the harvest owner for one work's Mistral OCR, returning the dollars
     * debited (0 for anonymous owners, native/BYO OCR, and non-OCR lanes).
     *
     * Mirrors GenerateBookAudioJob::chargeFor: charge() re-reads the user on the
     * DEFAULT connection whose users_select_policy needs BOTH app.current_user
     * AND app.current_token, but only sets the former. In a queue worker (no HTTP
     * session) we must set both — or the charge silently matches zero rows.
     */
    private function chargeWorkOcr(?User $user, string $bookId): float
    {
        if (!$user) {
            return 0.0;
        }

        DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
        DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
        try {
            return app(BillingService::class)->billOcrForBook(
                $user,
                $bookId,
                resource_path("markdown/{$bookId}"),
                "Harvest OCR: {$bookId}",
            );
        } finally {
            DB::statement("SELECT set_config('app.current_user', '', false)");
            DB::statement("SELECT set_config('app.current_token', '', false)");
        }
    }
}
