<?php

/**
 * User imports ride the `imports` priority lane; mass backend work stays on
 * `default` (review gate).
 *
 * The bug this locks out: one journal-console "reconvert all" press queues
 * ~900 ProcessDocumentImportJobs on `default`, and a user's single upload —
 * dispatched to the same queue, drained by the same serial numprocs=1 worker —
 * sat behind ALL of them ("Waiting in queue — 902 ahead", prod 2026-09-15).
 * The fix is two lanes on one worker (`--queue=imports,default`): Laravel pops
 * the list left to right every cycle, so anything on `imports` preempts
 * everything queued on `default`.
 *
 * Three things must stay true together, or the lane silently dies:
 *   1. user-facing dispatch sites target ProcessDocumentImportJob::QUEUE_INTERACTIVE
 *      (bulk fan-outs must NOT);
 *   2. every worker definition (supervisor conf, dev scripts, probe reference
 *      topology) lists `imports` BEFORE `default`;
 *   3. ImportQueuePosition counts "ahead of me" lane-aware, or the UX lies.
 */

use App\Jobs\ProcessDocumentImportJob;
use App\Services\DocumentImport\ImportQueuePosition;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

const IQP_MARKER = 'iqp-test-marker';

function iqpJobs()
{
    // Default connection — the same one ImportQueuePosition reads (the jobs
    // table is queue infrastructure, not RLS-guarded user data).
    return DB::table('jobs');
}

/** Insert a fake job row; payload carries the book id + a marker for cleanup. */
function iqpInsert(string $queue, string $bookId, bool $reserved = false): int
{
    return iqpJobs()->insertGetId([
        'queue' => $queue,
        'payload' => json_encode(['displayName' => 'Fake', 'book' => $bookId, 'marker' => IQP_MARKER]),
        'attempts' => 0,
        'reserved_at' => $reserved ? time() : null,
        'available_at' => time(),
        'created_at' => time(),
    ]);
}

function iqpBook(): string
{
    // Unique per call: ImportQueuePosition caches by bookId for 10s, so reusing
    // an id across tests would serve a stale count.
    return 'iqpbook' . str_replace('-', '', (string) \Illuminate\Support\Str::uuid());
}

beforeEach(function () {
    // The counts are table-wide, so residue from other tests' real dispatches
    // (or an aborted previous run) would skew them — start from empty lanes.
    iqpJobs()->whereIn('queue', ['imports', 'default'])->delete();
});

afterEach(function () {
    iqpJobs()->where('payload', 'like', '%' . IQP_MARKER . '%')->delete();
});

// ── 1. Lane-aware queue position ─────────────────────────────────────────────

test('no job row on either lane → null', function () {
    expect(ImportQueuePosition::jobsAhead(iqpBook()))->toBeNull();
});

test('imports-lane job counts earlier imports jobs, not the queued default backlog', function () {
    $mine = iqpBook();

    // A deep bulk backlog, none of it running.
    iqpInsert('default', iqpBook());
    iqpInsert('default', iqpBook());
    iqpInsert('default', iqpBook());

    // One earlier user import, then mine, then a later one.
    iqpInsert('imports', iqpBook());
    iqpInsert('imports', $mine);
    iqpInsert('imports', iqpBook());

    // Queued default jobs are invisible to me — the worker won't touch them
    // while imports has work. Only the earlier imports job counts.
    expect(ImportQueuePosition::jobsAhead($mine))->toBe(1);
});

test('imports-lane job counts the one default job the worker is running right now', function () {
    $mine = iqpBook();

    iqpInsert('default', iqpBook(), reserved: true);  // in-flight bulk conversion
    iqpInsert('default', iqpBook());                  // queued bulk — doesn't count
    iqpInsert('imports', $mine);

    expect(ImportQueuePosition::jobsAhead($mine))->toBe(1);
});

test('default-lane (bulk) job counts every imports job plus earlier default jobs', function () {
    $mine = iqpBook();

    iqpInsert('default', iqpBook());       // earlier bulk → ahead
    iqpInsert('default', $mine);
    iqpInsert('default', iqpBook());       // later bulk → behind
    iqpInsert('imports', iqpBook());       // user import → jumps ahead even though enqueued later

    expect(ImportQueuePosition::jobsAhead($mine))->toBe(2);
});

test('the position is cached briefly per book', function () {
    $mine = iqpBook();
    $earlier = iqpInsert('imports', iqpBook());
    iqpInsert('imports', $mine);

    expect(ImportQueuePosition::jobsAhead($mine))->toBe(1);

    // The earlier job finishes (row deleted) — the 10s cache still serves the
    // old answer until it's dropped, then a recompute sees the truth.
    iqpJobs()->where('id', $earlier)->delete();
    expect(ImportQueuePosition::jobsAhead($mine))->toBe(1);
    Cache::forget("import-queue-pos:{$mine}");
    expect(ImportQueuePosition::jobsAhead($mine))->toBe(0);
});

// ── 2. Dispatch-site routing (source gate) ───────────────────────────────────

test('user-facing import dispatch sites route to the interactive lane', function () {
    foreach ([
        app_path('Http/Controllers/ImportController.php'),
        app_path('Http/Controllers/UrlImportController.php'),
    ] as $file) {
        expect(file_get_contents($file))
            ->toContain('->onQueue(ProcessDocumentImportJob::QUEUE_INTERACTIVE)');
    }
});

test('the bulk reconvert-all fan-out does NOT ride the interactive lane', function () {
    // JournalImportActionJob::runReconvertAll queues one job per lane of a whole
    // journal — the exact backlog the lane exists to jump. It must never pass
    // interactive: true.
    expect(file_get_contents(app_path('Jobs/JournalImportActionJob.php')))
        ->not->toContain('interactive: true');
});

test('BookReconverter defaults to the bulk lane and only goes interactive when asked', function () {
    $src = file_get_contents(app_path('Services/Conversion/BookReconverter.php'));
    expect($src)->toContain('bool $interactive = false')
        ->and($src)->toContain("onQueue(\$interactive ? ProcessDocumentImportJob::QUEUE_INTERACTIVE : 'default')");
});

// ── 3. Worker topology (conf gate) ───────────────────────────────────────────

test('every import-worker definition lists imports before default', function () {
    $mustContain = [
        base_path('deploy/supervisor/hyperlit-worker.conf') => '--queue=imports,default',
        base_path('package.json') => '--queue=imports,default',
        app_path('Console/Commands/QueueTopologyProbeCommand.php') => "'imports,default'",
    ];
    foreach ($mustContain as $file => $needle) {
        expect(file_get_contents($file))->toContain($needle);
    }

    // The catch-all manual worker must serve the lane too, first.
    expect(file_get_contents(app_path('Console/Commands/WorkCommand.php')))
        ->toContain("'imports,");
});

test('the queue name constant matches what the confs say', function () {
    expect(ProcessDocumentImportJob::QUEUE_INTERACTIVE)->toBe('imports');
});
