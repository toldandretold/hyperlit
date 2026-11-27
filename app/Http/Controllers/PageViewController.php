<?php

namespace App\Http\Controllers;

use App\Support\AnonToken;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Page-view telemetry for the non-reader surfaces.
 *
 * One page_views row = one (page, reader identity, day) = one "view" — the
 * same unit book_reads uses, so the homepage number on /maintainer/stats is
 * comparable with the corpus reading numbers rather than being raw hits.
 *
 * There is no payload beyond the page name: a page view has no chunks and no
 * depth, so the write is a plain idempotent insert (repeat visits the same day
 * are DO NOTHING) rather than book_reads' merge-and-union upsert.
 */
class PageViewController extends Controller
{
    /**
     * Pages we are willing to count. A whitelist, not an enum column — adding
     * 'user'/'journal' later is a one-line change here, no migration.
     */
    public const PAGES = ['home'];

    /**
     * A shelf view: someone opened that shelf's feed (an archive / journal
     * page, or a shelf tab on a user page). Keyed by the shelf UUID — the
     * feed's render id (`shelf_{uuid}_{sort}[_pub]`) changes with sort and
     * audience, the uuid doesn't. See StatTotals::shelfPageKey.
     */
    private const SHELF_PAGE_RE = '/^shelf:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';

    public function record(Request $request): JsonResponse
    {
        $page = strtolower((string) $request->input('page', ''));
        if (! in_array($page, self::PAGES, true) && ! $this->isKnownShelfPage($page)) {
            return response()->json(['error' => 'Unknown page'], 422);
        }

        $user = Auth::user();
        $anonymousToken = AnonToken::fromRequest($request);
        if (! $user && ! $anonymousToken) {
            // Same contract as reading telemetry: no identity, no dedup key,
            // so counting it would inflate views with unmergeable rows.
            return response()->json(['error' => 'No user identity'], 401);
        }

        // Per-branch ON CONFLICT: each identity fork targets ITS OWN unique
        // index, because Postgres NULLs are distinct and a single statement
        // can't name both.
        $identityColumn = $user ? 'user_name' : 'anon_token';
        $identityValue = $user ? $user->name : $anonymousToken;

        try {
            DB::statement(
                "INSERT INTO page_views (page, {$identityColumn}, view_date, created_at, updated_at)
                 VALUES (?, ?, CURRENT_DATE, NOW(), NOW())
                 ON CONFLICT (page, {$identityColumn}, view_date) DO NOTHING",
                [$page, $identityValue]
            );

            return response()->json(['success' => true]);
        } catch (\Throwable $e) {
            // Telemetry must never break the page it is measuring.
            Log::warning('Page-view record failed (non-fatal)', [
                'page' => $page,
                'error' => $e->getMessage(),
            ]);

            return response()->json(['success' => false], 200);
        }
    }

    private function isKnownShelfPage(string $page): bool
    {
        if (! preg_match(self::SHELF_PAGE_RE, $page)) {
            return false;
        }

        // pgsql_admin: the default connection's RLS would hide a private
        // shelf from everyone but its owner, and the owner's views count too.
        return DB::connection('pgsql_admin')->table('shelves')
            ->where('id', substr($page, strlen('shelf:')))
            ->exists();
    }
}
