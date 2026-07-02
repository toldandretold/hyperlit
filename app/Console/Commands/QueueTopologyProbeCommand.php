<?php

namespace App\Console\Commands;

use App\Jobs\QueueProbeSleepJob;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;

/**
 * Empirical probe of the queue WORKER TOPOLOGY — the queue-level companion to
 * tests/load/loadprobe.php (which probes HTTP concurrency and never touches
 * workers).
 *
 * Answers: "if every job class is busy at once, does anything block anything
 * else?" — the failure mode where a 15-min citation pipeline head-of-line-
 * blocked every document import because both shared one serial worker.
 *
 * How: dispatches a synthetic sleep job (QueueProbeSleepJob — no real
 * imports/LLM calls) onto EVERY queue simultaneously, plus a second short job
 * on `default`, then measures via cache timestamps:
 *   1. each queue's blocker starts            → every queue has its own worker
 *   2. all blockers overlap in time           → queues run in PARALLEL
 *   3. the short default job starts while the
 *      default blocker is still sleeping      → standby import worker exists
 *
 * By default it SPAWNS the dev worker topology itself (2x default, 1x each
 * other queue — mirroring package.json dev:all / deploy/supervisor), so it
 * tests the configured topology hermetically. Pass --use-running to instead
 * test whatever workers are already up (e.g. your live dev:all stack).
 *
 * Safe to run anywhere: synthetic jobs only sleep and write 2 cache keys; any
 * leftovers are deleted from the jobs table on teardown.
 */
