<?php

namespace App\Services\Billing;

use Illuminate\Support\Facades\Log;
use Stripe\StripeClient;

/**
 * Thin, mockable seam over "ask Stripe about a checkout session". The
 * reconciliation sweep depends on this rather than newing a StripeClient inline
 * so tests can bind a fake and drive paid/expired/unpaid outcomes without
 * touching the network.
 *
 * Returns the raw Stripe session object (it exposes ->payment_status and
 * ->status), or null when the session can't be fetched (network/not-found) —
 * the caller treats null as "unknown, try again next sweep".
 */
class StripeSessionGateway
{
    public function retrieve(string $sessionId): ?object
    {
        try {
            $stripe = new StripeClient(config('services.stripe.secret'));

            return $stripe->checkout->sessions->retrieve($sessionId);
        } catch (\Throwable $e) {
            Log::warning('Stripe checkout session retrieve failed', [
                'session_id' => $sessionId,
                'error'      => $e->getMessage(),
            ]);

            return null;
        }
    }
}
