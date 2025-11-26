<?php
 
namespace App\Http\Middleware;

use Closure;
use Illuminate\Support\Facades\Auth;
use App\Models\AnonymousSession;

class RequireAuthor
{
    public function handle($request, Closure $next)
    {
        // If logged in → OK
        if (Auth::check()) {
            return $next($request);
        }

        // Check for valid anonymous session
        $anonymousToken = $request->cookie('anon_token');
        
        if ($anonymousToken && $this->isValidAnonymousToken($anonymousToken)) {
            // Only update usage periodically to reduce DB load
            $this->updateTokenUsageIfNeeded($anonymousToken);
            return $next($request);
        }

        return response()->json(['error' => 'Unauthenticated'], 401);
    }

    private function isValidAnonymousToken($token)
    {
        // Anonymous sessions valid for 90 days (reduced from 365 for security)
        return AnonymousSession::where('token', $token)
            ->where('created_at', '>', now()->subDays(90))
            ->exists();
    }

    private function updateTokenUsageIfNeeded($token)
    {
        // Only update if last_used_at is more than 1 hour old
        AnonymousSession::where('token', $token)
            ->where('last_used_at', '<', now()->subHour())
            ->update(['last_used_at' => now()]);
    }
}