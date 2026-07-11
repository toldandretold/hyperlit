<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\ResolvesBookOwner;
use App\Jobs\SourceNetworkHarvestJob;
use App\Services\BillingService;
use App\Services\SourceHarvest\HarvestEligibility;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Source Network Harvester HTTP seam: estimate → confirm → trigger → poll.
 * From a book the owner controls, the harvest scans its bibliography and
 * fetches+converts every eligible open-access cited work into that
 * canonical's auto_version_book (see app/Services/SourceHarvest/README.md).
 *
 * Owner-gated via ResolvesBookOwner: the job writes through pgsql_admin, so
 * the check here is the authorization boundary. Estimate is pure SQL (no
 * network) so the panel can call it freely.
 */
class SourceHarvestController extends Controller
{
    use ResolvesBookOwner;

    public function __construct(private readonly HarvestEligibility $eligibility)
    {
    }

    /**
     * POST /api/library/{book}/harvest/estimate — dry-run numbers for the
     * confirm dialog. No writes, no network.
     */
    public function estimate(Request $request, string $book): JsonResponse
    {
        [, $deny] = $this->authorizeBookEdit($request, $book);
        if ($deny) return $deny;

        if ($guard = $this->rejectEncrypted($book)) return $guard;

        $running = $this->activeHarvestFor($book);

        return response()->json([
            'success'   => true,
            'estimate'  => $this->eligibility->estimateFor($book),
            'max_works' => (int) config('source_harvest.max_works_per_run'),
            'running'   => $running ? ['id' => $running->id, 'status' => $running->status] : null,
        ]);
    }

    /**
     * POST /api/library/{book}/harvest/trigger — create a harvest row and
     * queue the run. 409 while a harvest OR a citation pipeline is active for
     * the book (both mutate the same bibliography/canonical rows).
     */
    public function trigger(Request $request, string $book): JsonResponse
    {
        [, $deny] = $this->authorizeBookEdit($request, $book);
        if ($deny) return $deny;

        if ($guard = $this->rejectEncrypted($book)) return $guard;

        // The scan stage runs LLM metadata extraction — same cost profile as
        // the citation pipeline trigger, same balance gate.
        $user = Auth::user();
        if ($user) {
            $user->refresh();
            if (!app(BillingService::class)->canProceed($user)) {
                return response()->json([
                    'success' => false,
                    'message' => 'Insufficient balance. Please top up your credits to continue.',
                ], 402);
            }
        }

        $db = DB::connection('pgsql_admin');

        // F2: serialise the running-harvest check and the insert so two
        // concurrent requests can't both pass the check (same pattern as the
        // citation pipeline trigger).
        $lock = Cache::lock("source-harvest:{$book}", 15);
        if (!$lock->get()) {
            return response()->json([
                'success' => false,
                'message' => 'A harvest is already starting for this book.',
            ], 409);
        }

        try {
            if ($this->activeHarvestFor($book)) {
                return response()->json([
                    'success' => false,
                    'message' => 'A harvest is already in progress for this book.',
                ], 409);
            }

            $pipelineActive = $db->table('citation_pipelines')
                ->where('book', $book)
                ->whereIn('status', ['pending', 'running'])
                ->exists();
            if ($pipelineActive) {
                return response()->json([
                    'success' => false,
                    'message' => 'A citation pipeline is running for this book — wait for it to finish first.',
                ], 409);
            }

            $harvestId = (string) Str::uuid();
            $db->table('source_network_harvests')->insert([
                'id'            => $harvestId,
                'root_book'     => $book,
                'user_id'       => Auth::id(),
                'status'        => 'pending',
                'max_depth'     => (int) config('source_harvest.max_depth'),
                'max_works'     => (int) config('source_harvest.max_works_per_run'),
                'frontier'      => json_encode([['book' => $book, 'depth' => 0]]),
                'visited_books' => json_encode([]),
                'counts'        => json_encode([]),
                'telemetry'     => json_encode([]),
                'created_at'    => now(),
                'updated_at'    => now(),
            ]);

            SourceNetworkHarvestJob::dispatch($harvestId);

            return response()->json([
                'success'    => true,
                'harvest_id' => $harvestId,
                'message'    => 'Source network harvest has been queued.',
            ]);
        } finally {
            $lock->release();
        }
    }

    /**
     * GET /api/source-harvest/status/{harvestId}
     */
    public function status(string $harvestId): JsonResponse
    {
        $harvest = DB::connection('pgsql_admin')
            ->table('source_network_harvests')
            ->where('id', $harvestId)
            ->first();

        if (!$harvest) {
            return response()->json(['success' => false, 'message' => 'Harvest not found'], 404);
        }

        $harvest = $this->autoFailStaleHarvest($harvest);

        return response()->json([
            'success' => true,
            'harvest' => [
                'id'          => $harvest->id,
                'root_book'   => $harvest->root_book,
                'status'      => $harvest->status,
                'step'        => $harvest->step,
                'step_detail' => $harvest->step_detail,
                'max_works'   => $harvest->max_works,
                'counts'      => json_decode($harvest->counts ?? '{}', true),
                'telemetry'   => json_decode($harvest->telemetry ?? '[]', true),
                'error'       => $harvest->error,
                'shelf'       => $this->shelfPayload($harvest->shelf_id ?? null),
                'notify_email' => (bool) ($harvest->notify_email ?? false),
                'created_at'  => $harvest->created_at,
                'updated_at'  => $harvest->updated_at,
            ],
        ]);
    }

