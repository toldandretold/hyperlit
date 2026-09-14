<?php

/**
 * The two guards that keep a detection slice from starting work it cannot finish, and the
 * hook that resumes the chain when a slice dies anyway.
 *
 * Regression origin (tripleC, 2026-09-14): a detect run chained ~22 hours of clean 50-minute
 * slices, then entered `citation:scan-bibliography` on an OJS whole-issue PDF with 973
 * extracted references. The slice budget is only consulted BEFORE taking a new book, so the
 * scan ran unbounded past it, the worker killed the job at its 3600s timeout, and because a
 * kill skips handle()'s catch block no continuation was ever dispatched. With `tries = 1`
 * nothing retried; the run row sat 'running' until the console's 30-minute watchdog declared
 * "the worker died or was never running", which was true of neither.
 */

use App\Jobs\DetectHyperciteCandidatesJob;
use App\Services\Hypercites\CandidateDetector;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

// ───────────────────────────── the scan guard (pure) ─────────────────────────────

test('a bibliography within the cap, early in the budget, is scanned', function () {
    expect(CandidateDetector::scanVerdict(97, now()->timestamp + 3000, now()->timestamp, 400, 900))
        ->toBe(CandidateDetector::SCAN_OK);
});

test('an oversized bibliography is refused permanently, not deferred', function () {
    // 973 rows is the actual book that broke the run. The verdict must be OVERSIZED and not
    // DEFER even with a full budget ahead of it — deferring would hand the same bomb to the
    // next slice, and the next, forever.
    $verdict = CandidateDetector::scanVerdict(973, now()->timestamp + 3000, now()->timestamp, 400, 900);

    expect($verdict)->toBe(CandidateDetector::SCAN_OVERSIZED);
});

test('oversized wins over defer when both would apply', function () {
    // Late in the budget AND too big: still OVERSIZED, because the distinction the operator
    // acts on is "this book needs an out-of-band scan", not "try again next slice".
    expect(CandidateDetector::scanVerdict(1997, now()->timestamp + 10, now()->timestamp, 400, 900))
        ->toBe(CandidateDetector::SCAN_OVERSIZED);
});

test('a scan is deferred when less than the reserve remains', function () {
    // 800s left, 900s reserve — not enough room to safely finish, so do not start.
    expect(CandidateDetector::scanVerdict(97, now()->timestamp + 800, now()->timestamp, 400, 900))
        ->toBe(CandidateDetector::SCAN_DEFER);
});

test('the reserve boundary is exclusive — exactly the reserve still scans', function () {
    expect(CandidateDetector::scanVerdict(97, now()->timestamp + 900, now()->timestamp, 400, 900))
        ->toBe(CandidateDetector::SCAN_OK);
});

test('the row cap is exclusive — exactly the cap still scans', function () {
    expect(CandidateDetector::scanVerdict(400, now()->timestamp + 3000, now()->timestamp, 400, 900))
        ->toBe(CandidateDetector::SCAN_OK);
    expect(CandidateDetector::scanVerdict(401, now()->timestamp + 3000, now()->timestamp, 400, 900))
        ->toBe(CandidateDetector::SCAN_OVERSIZED);
});

test('an unbudgeted run never defers', function () {
    // `--sync` (deadline null) has no continuation to defer to, so deferring would silently
    // drop the book instead of postponing it.
    expect(CandidateDetector::scanVerdict(97, null, now()->timestamp, 400, 900))
        ->toBe(CandidateDetector::SCAN_OK);
});

test('an unbudgeted run still refuses an oversized bibliography', function () {
    expect(CandidateDetector::scanVerdict(973, null, now()->timestamp, 400, 900))
        ->toBe(CandidateDetector::SCAN_OVERSIZED);
});

// ───────────────────────────── the failed() continuation ─────────────────────────────

function sliceGuardRun(array $overrides = []): string
{
    $id = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('hypercite_runs')->insert(array_merge([
        'id'         => $id,
        'action'     => 'detect',
        'status'     => 'running',
        'counts'     => '{}',
        'created_at' => now(),
        'updated_at' => now(),
    ], $overrides));

    return $id;
}

test('a failed slice resumes the chain instead of stranding the run', function () {
    Queue::fake();
    $runId = sliceGuardRun();

    (new DetectHyperciteCandidatesJob($runId, false, 3000))->failed(new RuntimeException('boom'));

    Queue::assertPushed(DetectHyperciteCandidatesJob::class, 1);

    // Status must stay 'running' and the heartbeat must be touched — that is precisely what
    // keeps the console's 30-minute watchdog from killing a run that IS being resumed.
    $run = DB::connection('pgsql_admin')->table('hypercite_runs')->where('id', $runId)->first();
    expect($run->status)->toBe('running');
    expect($run->error)->toBeNull();
    expect($run->step_detail)->toContain('attempt 1 of 2');
});

test('a slice killed without an exception still resumes', function () {
    // The real production case: a worker timeout or SIGKILL calls failed() with no Throwable.
    Queue::fake();
    $runId = sliceGuardRun();

    (new DetectHyperciteCandidatesJob($runId, false, 3000))->failed(null);

    Queue::assertPushed(DetectHyperciteCandidatesJob::class, 1);
    expect(DB::connection('pgsql_admin')->table('hypercite_runs')->where('id', $runId)->value('status'))
        ->toBe('running');
});

test('the resume allowance is bounded — an exhausted chain is marked failed, not re-dispatched', function () {
    Queue::fake();
    $runId = sliceGuardRun();

    // Second retry of a max-2 allowance: this one is terminal.
    (new DetectHyperciteCandidatesJob($runId, false, 3000, 2))->failed(new RuntimeException('still boom'));

    Queue::assertNothingPushed();

    $run = DB::connection('pgsql_admin')->table('hypercite_runs')->where('id', $runId)->first();
    expect($run->status)->toBe('failed');
    expect($run->error)->toContain('still boom');
    expect($run->progress)->toBeNull();
});

test('a --sync run does not queue a continuation it has no worker for', function () {
    Queue::fake();
    $runId = sliceGuardRun();

    // budgetSeconds null is the CLI's inline path.
    (new DetectHyperciteCandidatesJob($runId, false, null))->failed(new RuntimeException('inline boom'));

    Queue::assertNothingPushed();
    expect(DB::connection('pgsql_admin')->table('hypercite_runs')->where('id', $runId)->value('status'))
        ->toBe('failed');
});
