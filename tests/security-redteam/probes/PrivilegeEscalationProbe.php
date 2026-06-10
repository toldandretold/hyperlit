<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Can a normal user grant themselves money or power? Tests the money/tier/role
 * surface from the attacker's OWN authenticated session:
 *   - self-credit:   POST /api/billing/credits to mint balance without paying.
 *   - self-upgrade:  POST /api/billing/tier to jump to a paid tier for free.
 *   - mass-assign:   POST /api/user/preferences with smuggled `is_admin`,
 *                    `credits`, `tier`, `role` keys to see if any bleed through
 *                    into the user record (a `$guarded = []` / blind-fill bug).
 *
 * Only mutates the throwaway attacker account, so it's safe to run by default.
 * Each check reads state before and after so a "200 OK" that didn't actually
 * change anything is correctly recorded as SAFE, not a false positive.
 */
class PrivilegeEscalationProbe extends Probe
{
    public function name(): string
    {
        return 'Privilege Escalation / Mass Assignment';
    }

    public function run(): array
    {
        if (!$this->ctx->accountsReady) {
            return [$this->inconclusive('Privesc suite skipped', 'Attacker account could not be provisioned.')];
        }

        $a = $this->ctx->attacker;
        $findings = [];

        // ---- self-credit ----
        $before = $this->balance();
        $credit = $a->postJson('/api/billing/credits', ['amount' => 999999]);
        $after  = $this->balance();
        if ($before !== null && $after !== null && $after > $before) {
            $findings[] = $this->vuln(
                'Self-service credit grant (free money)',
                Finding::CRITICAL,
                "Posting to /api/billing/credits raised the attacker's own balance from $before to $after with no payment.",
                'POST /api/billing/credits',
                "balance before=$before, after=$after",
                'Restrict credit grants to admin/webhook context only; never trust a client-supplied amount.'
            );
        } else {
            $findings[] = $this->safe('Self-credit blocked', "POST /api/billing/credits returned HTTP {$credit->status}; balance unchanged ($before → $after).", 'POST /api/billing/credits');
        }

        // ---- self-upgrade tier ----
        $tierBefore = $this->tier();
        $up = $a->postJson('/api/billing/tier', ['tier' => 'premium']);
        $tierAfter = $this->tier();
        if ($up->ok() && $tierBefore !== null && $tierAfter === 'premium' && $tierBefore !== 'premium') {
            $findings[] = $this->vuln(
                'Self-service tier upgrade',
                Finding::HIGH,
                "POST /api/billing/tier moved the attacker from `$tierBefore` to `premium` for free.",
                'POST /api/billing/tier',
                "tier before=$tierBefore, after=$tierAfter",
                'Gate tier changes behind a verified Stripe payment / admin action, not a raw client POST.'
            );
        } else {
            $findings[] = $this->safe('Self-upgrade blocked or gated', "POST /api/billing/tier returned HTTP {$up->status}; tier $tierBefore → " . ($tierAfter ?? 'unknown') . '.', 'POST /api/billing/tier');
        }

        // ---- mass assignment via preferences ----
        $a->postJson('/api/user/preferences', [
            'theme'    => 'dark',
            'is_admin' => true,
            'credits'  => 1000000,
            'tier'     => 'premium',
            'role'     => 'admin',
        ]);
        $check = $a->get('/api/auth-check');
        $body  = strtolower($check->body);
        $bled = false;
        foreach (['"is_admin":true', '"role":"admin"', '"tier":"premium"'] as $marker) {
            if (str_contains($body, $marker)) {
                $bled = true;
                $findings[] = $this->vuln(
                    'Mass assignment smuggled a privileged field',
                    Finding::CRITICAL,
                    "Sending `$marker` to /api/user/preferences appears reflected on the user object — a guarded field was overwritten.",
                    'POST /api/user/preferences',
                    $check->snippet(220),
                    'Whitelist preference keys explicitly; set `$guarded`/`$fillable` so role/credits/tier cannot be mass-assigned.'
                );
            }
        }
        if (!$bled) {
            $findings[] = $this->safe('Mass-assignment fields ignored', 'Smuggled is_admin/role/tier/credits keys did not bleed into the user object.', 'POST /api/user/preferences');
        }

        return $findings;
    }

    private function balance(): ?float
    {
        $resp = $this->ctx->attacker->get('/api/billing/balance');
        $json = $resp->json();
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

    private function tier(): ?string
    {
        $resp = $this->ctx->attacker->get('/api/auth-check');
        $json = $resp->json();
        if (is_array($json) && isset($json['user']) && is_array($json['user'])) {
            return $json['user']['tier'] ?? $json['user']['plan'] ?? null;
        }
        return null;
    }
}
