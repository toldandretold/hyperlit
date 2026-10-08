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
        $service->record($this->bookId, $this->target, $this->userId,
            ['status' => 'running', 'error' => null],
            stage: 'queued', stagePatch: ['status' => 'completed'],
            event: ['stage' => 'queued', 'status' => 'completed', 'detail' => 'Picked up by the translation worker']);

        $continuing = false;
        try {
            $outcome = $service->run(
                $this->bookId,
                $this->target,
                $user,
                deadline: $started + self::WORK_BUDGET_SECONDS,
                onProgress: fn (array $p) => $this->recordProgress($service, $p),
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
                $stage = $service->readProgress($this->bookId, $this->target, $this->userId)['stage'] ?? 'text';
                $service->record($this->bookId, $this->target, $this->userId, [], stage: $stage, event: [
                    'stage' => $stage, 'status' => 'progress',
                    'detail' => 'Handing off to a fresh worker — everything translated so far is kept',
                ]);
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
        $service = app(BookTranslationService::class);
        $stage = $service->readProgress($this->bookId, $this->target, $this->userId)['stage'] ?? 'queued';
        $service->record($this->bookId, $this->target, $this->userId, [
            'status' => 'failed',
            'error' => 'Translation stopped unexpectedly. Press Translate again to pick up where it left off.',
        ], stage: $stage, stagePatch: ['status' => 'failed'], event: [
            'stage' => $stage, 'status' => 'failed', 'detail' => 'The run stopped unexpectedly',
        ]);
    }

    /**
     * Fold a translator progress payload ({phase, percent, event}) into
     * progress.json: percent + a latest-state patch of the stage map on every
     * batch (O(1) overwrite), a boundary EVENT only at section edges — never
     * per batch, or a long book floods the bounded log.
     */
    private function recordProgress(BookTranslationService $service, array $p): void
    {
        $fields = ['status' => 'running', 'phase' => $p['phase']];
        if (($p['percent'] ?? null) !== null) {
            $fields['percent'] = round($p['percent'], 3);
        }

        $event = $p['event'] ?? null;
        $patch = ['status' => 'progress'];
        $boundary = null;
        if (($event['type'] ?? null) === 'batch') {
            $patch += [
                'section' => $event['section'] ?? null,
                'sections' => $event['sections'] ?? null,
                'chars_done' => $event['done'] ?? null,
                'chars_total' => $event['total'] ?? null,
            ];
            if (($event['retried'] ?? 0) > 0) {
                $patch['retried'] = $event['retried'];
            }
        } elseif (($event['type'] ?? null) === 'section') {
            $title = trim((string) ($event['title'] ?? ''));
            $patch += [
                'section' => $event['section'] ?? null,
                'sections' => $event['sections'] ?? null,
                'title' => $title !== '' ? $title : null,
                'paragraphs' => $event['paragraphs'] ?? null,
            ];
            $boundary = [
                'stage' => $p['phase'], 'status' => 'progress',
                'detail' => "Section {$event['section']}/{$event['sections']}".($title !== '' ? ": {$title}" : ''),
            ];
        } elseif (($event['type'] ?? null) === 'section_done') {
            $boundary = [
                'stage' => $p['phase'], 'status' => 'progress',
                'detail' => "Section {$event['section']}/{$event['sections']} finished",
            ];
        }

        $service->record($this->bookId, $this->target, $this->userId, $fields,
            stage: $p['phase'], stagePatch: $patch, event: $boundary);
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
            $this->usageLineItems($usage),
            [
                'book_id' => $this->bookId,
                'target_lang' => $this->target,
                'model' => self::MODEL,
                'requests' => (int) ($usage['total_requests'] ?? 0),
                'failed_requests' => (int) ($usage['failed_requests'] ?? 0),
            ],
        ));
    }

    /**
     * The run's real token usage, recorded on the ledger row.
     *
     * It was being thrown away: `charge()` received the full usage stats and
     * passed `[]`, so translation was the only paid feature whose
     * `billing_ledger.line_items` was NULL. That is why the in-app estimate
     * could sit at ~3x actual for months with nothing to calibrate against —
     * `raw_cost` alone cannot tell you whether a quote missed on characters,
     * on request count, or on output tokens. Every run is now a data point for
     * services.translation.html.estimate.
     *
     * Same shape as CitationReviewCommand::billReview's LLM items, so
     * ClaimsJoiner::billing()-style readers (which sum `meta.prompt_tokens`)
     * work unchanged.
     *
     * @return array<int, array<string, mixed>>
     */
    private function usageLineItems(array $usage): array
    {
        $pricing = config('services.llm.pricing', []);
        $items = [];

        foreach ($usage['by_model'] ?? [] as $model => $tokens) {
            $rate = $pricing[$model] ?? null;
            if (! $rate || ! isset($rate['input'], $rate['output'])) {
                continue; // costOf() already logs the missing-pricing case
            }
            $prompt = (int) ($tokens['prompt_tokens'] ?? 0);
            $completion = (int) ($tokens['completion_tokens'] ?? 0);
            $total = $prompt + $completion;
            $cost = ($prompt / 1_000_000 * $rate['input']) + ($completion / 1_000_000 * $rate['output']);

            $items[] = [
                'label' => basename($model).' ('.number_format($total).' tokens)',
                'category' => 'llm',
                'quantity' => $total,
                'unit' => 'tokens',
                'unit_cost' => $total > 0 ? round($cost / $total, 8) : 0,
                'amount' => round($cost, 4),
                'meta' => [
                    'model' => $model,
                    'prompt_tokens' => $prompt,
                    'completion_tokens' => $completion,
                    'requests' => (int) ($tokens['requests'] ?? 0),
                ],
            ];
        }

        return $items;
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
