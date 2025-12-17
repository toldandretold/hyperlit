<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use App\Models\AnonymousSession;

class RequireAuthor
{
    /**
     * Maximum IP changes allowed within the tracking window before token is invalidated
     * This helps detect token theft while allowing legitimate IP changes (mobile, VPN)
     */
    private const MAX_IP_CHANGES_PER_DAY = 5;

    public function handle($request, Closure $next)
    {
        // If logged in → OK
        if (Auth::check()) {
            return $next($request);
        }

        // Check for valid anonymous session with IP validation
        $anonymousToken = $request->cookie('anon_token');

        if ($anonymousToken) {
            $validationResult = $this->validateTokenWithIp($anonymousToken, $request->ip());

            if ($validationResult['valid']) {
                return $next($request);
            }

            // Token invalid or suspicious - return specific error
            if ($validationResult['reason'] === 'ip_abuse') {
                Log::warning('🚨 Token invalidated due to excessive IP changes (potential theft)', [
                    'token_prefix' => substr($anonymousToken, 0, 8) . '...',
                    'current_ip' => $request->ip()
                ]);
                return response()->json([
                    'error' => 'Session invalidated for security reasons. Please refresh the page.',
                    'reason' => 'security'
                ], 401);
            }
        }

        return response()->json(['error' => 'Unauthenticated'], 401);
    }

    /**
     * 🔒 SECURITY: Validate token with IP binding
     * - Tracks IP changes to detect potential token theft
     * - Allows legitimate IP changes (mobile users, VPN) up to a threshold
     * - Invalidates token if too many IP changes occur
     */
    private function validateTokenWithIp($token, $currentIp)
    {
        $session = AnonymousSession::where('token', $token)
            ->where('created_at', '>', now()->subDays(90))
            ->first();

        if (!$session) {
            return ['valid' => false, 'reason' => 'not_found'];
        }

        // Check if IP has changed
        $storedIp = $session->ip_address;

        if ($storedIp && $storedIp !== $currentIp) {
            // IP changed - check if this is suspicious
            $ipChangeCount = $session->ip_change_count ?? 0;
            $lastIpChange = $session->last_ip_change_at ?
                \Carbon\Carbon::parse($session->last_ip_change_at) : null;

            // Reset counter if last change was more than 24 hours ago
            if ($lastIpChange && $lastIpChange->lt(now()->subDay())) {
                $ipChangeCount = 0;
            }

            $ipChangeCount++;

            // Too many IP changes = potential token theft
            if ($ipChangeCount > self::MAX_IP_CHANGES_PER_DAY) {
                Log::warning('🚨 Excessive IP changes detected for anonymous token', [
                    'token_prefix' => substr($token, 0, 8) . '...',
                    'ip_change_count' => $ipChangeCount,
                    'previous_ip' => $storedIp,
                    'current_ip' => $currentIp
                ]);
                return ['valid' => false, 'reason' => 'ip_abuse'];
            }

            // Log the IP change for security monitoring
            Log::info('📍 Anonymous token IP changed', [
                'token_prefix' => substr($token, 0, 8) . '...',
                'previous_ip' => $storedIp,
                'current_ip' => $currentIp,
                'ip_change_count' => $ipChangeCount
            ]);

            // Update IP and change tracking
            $session->update([
                'ip_address' => $currentIp,
                'ip_change_count' => $ipChangeCount,
                'last_ip_change_at' => now(),
                'last_used_at' => now()
            ]);
        } else {
            // Same IP - just update last_used_at if needed (throttled)
            if (!$session->last_used_at || $session->last_used_at < now()->subHour()) {
                $session->update(['last_used_at' => now()]);
            }
        }

        return ['valid' => true, 'reason' => null];
    }
}