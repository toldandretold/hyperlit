<?php

namespace App\Jobs;

use App\Services\Licensing\LicenseDiscovery;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Log;

/**
 * Queued, time-boxed `library:discover-licenses --apply`. On `citation-pipeline` (the long
 * external-API sweep lane — never `default`, where it would sit in front of user imports).
 *
 * The daily schedule runs it with a modest limit so newly minted Unknown rows get looked at.
 * For the one-off backfill dispatch it with `chain: true`: it re-dispatches itself while rows
 * remain in scope, and stops chaining if a source went down (exit code 2) rather than burning
 * through the backlog stamping rows that source never answered.
 */
class DiscoverLicensesJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600;

    public int $tries = 1;

    public function __construct(
        private int $limit = 2000,
        private string $scope = 'all',
        private bool $chain = false,
        private int $maxSeconds = 3300,
    ) {
        $this->onQueue('citation-pipeline');
    }

    public function handle(): void
    {
        $exit = Artisan::call('library:discover-licenses', [
            '--apply' => true,
            '--limit' => $this->limit,
            '--scope' => $this->scope,
            '--max-seconds' => $this->maxSeconds,
        ]);
        Log::info('DiscoverLicensesJob finished', ['exit' => $exit, 'scope' => $this->scope, 'output' => mb_substr(Artisan::output(), -2000)]);

        if ($this->chain && $exit === 0 && LicenseDiscovery::candidateBooks($this->scope, [], true, 1) !== []) {
            self::dispatch($this->limit, $this->scope, true, $this->maxSeconds)->delay(now()->addMinute());
        }
    }
}
