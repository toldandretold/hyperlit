<?php

namespace App\Jobs;

use App\Models\User;
use App\Services\BillingService;
use App\Services\LlmService;
use App\Services\Translation\BookTranslationService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * "Translate this book": translates a book into a new private copy for the
 * requester, who pays for the tokens actually used (see BookTranslationService
 * for what the copy is and why).
 *
 * Shaped like GenerateBookAudioJob, for the same reasons:
 *   - its own `translation` queue, so an hour-long book can't block imports
 *     (REQUIRES a worker on that queue: `npm run queue:translation`);
 *   - never auto-retried; it hands off to a fresh job before its timeout,
 *     because being killed at the timeout skips finally/failed() and strands
 *     the lock and the credit hold. The translation cache makes a hand-off
 *     (or a re-press after a failure) cost nothing for what's already done;
 *   - charged per run for the tokens that run used, with BOTH RLS settings
 *     in place (a worker has no HTTP middleware to set app.current_token).
 */
class TranslateBookJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    /** Fixed for the in-app feature, whatever TRANSLATION_HTML_MODEL says. */
    public const MODEL = 'accounts/fireworks/models/kimi-k3';

    public int $timeout = 3600;

    public int $tries = 1;

    /** Stop starting new batches after this long, well inside $timeout. */
    private const WORK_BUDGET_SECONDS = 3000;

    public function __construct(
        private string $bookId,
        private int $userId,
        private string $target,
        // The hold the start endpoint placed (null for premium) — released in
        // finally/failed(); the actual charge replaces the estimate.
        private ?string $reservationId = null,
    ) {
        $this->onQueue('translation');
    }

    public function handle(BookTranslationService $service, LlmService $llm): void
    {
        $started = microtime(true);
        $lock = Cache::lock(BookTranslationService::lockKey($this->bookId, $this->target, $this->userId), 3900);
        $lock->get(); // a continuation re-takes the lock its parent released

        $user = User::on('pgsql_admin')->find($this->userId);
        if (! $user) {
            $lock->forceRelease();

            return;
        }

        config([
            'services.translation.html.model' => self::MODEL,
            'services.translation.html.reasoning_effort' => 'low',
        ]);
        $llm->resetUsageStats();
        $service->writeProgress($this->bookId, $this->target, $this->userId, ['status' => 'running', 'error' => null]);

        $continuing = false;
        try {
            $outcome = $service->run(
                $this->bookId,
                $this->target,
                $user,
                deadline: $started + self::WORK_BUDGET_SECONDS,
                onProgress: fn (array $p) => $service->writeProgress($this->bookId, $this->target, $this->userId, [
                    'status' => 'running', 'phase' => $p['phase'], 'percent' => round($p['percent'], 3),
                ]),
            );

            match ($outcome['status']) {
                'done' => $service->writeProgress($this->bookId, $this->target, $this->userId, [
                    'status' => 'done', 'percent' => 1, 'new_book' => $outcome['book'],
                ]),
                'failed' => $service->writeProgress($this->bookId, $this->target, $this->userId, [
                    'status' => 'failed', 'error' => $outcome['message'],
                ]),
                'continue' => null,
            };

            if ($outcome['status'] === 'continue') {
                $continuing = true;
                self::dispatch($this->bookId, $this->userId, $this->target);
            }
        } finally {
            $this->charge($user, $llm->getUsageStats());
            $this->releaseReservation($user);
            if (! $continuing) {
                $lock->forceRelease();
            }
        }
    }

    public function failed(\Throwable $e): void
    {
        Log::error('TranslateBookJob failed', ['book' => $this->bookId, 'target' => $this->target, 'error' => $e->getMessage()]);
        $user = User::on('pgsql_admin')->find($this->userId);
        if ($user) {
            $this->releaseReservation($user);
        }
        Cache::lock(BookTranslationService::lockKey($this->bookId, $this->target, $this->userId))->forceRelease();
        app(BookTranslationService::class)->writeProgress($this->bookId, $this->target, $this->userId, [
            'status' => 'failed',
            'error' => 'Translation stopped unexpectedly. Press Translate again to pick up where it left off.',
        ]);
    }

    private function charge(User $user, array $usage): void
    {
        $cost = BookTranslationService::costOf($usage);
        if ($cost <= 0) {
            return;
        }

        $this->asUser($user, fn () => app(BillingService::class)->charge(
            $user,
            $cost,
            'Book translation: '.$this->bookId.' → '.$this->target,
            'translation',
            [],
            ['book_id' => $this->bookId, 'target_lang' => $this->target, 'model' => self::MODEL],
        ));
    }

    private function releaseReservation(User $user): void
    {
        if ($this->reservationId === null) {
            return;
        }
        $this->asUser($user, fn () => app(BillingService::class)->releaseReservation($user, $this->reservationId));
        $this->reservationId = null; // idempotent across finally + failed()
    }

    /** Run $work with the RLS context an HTTP request would have had. */
    private function asUser(User $user, \Closure $work): void
    {
        DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
        DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
        try {
            $work();
        } finally {
            DB::statement("SELECT set_config('app.current_user', '', false)");
            DB::statement("SELECT set_config('app.current_token', '', false)");
        }
    }
}
