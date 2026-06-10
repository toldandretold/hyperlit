<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * The Stripe checkout endpoint accepts a `return_url` validated only as
 * `sometimes|string|max:2048` (no `url`/`starts_with`), then concatenates it
 * straight into the Stripe session `success_url`/`cancel_url`. An attacker can
 * therefore steer the post-payment redirect to an arbitrary domain — a phishing
 * primitive ("pay, then get bounced to evil.com that looks like us").
 *
 * Confirmed by white-box review (StripeController::createCheckoutSession). This
 * probe verifies it live: it requests a checkout with an external return_url and
 * checks whether the returned checkout_url / session was created without
 * rejecting the foreign domain.
 *
 * Destructive flag: creating a checkout session makes a real (test-mode) Stripe
 * API call, so only run under --aggressive.
 */
class OpenRedirectProbe extends Probe
{
    public function name(): string
    {
        return 'Open Redirect (Stripe return_url)';
    }

    public function destructive(): bool
    {
        return true; // creates a real Stripe Checkout session
    }

    public function run(): array
    {
        if (!$this->ctx->accountsReady) {
            return [$this->inconclusive('Open-redirect check skipped', 'Attacker account could not be provisioned (checkout needs auth).')];
        }

        $evil = 'https://evil-redteam.example/phish';
        $resp = $this->ctx->attacker->postJson('/api/billing/checkout', [
            'amount'     => 5,
            'return_url' => $evil,
        ]);

        // A validation error (422) on the foreign URL is the desired behaviour.
        if ($resp->status === 422) {
            return [$this->safe(
                'Checkout return_url validated',
                'An external return_url was rejected with HTTP 422 — the redirect target is constrained.',
                'POST /api/billing/checkout'
            )];
        }

        // If Stripe accepted it, the session was built with our evil success_url.
        $json = $resp->json();
        $checkoutUrl = is_array($json) ? ($json['checkout_url'] ?? '') : '';
        if ($resp->ok() && $checkoutUrl) {
            return [$this->vuln(
                'Open redirect via Stripe checkout return_url',
                Finding::HIGH,
                "The checkout endpoint accepted an external `return_url` ($evil) with no domain validation; "
                . 'it is concatenated into the Stripe success_url/cancel_url, so the user is redirected off-site after payment.',
                'POST /api/billing/checkout',
                "return_url=$evil\nresponse checkout_url=$checkoutUrl",
                'Validate `return_url` as `url` and `starts_with:` your app URL (or accept only a relative path and rebuild the absolute URL server-side).'
            )];
        }

        return [$this->inconclusive(
            'Open-redirect check inconclusive',
            "Checkout returned HTTP {$resp->status} (Stripe key/config may be absent in this env): {$resp->snippet(120)}",
            'POST /api/billing/checkout'
        )];
    }
}
