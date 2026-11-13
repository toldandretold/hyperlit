<?php

namespace App\Services\Hypercites;

use App\Models\User;
use App\Services\BillingService;
use App\Services\LlmService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Requester-pays metering for the bibliography scans a hypercite detect run performs.
 *
 * Detection itself is free (string matching over text we already hold). The cost is the
 * step before it: a citing book whose bibliography was never resolved gets
 * `citation:scan-bibliography`, which is LLM extraction plus external lookups — minutes and
 * real money per book. From the admin console that is the platform's own corpus work and
 * stays unbilled; from the shelf-owner workbench it is a paid feature like any other, so it
 * follows the house rule: raw metered cost, charged AFTER the scan succeeded, never for a
 * failed one.
 *
 * Usage is read off the LlmService singleton, which the scan command shares because the
 * detector runs it in-process (Artisan::call) — begin() zeroes the counters, charge() reads
 * them. Only LLM tokens are metered; the external lookups (OpenAlex, Crossref) are free.
 *
 * QUEUE-WORKER GOTCHA (docs/billing.md — it shipped broken twice): a worker has no request,
 * so there are no RLS session vars. The charge must set BOTH `app.current_user` and
 * `app.current_token`, and RESTORE what was there, or BillingService's writes silently
 * no-op / leak identity into the next job on the same worker.
 */
class ScanBilling
{
    public const CATEGORY = 'bibliography_scan';

    private float $charged = 0.0;

    public function __construct(
        private User $payer,
        private string $scopeLabel,
        private LlmService $llm,
        private BillingService $billing,
    ) {}

    /** Load the payer over the admin connection (RLS hides `users` from a worker). */
    public static function forRun(object $run, string $scopeLabel): ?self
    {
        $payer = $run->user_id ? User::on('pgsql_admin')->find($run->user_id) : null;

        return $payer
            ? new self($payer, $scopeLabel, app(LlmService::class), app(BillingService::class))
            : null;
    }

    /**
     * May another scan START? Re-read per scan: a long run can spend a pay-as-you-go
     * balance down to nothing, and it must stop scanning there rather than run the
     * account negative book after book.
     */
    public function canAffordScan(): bool
    {
        $fresh = User::on('pgsql_admin')->find($this->payer->id);

        return $fresh !== null && $this->billing->canProceed($fresh);
    }

    public function begin(): void
    {
        $this->llm->resetUsageStats();
    }

    /** Charge the scan that just SUCCEEDED for $book. Returns the raw cost charged. */
    public function chargeFor(string $book): float
    {
        $usage = $this->llm->getUsageStats();
        $items = $this->lineItems($usage);
        $cost = array_sum(array_column($items, 'amount'));
        if ($cost <= 0) {
            return 0.0;
        }

        try {
            $this->asPayer(fn () => $this->billing->charge(
                $this->payer,
                $cost,
                "Bibliography scan for hypercite detection ({$this->scopeLabel}): {$book}",
                self::CATEGORY,
                $items,
                [
                    'book_id'  => $book,
                    'requests' => (int) ($usage['total_requests'] ?? 0),
                ],
            ));
            $this->charged += $cost;
        } catch (\Throwable $e) {
            // The scan's results are already saved; losing the charge is the lesser
            // failure, but it must be loud — a silent no-op here is free usage.
            Log::error('ScanBilling: charge failed', [
                'user' => $this->payer->id, 'book' => $book, 'cost' => $cost, 'error' => $e->getMessage(),
            ]);
        }

        return $cost;
    }

    /** Raw cost charged by this instance so far (one detect slice). */
    public function charged(): float
    {
        return round($this->charged, 4);
    }

    /**
     * Same shape as the other LLM-metered features' ledger line items, so readers that
     * sum `meta.prompt_tokens` work unchanged.
     *
     * @return array<int, array<string, mixed>>
     */
    private function lineItems(array $usage): array
    {
        $pricing = config('services.llm.pricing', []);
        $items = [];

        foreach ($usage['by_model'] ?? [] as $model => $tokens) {
            $rate = $pricing[$model] ?? null;
            if (! $rate || ! isset($rate['input'], $rate['output'])) {
                Log::warning('ScanBilling: no pricing entry for model — usage uncounted', ['model' => $model]);

                continue;
            }
            $prompt = (int) ($tokens['prompt_tokens'] ?? 0);
            $completion = (int) ($tokens['completion_tokens'] ?? 0);
            $total = $prompt + $completion;
            $cost = ($prompt / 1_000_000 * $rate['input']) + ($completion / 1_000_000 * $rate['output']);

            $items[] = [
                'label'     => basename($model) . ' (' . number_format($total) . ' tokens)',
                'category'  => 'llm',
                'quantity'  => $total,
                'unit'      => 'tokens',
                'unit_cost' => $total > 0 ? round($cost / $total, 8) : 0,
                'amount'    => round($cost, 4),
                'meta'      => [
                    'model'             => $model,
                    'prompt_tokens'     => $prompt,
                    'completion_tokens' => $completion,
                    'requests'          => (int) ($tokens['requests'] ?? 0),
                ],
            ];
        }

        return $items;
    }

    private function asPayer(\Closure $work): void
    {
        $before = DB::selectOne(
            "SELECT current_setting('app.current_user', true) AS u, current_setting('app.current_token', true) AS t"
        );
        DB::statement("SELECT set_config('app.current_user', ?, false)", [$this->payer->name]);
        DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $this->payer->user_token]);
        try {
            $work();
        } finally {
            DB::statement("SELECT set_config('app.current_user', ?, false)", [(string) ($before->u ?? '')]);
            DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) ($before->t ?? '')]);
        }
    }
}
