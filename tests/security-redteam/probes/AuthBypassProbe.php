<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Confirms the front door is locked: every endpoint that should require auth is
 * hit by a fresh anonymous client, and we expect a 401/403/redirect — NOT a 200
 * with data. A 200 here means the auth middleware is missing or bypassable.
 *
 * Also checks the admin-only surface: a normal logged-in (non-admin) attacker
 * must NOT be able to reach the `admin` middleware routes.
 */
class AuthBypassProbe extends Probe
{
    public function name(): string
    {
        return 'Auth & Access Control';
    }

    public function run(): array
    {
        $findings = [];

        // --- Endpoints that must reject anonymous callers ---
        // method, path, body
        $protected = [
            ['GET',  '/api/billing/balance', null],
            ['GET',  '/api/billing/ledger', null],
            ['GET',  '/api/user/preferences', null],
            ['POST', '/api/user/preferences', ['theme' => 'dark']],
            ['GET',  '/api/vibes/mine', null],
            ['POST', '/api/ai-brain/query', ['query' => 'x']],
            ['POST', '/api/citation-scanner/scan', ['book' => 'x']],
            ['GET',  '/api/shelves/', null],
            ['POST', '/api/billing/credits', ['amount' => 1000]],
            ['POST', '/api/billing/tier', ['tier' => 'premium']],
            ['POST', '/api/vibe-css/generate', ['prompt' => 'x']],
        ];

        foreach ($protected as [$method, $path, $body]) {
            $this->ctx->anon->resetSession();
            $this->ctx->anon->primeCsrf('/');
            $resp = $body === null
                ? $this->ctx->anon->send($method, $path)
                : $this->ctx->anon->postJson($path, $body);

            // 401/403/419(CSRF)/redirect-to-login are all "correctly rejected".
            $rejected = in_array($resp->status, [401, 403, 419], true)
                || ($resp->status >= 300 && $resp->status < 400);

            if ($rejected) {
                $findings[] = $this->safe(
                    "Anonymous blocked: $method $path",
                    "Returned HTTP {$resp->status} to an unauthenticated request.",
                    "$method $path"
                );
            } elseif ($resp->status === 200) {
                $findings[] = $this->vuln(
                    "Auth bypass: $method $path served anonymously",
                    Finding::HIGH,
                    'A protected endpoint returned HTTP 200 to a request with no authentication. '
                    . 'The auth middleware is missing or not enforced.',
                    "$method $path",
                    $resp->snippet(220),
                    'Wrap this route in `auth:sanctum` (and `author`/`admin` as appropriate).'
                );
            } else {
                $findings[] = $this->inconclusive(
                    "Unexpected status for $method $path",
                    "Returned HTTP {$resp->status} (not a clean 401/403, not 200) — verify by hand.",
                    "$method $path"
                );
            }
        }

        // --- Admin surface must reject a normal authenticated attacker ---
        if ($this->ctx->accountsReady) {
            $adminRoutes = [
                ['POST', '/api/conversion-tests/run', []],
                ['POST', '/api/conversion-tests/add-fixture', []],
            ];
            foreach ($adminRoutes as [$method, $path, $body]) {
                $resp = $this->ctx->attacker->postJson($path, $body);
                if (in_array($resp->status, [401, 403], true)) {
                    $findings[] = $this->safe(
                        "Admin route blocked for non-admin: $path",
                        "Returned HTTP {$resp->status} to a normal logged-in user.",
                        "$method $path"
                    );
                } elseif ($resp->status === 200) {
                    $findings[] = $this->vuln(
                        "Privilege escalation: non-admin reached admin route $path",
                        Finding::CRITICAL,
                        'A normal authenticated user (no admin role) got HTTP 200 from an `admin`-gated route.',
                        "$method $path",
                        $resp->snippet(220),
                        'Verify the `admin` middleware checks an admin flag/role and is actually applied.'
                    );
                } else {
                    $findings[] = $this->inconclusive(
                        "Admin route $path returned {$resp->status}",
                        'Not a clean 403 — confirm the admin gate manually.',
                        "$method $path"
                    );
                }
            }
        }

        return $findings;
    }
}
