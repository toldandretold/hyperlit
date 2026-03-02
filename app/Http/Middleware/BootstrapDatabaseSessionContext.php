<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;


class BootstrapDatabaseSessionContext
{
    /**
     * Set app.session_id BEFORE StartSession reads the sessions table.
     *
     * The sessions table has an RLS policy that requires app.session_id to match.
     * This middleware must run before StartSession so the policy allows the read.
     *
     * We read the session cookie directly (before EncryptCookies runs) and
     * decrypt it manually using the app key.
     */
    public function handle(Request $request, Closure $next): Response
    {
        $cookieName = config('session.cookie', 'laravel_session');
        $rawCookie = $request->cookies->get($cookieName);

        if ($rawCookie) {
            try {
                // Laravel encrypts cookies with serialize=false
                $sessionId = Crypt::decrypt($rawCookie, false);
                $safeSessionId = str_replace(["'", "\0"], ["''", ""], $sessionId);
                DB::statement("SELECT set_config('app.session_id', ?, false)", [$safeSessionId]);
            } catch (DecryptException $e) {
                // Cookie is invalid/tampered - leave app.session_id unset
            } catch (\Exception $e) {
                // DB not available yet or other error - continue without setting
            }
        }

        return $next($request);
    }
}
