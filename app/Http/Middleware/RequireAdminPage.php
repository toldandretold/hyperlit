<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The PAGE-side admin gate: guests and non-admins get a 404, so operator pages
 * are not advertised (the API-side twin, RequireAdmin, answers 403).
 *
 * This replaces a per-controller `isAdmin()` check that every new workbench
 * page had to remember — a forgotten one was a public page. Applied to the
 * whole /maintainer group in routes/web.php; pinned by
 * tests/Feature/Architecture/MaintainerRoutesAdminOnlyTest.php.
 */
class RequireAdminPage
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }

        return $next($request);
    }
}
