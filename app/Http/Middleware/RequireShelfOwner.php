<?php

namespace App\Http\Middleware;

use App\Services\Shelves\ShelfWorkbenchAccess;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The gate for /api/shelf-workbench/{shelf}/… — the workbench tools a SHELF OWNER may run
 * on their own shelf (as opposed to /api/maintainer/…, which is admin-only and gated by
 * `admin`).
 *
 * Passes only when ShelfWorkbenchAccess says this user may curate this shelf; the resolved
 * shelf row rides on the request (`workbenchShelf`) so a controller never re-resolves it —
 * and so can never resolve a DIFFERENT shelf than the one that was authorised.
 *
 * Refusal is 404, not 403: whether a shelf exists, is public, or belongs to someone else is
 * not this caller's business. (Guests are stopped earlier, by auth:sanctum, with a 401.)
 */
class RequireShelfOwner
{
    public function __construct(private ShelfWorkbenchAccess $access) {}

    public function handle(Request $request, Closure $next): Response
    {
        $shelf = $this->access->curatableShelf((string) $request->route('shelf'), $request->user());
        if (! $shelf) {
            abort(404, 'Shelf not found.');
        }

        $request->attributes->set('workbenchShelf', $shelf);

        return $next($request);
    }
}
