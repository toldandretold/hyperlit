<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
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
            // Authenticated user - set username, clear token
            $this->setSessionVariables($user->name, '', $sessionId);
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
     */
    private function setSessionVariables(string $username, string $token, string $sessionId): void
    {
        try {
            // Escape values to prevent SQL injection in the SET commands
            // Using parameterized set_config is safest
            $safeUsername = $this->escapeForPostgres($username);
            $safeToken = $this->escapeForPostgres($token);
            $safeSessionId = $this->escapeForPostgres($sessionId);

            // Set session variables (is_local = false means connection-wide)
            DB::statement("SELECT set_config('app.current_user', ?, false)", [$safeUsername]);
            DB::statement("SELECT set_config('app.current_token', ?, false)", [$safeToken]);
            DB::statement("SELECT set_config('app.session_id', ?, false)", [$safeSessionId]);

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

    /**
     * Escape a value for use in PostgreSQL.
     * Extra safety layer even though we use parameterized queries.
     */
    private function escapeForPostgres(string $value): string
    {
        // Remove any null bytes and escape single quotes
        return str_replace(["'", "\0"], ["''", ""], $value);
    }
}
