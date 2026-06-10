<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Can an attacker tell whether a given email/username is registered? That turns
 * a password-spray or phishing list from a guess into a targeted one. Two
 * surfaces:
 *   - forgot-password: should return an identical generic response for known and
 *     unknown emails (the secure pattern).
 *   - register: a "that email is already taken" validation error inherently
 *     confirms existence. Common and often-accepted, but worth recording.
 *
 * Uses the attacker's own (known-registered) email as the positive case and a
 * random address as the negative — no new accounts created.
 */
class UserEnumerationProbe extends Probe
{
    public function name(): string
    {
        return 'User Enumeration';
    }

    public function run(): array
    {
        if (!$this->ctx->accountsReady || empty($this->ctx->attackerCreds['email'])) {
            return [$this->inconclusive('Enumeration suite skipped', 'Need a known-registered account to compare against.')];
        }

        $known   = $this->ctx->attackerCreds['email'];
        $unknown = 'noone_' . bin2hex(random_bytes(5)) . '@redteam.local';
        $findings = [];

        // --- forgot-password differential ---
        $rKnown   = $this->ctx->anon->postJson('/api/password/forgot', ['email' => $known]);
        $rUnknown = $this->ctx->anon->postJson('/api/password/forgot', ['email' => $unknown]);

        $sameStatus = $rKnown->status === $rUnknown->status;
        $sameBody   = $this->normalise($rKnown->body) === $this->normalise($rUnknown->body);
        if ($sameStatus && $sameBody) {
            $findings[] = $this->safe(
                'Forgot-password does not leak account existence',
                "Known and unknown emails both returned HTTP {$rKnown->status} with an identical generic body.",
                'POST /api/password/forgot'
            );
        } else {
            $findings[] = $this->vuln(
                'Forgot-password reveals whether an email is registered',
                Finding::MEDIUM,
                'The response differs between a registered and an unregistered email, so an attacker can enumerate valid accounts.',
                'POST /api/password/forgot',
                "known:   HTTP {$rKnown->status} {$rKnown->snippet(80)}\nunknown: HTTP {$rUnknown->status} {$rUnknown->snippet(80)}",
                'Return an identical generic response ("if that email exists, a link was sent") for both cases.'
            );
        }

        // --- register differential (informational) ---
        $reg = $this->ctx->anon->postJson('/api/register', [
            'name'                  => 'rtdup_' . bin2hex(random_bytes(3)),
            'email'                 => $known,           // already registered
            'password'              => 'Whatever!123Aa',
            'password_confirmation' => 'Whatever!123Aa',
        ]);
        if ($reg->status === 422 && stripos($reg->body, 'already') !== false) {
            $findings[] = $this->vuln(
                'Registration confirms an email is already in use',
                Finding::LOW,
                'Registering with an existing email returns a 422 "already registered" error, confirming the account exists. '
                . 'Common and often accepted, but it is an enumeration vector.',
                'POST /api/register',
                "HTTP {$reg->status}: {$reg->snippet(120)}",
                'If enumeration matters, return a neutral "check your email to continue" and verify ownership out-of-band.'
            );
        } else {
            $findings[] = $this->safe('Registration does not obviously confirm existence', "Duplicate-email register returned HTTP {$reg->status}.", 'POST /api/register');
        }

        return $findings;
    }

    private function normalise(string $body): string
    {
        // Strip any per-request tokens/whitespace so only the message shape matters.
        return preg_replace('/[a-f0-9]{16,}/i', 'X', trim(preg_replace('/\s+/', ' ', $body) ?? '')) ?? $body;
    }
}
