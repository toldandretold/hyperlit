<?php

namespace App\Services\SourceHarvest;

use App\Models\User;
use App\Services\BillingService;
use Illuminate\Support\Facades\DB;

/**
 * The one place that charges a harvest owner for a work's Mistral OCR outside
 * an HTTP request. Extracted from HarvestRunner so the journal-level harvest
 * shares it instead of re-copying the RLS dance.
 *
 * Mirrors GenerateBookAudioJob::chargeFor: BillingService::charge() re-reads
 * the user on the DEFAULT connection whose users_select_policy needs BOTH
 * app.current_user AND app.current_token. In a queue worker or artisan command
 * (no HTTP session) both must be set — or the charge silently matches zero
 * rows. This exact half-copy shipped twice; do not inline a third.
 */
class WorkOcrCharger
{
    /**
     * Charge $user for one work's OCR, returning the dollars debited
     * (0 for anonymous owners, native/BYO OCR, and non-OCR lanes).
     */
    public function charge(?User $user, string $bookId, ?string $description = null): float
    {
        if (!$user) {
            return 0.0;
        }

        DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
        DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
        try {
            return app(BillingService::class)->billOcrForBook(
                $user,
                $bookId,
                resource_path("markdown/{$bookId}"),
                $description ?? "Harvest OCR: {$bookId}",
            );
        } finally {
            DB::statement("SELECT set_config('app.current_user', '', false)");
            DB::statement("SELECT set_config('app.current_token', '', false)");
        }
    }
}
