<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\Cache;

/**
 * Synthetic stand-in job for `queue:probe` (QueueTopologyProbeCommand) — sleeps
 * for a given duration on a given queue and records its start/finish timestamps
 * in the cache, so the probe can measure who blocked whom WITHOUT running real
 * imports/citation pipelines. Not dispatched by any production code path.
 */
class QueueProbeSleepJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $tries = 1;

    public int $timeout = 300;

    public function __construct(
        public string $probeId,
        public int $sleepSeconds,
    ) {}

    public function handle(): void
    {
        Cache::put("queueprobe:{$this->probeId}:started", microtime(true), 600);
        sleep($this->sleepSeconds);
        Cache::put("queueprobe:{$this->probeId}:finished", microtime(true), 600);
    }
}
