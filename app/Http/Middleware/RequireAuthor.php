<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Str;

class RequireAuthor
{
    public function handle($request, Closure $next)
    {
        // If logged in → OK
        if (Auth::check()) {
            return $next($request);
        }

        // Otherwise a valid UUID must be present
        $token = $request->input('anonymous_token');
        if ($token && Str::isUuid($token)) {
            return $next($request);
        }

        return response()->json(['error' => 'Unauthenticated'], 401);
    }
}