    /**
     * GET /api/source-harvest/map — the static stage chain the live
     * visualisation renders (mirrors /api/citation-pipeline/map).
     */
    public function map(): JsonResponse
    {
        return response()->json([
            'success' => true,
            'stages'  => \App\Services\SourceHarvest\HarvestMap::stages(),
        ]);
    }

    /**
     * POST /api/source-harvest/{harvestId}/notify — opt in to a completion
     * email. Authenticated harvest owners only (anonymous owners have no
     * email address to send to).
     */
    public function notify(string $harvestId): JsonResponse
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['success' => false, 'message' => 'You must be logged in to receive email notifications.'], 401);
        }

        $db = DB::connection('pgsql_admin');
        $harvest = $db->table('source_network_harvests')->where('id', $harvestId)->first();

        if (!$harvest) {
            return response()->json(['success' => false, 'message' => 'Harvest not found'], 404);
        }

        if ((int) $harvest->user_id !== (int) $user->id) {
            return response()->json(['success' => false, 'message' => 'Forbidden'], 403);
        }

        if (in_array($harvest->status, ['completed', 'failed'], true)) {
            return response()->json(['success' => false, 'message' => 'Harvest already finished'], 422);
        }

        $db->table('source_network_harvests')
            ->where('id', $harvestId)
            ->update(['notify_email' => true, 'updated_at' => now()]);

        return response()->json(['success' => true]);
    }

    /** Shelf link payload for the completion dialog + email (null until the shelf step ran). */
    private function shelfPayload(?string $shelfId): ?array
    {
        if (!$shelfId) {
            return null;
        }

        $shelf = DB::connection('pgsql_admin')
            ->table('shelves')
            ->where('id', $shelfId)
            ->select(['id', 'name', 'slug', 'creator'])
            ->first();

        return $shelf ? (array) $shelf : null;
    }

    /**
     * GET /api/source-harvest/running/{book} — panel-reopen state restore.
     */
    public function running(string $book): JsonResponse
    {
        $harvest = $this->activeHarvestFor($book);

        return response()->json([
            'success' => true,
            'harvest' => $harvest ? [
                'id'           => $harvest->id,
                'status'       => $harvest->status,
                'step'         => $harvest->step,
                'step_detail'  => $harvest->step_detail,
                'notify_email' => (bool) ($harvest->notify_email ?? false),
            ] : null,
        ]);
    }

    /** Active (pending/running) harvest for a book after the stale check. */
    private function activeHarvestFor(string $book): ?object
    {
        $harvest = DB::connection('pgsql_admin')
            ->table('source_network_harvests')
            ->where('root_book', $book)
            ->whereIn('status', ['pending', 'running'])
            ->first();

        if ($harvest) {
            $harvest = $this->autoFailStaleHarvest($harvest);
        }

        return ($harvest && in_array($harvest->status, ['pending', 'running'], true)) ? $harvest : null;
    }

    private function rejectEncrypted(string $book): ?JsonResponse
    {
        // E2EE (docs/e2ee.md): harvesting reads node content server-side —
        // impossible for an encrypted book (server only holds ciphertext).
        if (\App\Services\E2ee\EncryptedBookGuard::isEncrypted($book)) {
            return response()->json([
                'success' => false,
                'message' => 'Encrypted books cannot use the source network harvester',
            ], 422);
        }
        return null;
    }

    /**
     * Auto-fail a harvest stuck in pending/running too long (worker died —
     * tries=1 means nothing will resurrect it). Same thresholds as the
     * citation pipeline's stale watchdog.
     */
    private function autoFailStaleHarvest(object $harvest): object
    {
        if (!in_array($harvest->status, ['pending', 'running'], true)) {
            return $harvest;
        }

        $updatedAt = strtotime($harvest->updated_at);
        $now = time();
        $stalePendingSeconds = 5 * 60;       // 5 minutes
        $staleRunningSeconds = 3 * 60 * 60;  // 3 hours

        $isStale = ($harvest->status === 'pending' && ($now - $updatedAt) > $stalePendingSeconds)
                || ($harvest->status === 'running' && ($now - $updatedAt) > $staleRunningSeconds);

        if (!$isStale) {
            return $harvest;
        }

        $error = $harvest->status === 'pending'
            ? 'Harvest timed out: job never started (stuck in pending for over 5 minutes).'
            : 'Harvest timed out: no progress for over 3 hours.';

        // Guard with status check to prevent race conditions between concurrent requests
        $affected = DB::connection('pgsql_admin')
            ->table('source_network_harvests')
            ->where('id', $harvest->id)
            ->whereIn('status', ['pending', 'running'])
            ->update([
                'status'     => 'failed',
                'error'      => $error,
                'updated_at' => now(),
            ]);

        if ($affected) {
            $harvest = DB::connection('pgsql_admin')
                ->table('source_network_harvests')
                ->where('id', $harvest->id)
                ->first();
        }

        return $harvest;
    }
}