class QueueTopologyProbeCommand extends Command
{
    protected $signature = 'queue:probe
                            {--blocker-secs=10 : How long each queue\'s blocker job sleeps}
                            {--probe-secs=2 : How long the short default-queue probe job sleeps}
                            {--use-running : Use already-running workers instead of spawning the topology}';

    protected $description = 'Probe the worker topology: occupy every queue at once and verify nothing blocks anything else';

    /** @var Process[] */
    private array $workers = [];

    private const QUEUES = ['default', 'citation-pipeline', 'vibe', 'embeddings', 'search-supplement'];

    public function handle(): int
    {
        $blockerSecs = max(5, (int) $this->option('blocker-secs'));
        $probeSecs = max(1, (int) $this->option('probe-secs'));
        $runId = Str::random(6);

        $preExisting = DB::table('jobs')->count();
        if ($preExisting > 0) {
            $this->warn("{$preExisting} pre-existing job(s) in the jobs table — they may delay blockers and skew results.");
        }

        try {
            if (! $this->option('use-running')) {
                $this->spawnTopology();
            } else {
                $this->info('Using already-running workers (none spawned).');
            }

            // 1. One blocker per queue, all at once.
            $blockers = [];
            $dispatchedAt = microtime(true);
            foreach (self::QUEUES as $queue) {
                $id = "{$runId}-block-{$queue}";
                QueueProbeSleepJob::dispatch($id, $blockerSecs)->onQueue($queue);
                $blockers[$queue] = $id;
            }
            $this->info('Dispatched a '.$blockerSecs."s blocker onto every queue: ".implode(', ', self::QUEUES));

            // 2. Every blocker must START (= the queue has a worker at all).
            $startDeadline = $blockerSecs; // generous: workers poll every 1s
            $rows = [];
            $allStarted = true;
            foreach ($blockers as $queue => $id) {
                $startedAt = $this->awaitCache("queueprobe:{$id}:started", $dispatchedAt + $startDeadline);
                $rows[$queue] = ['queue' => $queue, 'started' => $startedAt];
                if ($startedAt === null) {
                    $allStarted = false;
                    $this->error("✗ Queue '{$queue}': blocker never started — NO WORKER is serving this queue.");
                }
            }

            // 3. The short default probe must run WHILE the default blocker sleeps
            //    (proves the standby import worker), and while every other queue is
            //    busy (proves imports don't wait on anything).
            $probeId = "{$runId}-probe-default";
            $probeDispatchedAt = microtime(true);
            QueueProbeSleepJob::dispatch($probeId, $probeSecs)->onQueue('default');
            $probeStarted = $this->awaitCache("queueprobe:{$probeId}:started", $probeDispatchedAt + $blockerSecs + 5);
            $probeFinished = $probeStarted !== null
                ? $this->awaitCache("queueprobe:{$probeId}:finished", $probeStarted + $probeSecs + 10)
                : null;

            // 4. Let blockers finish so no reserved rows linger (retry_after is 7500s).
            $this->line('Waiting for blockers to finish...');
            foreach ($blockers as $id) {
                $this->awaitCache("queueprobe:{$id}:finished", $dispatchedAt + $blockerSecs + 30);
            }

            // ── Report ──
            $this->newLine();
            $this->table(
                ['queue', 'worker found', 'blocker started after'],
                array_map(fn ($r) => [
                    $r['queue'],
                    $r['started'] !== null ? 'yes' : 'NO',
                    $r['started'] !== null ? round(($r['started'] - $dispatchedAt) * 1000).' ms' : '—',
                ], $rows)
            );

            $verdictOk = $allStarted;

            // Parallelism: every blocker must have been running at the same time as
            // the slowest-starting one. With one serial shared worker they would
            // start ~blockerSecs apart; in a correct topology all start within ~2s.
            if ($allStarted) {
                $starts = array_map(fn ($r) => $r['started'], $rows);
                $spread = max($starts) - min($starts);
                if ($spread < $blockerSecs) {
                    $this->info('✓ All queues ran in PARALLEL (start spread '.round($spread, 1).'s < blocker duration '.$blockerSecs.'s).');
                } else {
                    $this->error('✗ Queues SERIALIZED: blocker start spread '.round($spread, 1)."s ≥ blocker duration — a shared worker is serving multiple queues.");
                    $verdictOk = false;
                }
            }

            if ($probeStarted !== null && $probeFinished !== null) {
                $wait = $probeStarted - $probeDispatchedAt;
                // Standby = the probe STARTED strictly while the default blocker was
                // still sleeping. Compare against the blocker's actual finish
                // timestamp (cache), not duration arithmetic — a probe that queues
                // behind the blocker starts right AS it finishes, and duration math
                // can pass that by a few hundred ms (false "standby confirmed").
                $defaultBlockerFinished = Cache::get("queueprobe:{$blockers['default']}:finished");
                $blockerStillRunning = $defaultBlockerFinished !== null
                    && $probeStarted < ((float) $defaultBlockerFinished - 0.5);
                if ($blockerStillRunning) {
                    $this->info('✓ Import (default) probe ran in '.round($wait, 1).'s while the first import worker AND every other queue were busy — standby import worker confirmed.');
                } else {
                    $this->error('✗ Import probe waited '.round($wait, 1).'s — it queued behind the busy import worker (no standby worker on default).');
                    $verdictOk = false;
                }
            } else {
                $this->error('✗ Import probe never '.($probeStarted === null ? 'started' : 'finished').'.');
                $verdictOk = false;
            }

            $this->newLine();
            $verdictOk
                ? $this->info('TOPOLOGY OK — no job class can block another; imports have standby capacity.')
                : $this->error('TOPOLOGY BROKEN — see failures above.');

            return $verdictOk ? 0 : 1;
        } finally {
            $this->teardown($runId);
        }
    }

    /**
     * Spawn the reference dev topology: 2 import workers + 1 per other queue.
     * Mirrors package.json dev:all and deploy/supervisor/*.conf.
     */
    private function spawnTopology(): void
    {
        $spec = [
            'default', 'default',   // IMP1 + IMP2 (standby)
            'citation-pipeline',
            'vibe',
            'embeddings',
        ];
        foreach ($spec as $queue) {
            $p = new Process(
                ['php', 'artisan', 'queue:work', "--queue={$queue}", '--sleep=1', '--tries=1', '--timeout=300'],
                base_path()
            );
            $p->start();
            $this->workers[] = $p;
        }
        $this->info('Spawned reference topology: 2x default, 1x citation-pipeline, 1x vibe, 1x embeddings.');
        sleep(2); // let workers boot before dispatching
    }

    /** Poll a cache key until it appears or the absolute deadline passes. */
    private function awaitCache(string $key, float $deadline): ?float
    {
        while (microtime(true) < $deadline) {
            $v = Cache::get($key);
            if ($v !== null) {
                return (float) $v;
            }
            usleep(200_000);
        }
        return Cache::get($key);
    }

    private function teardown(string $runId): void
    {
        foreach ($this->workers as $p) {
            $p->stop(3); // SIGTERM, then SIGKILL after 3s
        }
        // Remove any probe jobs we left behind (aborted run / no worker on a
        // queue) so they don't sit reserved/pending for real workers to run.
        $deleted = DB::table('jobs')->where('payload', 'like', "%{$runId}-%")->delete();
        if ($deleted > 0) {
            $this->warn("Cleaned up {$deleted} leftover probe job(s).");
        }
    }
}
