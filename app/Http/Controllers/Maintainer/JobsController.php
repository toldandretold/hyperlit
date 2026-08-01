<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use App\Services\System\FailureDigest;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * /maintainer/jobs — job-failure triage, the sibling of /maintainer/conversion.
 *
 * Failures are shown GROUPED (see FailureDigest): a flat failed_jobs list is
 * what makes an operator close the tab, and the July 2026 triage showed 87 rows
 * were really 5 distinct bugs. Per group you can forget it, retry it, or pull a
 * case bundle down to a dev machine — the same loop as the conversion page's
 * "⤓ dev bundle".
 *
 * Web route: admin checked in-controller, non-admins get 404 (the page isn't
 * advertised — mirrors MaintainerController). API routes: behind the
 * auth:sanctum + admin middleware group in routes/api.php.
 */
class JobsController extends Controller
{
    /** Where the "what's new since I last looked" marker lives (no migration needed). */
    private const SEEN_KEY = 'maintainer.jobs.seen.';

    /** GET /maintainer/jobs — the standalone triage page. */
    public function show(Request $request)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }

        return view('maintainer-jobs');
    }

    /** GET /api/maintainer/jobs/failures — grouped failures + queue depth. */
    public function failures(Request $request, FailureDigest $digest)
    {
        $since = $this->lastSeen($request);

        return response()->json([
            'groups' => $digest->groups($since),
            'queues' => $digest->queueDepth(),
            'last_seen' => $since?->toIso8601String(),
            // Supervisor process state is deliberately absent: PHP-FPM cannot
            // call supervisorctl, and a page that implies it is watching the
            // workers when it isn't isn't worth having. workers.sh status is
            // the honest source for that.
            'workers_hint' => './deploy/supervisor/workers.sh status',
        ]);
    }

    /** POST /api/maintainer/jobs/seen — stamp "I have looked at this". */
    public function markSeen(Request $request)
    {
        Cache::put(self::SEEN_KEY . $request->user()->id, now()->toIso8601String(), now()->addYear());

        return response()->json(['ok' => true]);
    }

    /**
     * POST /api/maintainer/jobs/{key}/retry — push the group's jobs back onto
     * their queue. Paid classes need {confirm_paid: true}: a retry re-runs the
     * real billable API work, so it must never be a stray click.
     */
    public function retry(Request $request, string $key, FailureDigest $digest)
    {
        $group = $digest->group($key);
        if (! $group) {
            return response()->json(['message' => 'No such failure group.'], 404);
        }

        if ($group['paid'] && ! $request->boolean('confirm_paid')) {
            return response()->json([
                'message' => "{$group['job_name']} does real paid work — retrying re-runs it and re-charges. Confirm explicitly.",
                'needs_confirm' => true,
            ], 422);
        }

        $uuids = DB::table('failed_jobs')->whereIn('id', $group['ids'])->pluck('uuid');
        foreach ($uuids as $uuid) {
            Artisan::call('queue:retry', ['id' => [$uuid]]);
        }

        return response()->json(['retried' => $uuids->count()]);
    }

    /** DELETE /api/maintainer/jobs/{key} — forget the group (the honest "dismiss"). */
    public function forget(string $key, FailureDigest $digest)
    {
        $group = $digest->group($key);
        if (! $group) {
            return response()->json(['message' => 'No such failure group.'], 404);
        }

        $deleted = DB::table('failed_jobs')->whereIn('id', $group['ids'])->delete();

        return response()->json(['forgotten' => $deleted]);
    }

    /**
     * GET /api/maintainer/jobs/{key}/export — build the case bundle
     * (failure:export) and stream it down, exactly as the conversion page
     * streams book:export.
     */
    public function export(string $key, FailureDigest $digest)
    {
        if (! $digest->group($key)) {
            return response()->json(['message' => 'No such failure group.'], 404);
        }

        $exit = Artisan::call('failure:export', ['key' => $key]);
        if ($exit !== 0) {
            return response()->json(['message' => 'Export failed — see logs.'], 422);
        }

        $tarball = storage_path("app/failure-exports/{$key}.tar.gz");
        if (! File::exists($tarball)) {
            return response()->json(['message' => 'Export produced no bundle.'], 500);
        }

        return response()->download($tarball, "failure-{$key}.tar.gz");
    }

    private function lastSeen(Request $request): ?Carbon
    {
        $raw = Cache::get(self::SEEN_KEY . $request->user()->id);

        return $raw ? Carbon::parse($raw) : null;
    }
}
