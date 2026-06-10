<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * The Stripe webhook (`POST /api/stripe/webhook`) is unauthenticated by design —
 * Stripe calls it directly — and credits a user's balance on
 * `checkout.session.completed`. The ONLY thing standing between an attacker and
 * free credits is the Stripe signature check. This probe forges a
 * `checkout.session.completed` event (with `metadata.user_id` = the attacker)
 * and sends it with a missing / bogus signature. A correctly-built handler must
 * reject it with 400 and grant nothing.
 *
 * Confirmed by white-box review to use `Webhook::constructEvent()` — this is the
 * live proof. Non-destructive in effect: if the defense holds (it should) no
 * credit is granted; we verify the attacker's balance is unchanged either way.
 */
class WebhookForgeryProbe extends Probe
{
    public function name(): string
    {
        return 'Stripe Webhook Forgery';
    }

    public function run(): array
    {
        $userId = $this->ctx->accountsReady
            ? ($this->fetchAttackerId() ?? '1')
            : '1';

        $forged = json_encode([
            'id'      => 'evt_redteam_forged',
            'object'  => 'event',
            'type'    => 'checkout.session.completed',
            'data'    => ['object' => [
                'id'       => 'cs_test_redteam_forged',
                'object'   => 'checkout.session',
                'metadata' => ['user_id' => $userId, 'credit_amount' => 999999],
            ]],
        ]);

        $findings = [];
        $before = $this->ctx->accountsReady ? $this->balance() : null;

        // 1) No signature header at all.
        $noSig = $this->ctx->anon->send('POST', '/api/stripe/webhook', $forged, ['Content-Type' => 'application/json']);
        // 2) Bogus signature header.
        $badSig = $this->ctx->anon->send('POST', '/api/stripe/webhook', $forged, [
            'Content-Type'     => 'application/json',
            'Stripe-Signature' => 't=1700000000,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        ]);

        $after = $this->ctx->accountsReady ? $this->balance() : null;

        $rejected = $noSig->status === 400 && $badSig->status === 400;
        $credited = $before !== null && $after !== null && $after > $before;

        if ($credited) {
            $findings[] = $this->vuln(
                'Forged Stripe webhook granted credits',
                Finding::CRITICAL,
                "A forged checkout.session.completed event (no valid signature) increased a balance from $before to $after. Signature verification is missing or bypassable.",
                'POST /api/stripe/webhook',
                "no-sig status={$noSig->status}, bad-sig status={$badSig->status}, balance $before → $after",
                'Verify every webhook with Webhook::constructEvent() against the signing secret; reject on SignatureVerificationException.'
            );
        } elseif ($rejected) {
            $findings[] = $this->safe(
                'Webhook rejects forged/unsigned events',
                "Both an unsigned and a bogus-signature forged event returned HTTP 400; no credit granted.",
                'POST /api/stripe/webhook'
            );
        } else {
            $findings[] = $this->inconclusive(
                'Webhook forgery inconclusive',
                "Forged events returned no-sig={$noSig->status} / bad-sig={$badSig->status} (expected 400) and no balance change — verify the handler/secret config.",
                'POST /api/stripe/webhook'
            );
        }

        return $findings;
    }

    private function fetchAttackerId(): ?string
    {
        $json = $this->ctx->attacker->get('/api/auth-check')->json();
        return (is_array($json) && isset($json['user']['id'])) ? (string) $json['user']['id'] : null;
    }

    private function balance(): ?float
    {
        $json = $this->ctx->attacker->get('/api/billing/balance')->json();
        if (!is_array($json)) {
            return null;
        }
        foreach (['balance', 'credits', 'available', 'amount'] as $k) {
            if (isset($json[$k]) && is_numeric($json[$k])) {
                return (float) $json[$k];
            }
        }
        return null;
    }
}
