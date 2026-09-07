<?php

namespace App\Support;

use Illuminate\Http\Request;

/**
 * Reads the `anon_token` cookie tolerantly of BOTH forms it exists in.
 *
 * The mint (POST /api/anonymous-session) runs in the `api` middleware group,
 * which has no EncryptCookies outside Sanctum's stateful stack — so a client
 * on a STATEFUL host (hyperlit.test, hyperlit.io) receives the cookie
 * ENCRYPTED, while a client on any other host (LAN-IP phone dev) receives it
 * RAW. Web routes always run EncryptCookies inbound, which nulls a cookie it
 * can't decrypt — that made every RLS-gated media/audio request from a
 * raw-cookie client 404 (the 2026-09 iPhone image bug).
 *
 * Decrypted value wins; otherwise fall back to the raw transport value, but
 * only when it has the token's UUID shape (an encrypted blob or tampered
 * value never matches). No security change either way: the token itself is
 * the bearer secret — encryption of a random capability token was transport
 * dressing, not a trust boundary.
 */
class AnonToken
{
    public static function fromRequest(Request $request): ?string
    {
        $decrypted = $request->cookie('anon_token');
        if (is_string($decrypted) && $decrypted !== '') {
            return $decrypted;
        }

        // EncryptCookies has already nulled the request's copy; the raw value
        // survives in the PHP cookie superglobal (real requests) — tests can
        // populate it the same way.
        $raw = $_COOKIE['anon_token'] ?? null;
        if (is_string($raw) && preg_match('/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/', $raw)) {
            return $raw;
        }

        return null;
    }
}
