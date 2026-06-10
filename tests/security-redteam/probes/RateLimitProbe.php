<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Verifies the brute-force / abuse throttles actually fire. The login route is
 * declared `throttle:20,1`; we send a burst of bad-credential logins and expect
 * to see a 429 before the burst ends. No 429 means an attacker can brute-force
 * passwords or spam the endpoint unbounded.
 *
 * Sends ~30 requests to a single rate-limited route. That's light load, but it
 * DOES consume the limiter window for the test IP, so it's flagged destructive
 * and only runs with --aggressive.
 */
class RateLimitProbe extends Probe
{
    public function name(): string
    {
        return 'Rate Limiting';
    }

    public function destructive(): bool
    {
        return true; // consumes the limiter window; mild but not read-only
    }

    public function run(): array
    {
        $findings = [];

        // login: throttle:20,1 → a 30-request burst must trip a 429.
        $saw429 = false;
        $sent   = 0;
        for ($i = 0; $i < 30; $i++) {
            $resp = $this->ctx->anon->postJson('/api/login', [
                'email'    => 'nobody+' . $i . '@redteam.local',
                'password' => 'wrong-' . $i,
            ]);
            $sent++;
            if ($resp->status === 429) {
                $saw429 = true;
                break;
            }
        }

        if ($saw429) {
            $findings[] = $this->safe('Login throttle fires', "Got HTTP 429 after $sent rapid login attempts.", 'POST /api/login');
        } else {
            $findings[] = $this->vuln(
                'Login endpoint not rate-limited',
                Finding::MEDIUM,
                "Sent $sent rapid failed logins without ever seeing a 429 — credential brute-force is unbounded.",
                'POST /api/login',
                "attempts=$sent, no 429 observed",
                'Confirm `throttle:20,1` is applied and the limiter store (cache/db) is reachable in this environment.'
            );
        }

        return $findings;
    }
}
