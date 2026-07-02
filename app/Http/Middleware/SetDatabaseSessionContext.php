<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

class SetDatabaseSessionContext
{
    /**
     * Set PostgreSQL session variables for Row Level Security policies.
     *
     * This middleware runs before any database queries and sets:
     * - app.current_user: Username for authenticated users
     * - app.current_token: UUID token for anonymous users
     * - app.session_id: Laravel session ID (for sessions table protection)
     *
     * These values are used by RLS policies to filter data access.
     */
    public function handle(Request $request, Closure $next): Response
    {
        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        // Safely get session ID - may not be available for all routes
        $sessionId = '';
        try {
            if ($request->hasSession()) {
                $sessionId = $request->session()->getId() ?? '';
            }
        } catch (\Exception $e) {
            // Session not available - that's OK for some routes
        }

        if ($user) {
            // Authenticated user - set username AND user_token for RLS
            // Fetch user_token via admin connection (not exposed via SQL functions)
            // This protects user_token from SQL injection attacks.
            // Cached 5 min: user_token is written ONLY at user creation
            // (User::creating / AuthController::register), never rotated — if
            // rotation is ever added, invalidate this key there.
            $userToken = Cache::remember(
                "user_token:{$user->id}",
                300,
                fn () => DB::connection('pgsql_admin')
                    ->table('users')
                    ->where('id', $user->id)
                    ->value('user_token') ?? ''
            );
            $this->setSessionVariables($user->name, $userToken, $sessionId);
        } elseif ($anonymousToken) {
            // Anonymous user with token - set token, clear username
            $this->setSessionVariables('', $anonymousToken, $sessionId);
        } else {
            // No authentication - set empty values
            // RLS will block protected operations, allow public reads
            $this->setSessionVariables('', '', $sessionId);
        }

        return $next($request);
    }

    /**
     * Set the PostgreSQL session variables.
     *
     * Uses set_config() with is_local=false to persist for the entire session/connection.
     * One statement, not three — this runs on EVERY /api/* request, so each
     * saved round-trip is pure request-latency win.
     */
    private function setSessionVariables(string $username, string $token, string $sessionId): void
    {
        try {
            // Values are passed as parameterized placeholders — PDO handles escaping
            DB::statement(
                "SELECT set_config('app.current_user', ?, false), set_config('app.current_token', ?, false), set_config('app.session_id', ?, false)",
                [$username, $token, $sessionId]
            );

        } catch (\Exception $e) {
            Log::error('Failed to set RLS session context', [
                'error' => $e->getMessage(),
                'has_user' => !empty($username),
                'has_token' => !empty($token),
            ]);
            // Don't throw - allow request to continue
            // RLS will block unauthorized access anyway
        }
    }
}
