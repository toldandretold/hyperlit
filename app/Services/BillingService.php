<?php

namespace App\Services;

use App\Models\BillingLedger;
use App\Models\User;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class BillingService
{
    /**
     * Charge a user (create a debit ledger entry).
     *
     * All tiers: logs real cost to ledger for usage tracking.
     * Pay-as-you-go: also increments users.debits (for balance gating).
     * Premium: skips debits increment (ledger-only) so balance stays clean on downgrade.
     */
    public function charge(
        User $user,
        float $amount,
        string $description,
        string $category,
        array $lineItems = [],
        ?array $metadata = null,
    ): BillingLedger {
        // NOTE: regeneration below runs after this transaction returns (i.e.
        // post-commit). If a caller ever wraps charge() in an outer
        // transaction, switch to DB::afterCommit() — today none do, and the
        // freshness guard in generateAccountBookIfNeeded self-heals any miss.
        $entry = DB::transaction(function () use ($user, $amount, $description, $category, $lineItems, $metadata) {
            DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);

            $user = User::lockForUpdate()->find($user->id);

            $multiplier = $user->getBillingMultiplier();

            $metadata = array_merge($metadata ?? [], [
                'raw_cost' => round($amount, 4),
                'multiplier' => $multiplier,
                'tier' => $user->status,
            ]);

            $chargedAmount = round($amount * $multiplier, 4);
            $isPremium = $user->status === 'premium';

            if (! $isPremium) {
                $user->increment('debits', $chargedAmount);
            }
            $user->refresh();

            return BillingLedger::create([
                'user_id' => $user->id,
                'type' => 'debit',
                'amount' => $chargedAmount,
                'description' => $description,
                'category' => $category,
                'line_items' => ! empty($lineItems) ? $lineItems : null,
                'metadata' => $metadata,
                'balance_after' => $user->balance,
            ]);
        });

        $this->refreshAccountBook($user->name);

        return $entry;
    }

    /**
     * Charge a user for the Mistral OCR of a book's PDF, exactly once. Shared
     * by the document-import job and the source harvester so both bill
     * identically.
     *
     * Idempotent via the ocr_charged.json marker (a job retry / reconvert-from-
     * cache never double-charges). FREE — returns 0.0 without charging — when:
     * the marker already exists; there's no ocr_response.json (a non-OCR lane,
     * e.g. JATS/HTML); or the OCR was client-side/native (model prefixed
     * 'hyperlit-' — the user's own key or the on-device engine, no Mistral call).
     *
     * RLS: charge() re-reads the user on the DEFAULT connection whose
     * users_select_policy needs BOTH app.current_user AND app.current_token. In
     * an HTTP request the middleware sets them; in a QUEUE WORKER the caller
     * must set both first (see GenerateBookAudioJob::chargeFor / HarvestRunner)
     * or the charge silently matches zero rows.
     *
     * @return float dollars actually debited (post-multiplier), or 0.0 if free.
     */
    /**
     * RAW per-1K-pages OCR cost (USD) for a served model id, BEFORE any tier multiplier.
     *
     * Keyed by the model recorded in ocr_response.json (services.llm.pricing) so each book is
     * billed at what its OCR actually cost — not a stale flat rate. Falls back to the configured
     * production model (services.mistral_ocr.model) when no served id is available (cost estimates,
     * pre-OCR previews). Never returns "free"; returns null only if pricing is entirely unset.
     */
    public static function ocrPricePerKPages(?string $servedModel): ?float
    {
        $pricing = config('services.llm.pricing', []);
        if ($servedModel !== null && isset($pricing[$servedModel]['per_1k_pages'])) {
            return (float) $pricing[$servedModel]['per_1k_pages'];
        }
        $default = config('services.mistral_ocr.model', 'mistral-ocr-2512');
        return isset($pricing[$default]['per_1k_pages']) ? (float) $pricing[$default]['per_1k_pages'] : null;
    }

    public function billOcrForBook(User $user, string $bookId, string $markdownPath, ?string $description = null): float
    {
        $chargedMarker = "{$markdownPath}/ocr_charged.json";
        if (File::exists($chargedMarker)) {
            Log::info('OCR already billed for this book — skipping charge', ['book' => $bookId]);
            return 0.0;
        }

        $ocrJson = "{$markdownPath}/ocr_response.json";
        if (!File::exists($ocrJson)) {
            return 0.0;
        }

        $ocrData = json_decode(File::get($ocrJson), true);

        // Belt-and-braces: client-side OCR (on-device engine or the user's own
        // Mistral key — both server-stamped with the 'hyperlit-' model prefix)
        // is never billed, even if the zero-charge marker write was somehow lost.
        if (str_starts_with($ocrData['model'] ?? '', 'hyperlit-')) {
            Log::info('Client-side OCR — nothing to bill', ['book' => $bookId]);
            return 0.0;
        }

        $totalPages = count($ocrData['pages'] ?? []);
        if ($totalPages <= 0) {
            return 0.0;
        }

        // Bill at what THIS book's OCR actually cost — keyed by the served model recorded in
        // ocr_response.json (falls back to the configured production model if absent).
        $perKPages = self::ocrPricePerKPages($ocrData['model'] ?? null);
        if (!$perKPages) {
            return 0.0;
        }

        $cost = $totalPages / 1000 * $perKPages;

        $entry = $this->charge(
            $user,
            round($cost, 4),
            $description ?: "PDF Import: {$bookId}",
            'ocr',
            [[
                'label' => "OCR ({$totalPages} pages)",
                'category' => 'ocr',
                'quantity' => $totalPages,
                'unit' => 'pages',
                'unit_cost' => $perKPages / 1000,
                'amount' => round($cost, 4),
            ]],
            ['book' => $bookId],
        );

        // Record that this OCR was billed so a job retry (or a reconvert-from-
        // cache, which re-uses ocr_response.json without a fresh OCR) never
        // double-charges.
        File::put($chargedMarker, json_encode([
            'book' => $bookId,
            'pages' => $totalPages,
            'amount' => round($cost, 4),
            'charged_at' => gmdate('c'),
        ], JSON_PRETTY_PRINT));

        return (float) $entry->amount;
    }

    /**
     * Check if a user can start an expensive operation.
     * Premium: always allowed. Pay-as-you-go: must have positive balance.
     */
    public function canProceed(User $user): bool
    {
        if ($user->status === 'premium') {
            return true;
        }

        return $user->balance > 0;
    }

    /**
     * Atomically reserve credits for an upcoming operation, preventing
     * concurrent requests from all passing a non-locking canProceed() check.
     *
     * Premium: always succeeds (no debit hold needed).
     * Pay-as-you-go: increments debits by $estimatedCost under a row lock
     * (lockForUpdate), creating a 'reservation' ledger entry. If the balance
     * after the hold is negative, the reservation is rolled back and null is
     * returned. The actual charge happens later via charge() — the reservation
     * is a temporary hold that ensures only one operation proceeds at a time.
     *
     * The hold is NOT the charge: whoever runs the reserved operation MUST call
     * releaseReservation() when it finishes (success, failure, or cancel) —
     * otherwise the user stays debited for the estimate ON TOP of the real
     * charge (the pre-2026-07 audiobook double-debit bug).
     *
     * Returns a BillingLedger entry on success, or null if insufficient balance.
     */
    public function reserveCredits(User $user, float $estimatedCost, string $description): ?BillingLedger
    {
        if ($user->status === 'premium') {
            // Premium users aren't charged per-use; no reservation needed.
            return null;
        }

        if ($estimatedCost <= 0) {
            return null;
        }

        try {
            return DB::transaction(function () use ($user, $estimatedCost, $description) {
                DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);

                $locked = User::lockForUpdate()->find($user->id);
                if ($locked->balance <= 0) {
                    return null;
                }

                $multiplier = $locked->getBillingMultiplier();
                $holdAmount = round($estimatedCost * $multiplier, 4);

                $locked->increment('debits', $holdAmount);
                $locked->refresh();

                return BillingLedger::create([
                    'user_id' => $locked->id,
                    'type' => 'debit',
                    'amount' => $holdAmount,
                    'description' => $description,
                    'category' => 'tts_reservation',
                    'metadata' => [
                        'reservation' => true,
                        'raw_cost' => round($estimatedCost, 4),
                        'multiplier' => $multiplier,
                        'tier' => $locked->status,
                    ],
                    'balance_after' => $locked->balance,
                ]);
            });
        } catch (\Throwable $e) {
            Log::warning('Credit reservation failed', [
                'user' => $user->name,
                'estimated_cost' => $estimatedCost,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }

    /**
     * Release a reservation hold created by reserveCredits(): give the debits
     * back and delete the hold's ledger row (a hold is a transient lock, not a
     * transaction — the REAL charge gets its own ledger entry via charge()).
     *
     * MUST be called once the reserved operation finishes, succeeds OR fails —
     * a leaked hold double-debits the user (hold + actual charge) forever.
     * Idempotent: a second call (or a bogus id) is a no-op. Only rows whose
     * metadata carries reservation=true are touched, so a real debit can never
     * be reversed through this path.
     *
     * RLS: same queue-worker caveat as charge() — the caller must have BOTH
     * app.current_user and app.current_token set or the row reads match nothing.
     */
    public function releaseReservation(User $user, ?string $reservationId): void
    {
        if (! $reservationId) {
            return;
        }

        try {
            $released = DB::transaction(function () use ($user, $reservationId) {
                DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);

                $locked = User::lockForUpdate()->find($user->id);
                $hold = BillingLedger::where('id', $reservationId)
                    ->where('user_id', $user->id)
                    ->where('type', 'debit')
                    ->lockForUpdate()
                    ->first();

                if (! $locked || ! $hold || ! ($hold->metadata['reservation'] ?? false)) {
                    return false;
                }

                $locked->decrement('debits', (float) $hold->amount);
                $hold->delete();

                return true;
            });

            if ($released) {
                $this->refreshAccountBook($user->name);
            }
        } catch (\Throwable $e) {
            Log::warning('Reservation release failed', [
                'user' => $user->name,
                'reservation_id' => $reservationId,
                'error' => $e->getMessage(),
            ]);
        }
    }

    /**
     * Add credits to a user.
     */
    public function addCredits(
        User $user,
        float $amount,
        string $description,
        string $category = 'topup',
        ?array $metadata = null,
    ): BillingLedger {
        // Post-commit regeneration — same outer-transaction caveat as charge().
        $entry = DB::transaction(function () use ($user, $amount, $description, $category, $metadata) {
            DB::statement("SELECT set_config('app.current_user', ?, true)", [$user->name]);

            $user = User::lockForUpdate()->find($user->id);

            $user->increment('credits', $amount);
            $user->refresh();

            return BillingLedger::create([
                'user_id' => $user->id,
                'type' => 'credit',
                'amount' => $amount,
                'description' => $description,
                'category' => $category,
                'metadata' => $metadata,
                'balance_after' => $user->balance,
            ]);
        });

        $this->refreshAccountBook($user->name);

        return $entry;
    }

    /**
     * Regenerate the user's pre-rendered Account book so the balance card and
     * ledger list reflect the mutation that just committed (and its library
     * timestamp bump makes clients refetch). Best-effort: a regen failure must
     * never fail the billing write itself — the freshness guard in
     * UserHomeServerController::generateAccountBookIfNeeded self-heals on the
     * next profile visit.
     */
    public function refreshAccountBook(string $username): void
    {
        try {
            app(\App\Http\Controllers\UserHomeServerController::class)->generateAccountBook($username);
        } catch (\Throwable $e) {
            Log::warning('Account book regeneration failed after billing mutation', [
                'username' => $username,
                'error' => $e->getMessage(),
            ]);
        }
    }

    public function getBalance(User $user): float
    {
        return $user->balance;
    }

    public function getLedger(User $user, ?int $limit = 50): Collection
    {
        return $user->ledgerEntries()
            ->orderByDesc('created_at')
            ->limit($limit)
            ->get();
    }
}
